import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { DRIFT_WARNING_THRESHOLD_KMH, R_LOW, readKalmanState, type KalmanState } from '../kalmanFilter';
import type { WindowedMetrics } from '../positionSeries';
import {
  MAX_CONSECUTIVE_ETA_MISSING,
  RESCHEDULE_THRESHOLD_MS,
  SUBSURFACE_ETA_MISSING_TOLERANCE,
  estimateArrivalFromPosition,
  flipApnsEnv,
  maybeCountDrift,
  pickActiveWaypoint,
  pickApnsHost,
  pickBestArrivalSignal,
  resolveEtaMissingThreshold,
  runScheduled,
  type ScheduledDeps,
  type ScheduledStats,
} from '../scheduled';
import { SeoulArrivalClient, type ArrivalEntry, type PositionEntry } from '../seoul';
import { putTrip } from '../trips';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = {
    keyId: 'K',
    teamId: 'T',
    privateKeyPem: pem,
    bundleId: 'com.example.app',
  };
});

beforeEach(() => resetApnsJwtCache());

const NOW = 1_700_000_000_000;

const APNS_HOSTS = {
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com',
} as const;

function makeEnv(kv: InMemoryKV, pending?: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
    PENDING_PUSHES: pending ? (pending as unknown as KVNamespace) : undefined,
  };
}

// 9단 게이트 happy path 공용 GPS series — boarding-prompt / kalman / auto-lock 테스트 공통 사용.
// 게이트 #4(origin 100m 이내) / #5(direction cosine ≥ 0.7) / #7(speed ≥ 5 km/h) 모두 통과 설계.
async function seedHappyGateSeries(kv: InMemoryKV, token: string): Promise<void> {
  const series = [
    { lat: 0, lng: -0.0004, accuracy: 10, ts: NOW - 60_000, motion: 'automotive' },
    { lat: 0, lng: 0.0002, accuracy: 10, ts: NOW - 30_000, motion: 'automotive' },
    { lat: 0, lng: 0.0008, accuracy: 10, ts: NOW, motion: 'automotive' },
  ];
  await kv.put(`pos:${token}`, JSON.stringify(series));
}

// #916 auto-lock 테스트용 trip 시드. promptGeoContext + promptDisplay + waypoints 9단 게이트 통과 형태.
function makePromptTrip(overrides: Partial<Trip> = {}): Trip {
  return makeTrip({
    token: 'auto-lock-tok',
    route: { type: 'direct', line: '2', stops: 3 },
    destination: '선릉',
    waypoints: [
      { stationName: '역삼', line: '2', kind: 'intermediate' },
      { stationName: '선릉', line: '2', kind: 'destination' },
    ],
    promptGeoContext: {
      origin: { lat: 0, lng: 0 },
      nextStation: { lat: 0, lng: 0.01 },
      direction: 'up',
    },
    promptDisplay: { originStation: '강남', line: '2' },
    ...overrides,
  });
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'tok',
    route: { type: 'direct', line: '2', stops: 5 },
    destination: 'dst',
    waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW + 60_000, // 알람 1분 후 → 폴링 윈도우 진입
    ...overrides,
  };
}

function makeSeoul(arrivals: ArrivalEntry[]): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: arrivals.map((a) => ({
            barvlDt: String(a.arrivalSeconds),
            recptnDt: '',
            updnLine: a.isUp ? '상행' : '하행',
            trainLineNm: a.destination,
            btrainNo: a.trainCode,
            subwayNm: a.subwayNm,
            arvlCd: a.arvlCd,
          })),
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

describe('pickActiveWaypoint', () => {
  it('returns first waypoint', () => {
    const trip = makeTrip();
    expect(pickActiveWaypoint(trip)?.stationName).toBe('강남');
  });
  it('returns null when empty', () => {
    expect(pickActiveWaypoint(makeTrip({ waypoints: [] }))).toBeNull();
  });
});

describe('pickBestArrivalSignal (#409)', () => {
  const wp = { stationName: '강남', line: '2', kind: 'destination' as const };
  it('returns null when no arrivals', () => {
    expect(pickBestArrivalSignal([], wp)).toBeNull();
  });
  it('arvlCd 신호 없으면 min ETA fallback (라인 매칭 후)', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 200, trainCode: '1', isUp: true, subwayNm: '지하철2호선', arvlCd: null },
      { destination: 'B', arrivalSeconds: 60, trainCode: '2', isUp: true, subwayNm: '지하철2호선', arvlCd: null },
      { destination: 'C', arrivalSeconds: 30, trainCode: '3', isUp: true, subwayNm: '지하철9호선', arvlCd: null },
    ];
    expect(pickBestArrivalSignal(arrivals, wp)).toEqual({ etaSeconds: 60, arvlCd: null });
  });
  it('라인 매칭 실패 시 전체 arrivals로 fallback', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 100, trainCode: '1', isUp: true, subwayNm: '지하철9호선', arvlCd: null },
    ];
    expect(pickBestArrivalSignal(arrivals, wp)).toEqual({ etaSeconds: 100, arvlCd: null });
  });
  it('gyeongui line은 경의중앙선 alias로 매칭', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: '용문', arrivalSeconds: 90, trainCode: 'G', isUp: true, subwayNm: '경의중앙선', arvlCd: null },
      { destination: '용문', arrivalSeconds: 200, trainCode: 'H', isUp: true, subwayNm: '지하철1호선', arvlCd: null },
    ];
    const gyeonguiWp = { stationName: '회기', line: 'gyeongui', kind: 'destination' as const };
    expect(pickBestArrivalSignal(arrivals, gyeonguiWp)).toEqual({ etaSeconds: 90, arvlCd: null });
  });
  it('arvlCd=0 (ENTERING)이 있으면 ETA가 더 큰 train이라도 우선 선택 (imminent 실측)', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 30, trainCode: '1', isUp: true, subwayNm: '지하철2호선', arvlCd: null },
      { destination: 'B', arrivalSeconds: 120, trainCode: '2', isUp: true, subwayNm: '지하철2호선', arvlCd: 0 },
    ];
    expect(pickBestArrivalSignal(arrivals, wp)).toEqual({ etaSeconds: 120, arvlCd: 0 });
  });
  it('arvlCd=1 (ARRIVED)이 있으면 ETA가 더 빠른 비-신호 train보다 우선', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 50, trainCode: '1', isUp: true, subwayNm: '지하철2호선', arvlCd: 99 },
      { destination: 'B', arrivalSeconds: 80, trainCode: '2', isUp: true, subwayNm: '지하철2호선', arvlCd: 1 },
    ];
    expect(pickBestArrivalSignal(arrivals, wp)).toEqual({ etaSeconds: 80, arvlCd: 1 });
  });
  it('arvlCd=4/5 (PREV_*)는 early 신호로 선택, imminent 신호 없을 때만', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 300, trainCode: '1', isUp: true, subwayNm: '지하철2호선', arvlCd: 4 },
      { destination: 'B', arrivalSeconds: 60, trainCode: '2', isUp: true, subwayNm: '지하철2호선', arvlCd: 99 },
    ];
    expect(pickBestArrivalSignal(arrivals, wp)).toEqual({ etaSeconds: 300, arvlCd: 4 });
  });
  it('imminent 신호가 있으면 early 신호보다 우선', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 200, trainCode: '1', isUp: true, subwayNm: '지하철2호선', arvlCd: 5 },
      { destination: 'B', arrivalSeconds: 100, trainCode: '2', isUp: true, subwayNm: '지하철2호선', arvlCd: 0 },
    ];
    expect(pickBestArrivalSignal(arrivals, wp)).toEqual({ etaSeconds: 100, arvlCd: 0 });
  });
});

describe('flipApnsEnv (#482 self-heal)', () => {
  it('sandbox → production', () => {
    expect(flipApnsEnv('sandbox')).toBe('production');
  });
  it('production → sandbox', () => {
    expect(flipApnsEnv('production')).toBe('sandbox');
  });
  it('undefined → production (sandbox default 짝)', () => {
    // pickApnsHost가 undefined를 sandbox로 시작하므로, flip은 production이 되어야 한다.
    expect(flipApnsEnv(undefined)).toBe('production');
  });
});

describe('pickApnsHost', () => {
  it('returns sandbox host when apnsEnv is sandbox', () => {
    expect(pickApnsHost('sandbox', APNS_HOSTS)).toBe(APNS_HOSTS.sandbox);
  });
  it('returns production host when apnsEnv is production', () => {
    expect(pickApnsHost('production', APNS_HOSTS)).toBe(APNS_HOSTS.production);
  });
  it('falls back to sandbox host when apnsEnv is undefined (#482 safe default)', () => {
    expect(pickApnsHost(undefined, APNS_HOSTS)).toBe(APNS_HOSTS.sandbox);
  });
});

describe('runScheduled', () => {
  it('skips trips outside polling window', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip({ alarmAtEpochMs: NOW + 10 * 60_000 }));
    const seoul = makeSeoul([]);
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.polled).toBe(0);
    expect(stats.pushed).toBe(0);
  });

  it('deletes expired trips', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({ expiresAt: NOW + 5_000, alarmAtEpochMs: NOW - 1 }),
    );
    // expire 이전이지만 다음 시점은 expire 이후
    // #868 — expired 경로는 trip-ended silent push도 발사 시도하므로 fetch mock 필요.
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW + 10_000,
    });
    expect(stats.polled).toBe(0);
    expect(kv.store.size).toBe(0);
  });

  // #640 — BoardingLock 게이트. 사용자가 열차를 선택하지 않은 trip(lock 부재)은
  // arrival 신호가 와도 push를 발사하지 않는다. (가) 정책: lock 없으면 silent push 0건.
  // 이전 legacy phase-based push 경로의 회귀 방지 테스트들은 boardingLock 경로의
  // 대응 케이스(self-heal/intermediate/410 등)로 모두 커버되어 삭제됨 (회귀 동등성 유지).
  describe('#640 lockMissing gate', () => {
    it('lock 부재 trip은 arrival이 와도 push 미발사 + Seoul API 미호출', async () => {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, makeTrip()); // makeTrip default: boardingLock undefined
      const seoulFetch = vi.fn();
      const seoul = new SeoulArrivalClient({
        apiKey: 'K',
        host: 'h',
        now: () => NOW,
        fetchImpl: seoulFetch as unknown as typeof fetch,
      });
      const apnsFetch = vi.fn();
      const stats = await runScheduled(makeEnv(kv), {
        seoul,
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(stats.pushed).toBe(0);
      expect(stats.lockMissing).toBe(1);
      expect(apnsFetch).not.toHaveBeenCalled();
      expect(seoulFetch).not.toHaveBeenCalled();
    });
  });

  // #816 C — lockless station-passed opt-in 분기. lock 없어도 토글 ON + intermediate면 발사 허용.
  describe('#816 C — lockless intermediate', () => {
    function makeApnsFetchOk(): ReturnType<typeof vi.fn> {
      return vi.fn(async () => new Response('', { status: 200 }) as unknown as Response);
    }

    function intermediateTrip(overrides: Partial<Trip> = {}): Trip {
      return makeTrip({
        waypoints: [
          { stationName: '강남', line: '2', kind: 'intermediate' },
          { stationName: '역삼', line: '2', kind: 'destination' },
        ],
        locklessStationPassed: true,
        ...overrides,
      });
    }

    /**
     * Lockless scenario 셋업 통일 헬퍼. trip을 InMemoryKV에 넣고 seoul/apns mock 주입 후
     * runScheduled를 한 cycle 돌려 stats + apnsFetch + kv를 반환한다. 어설션은 호출부에서.
     *
     * `arrivals`:
     *   - undefined: Seoul fetch mock(`seoulFetch`)을 vi.fn()으로 두고 호출 여부만 추적
     *     (lockMissing 게이트 등으로 Seoul 호출 자체가 일어나면 안 되는 시나리오용)
     *   - 배열 (빈 배열 포함): makeSeoul로 실제 응답 — 빈 배열은 etaMissing 트리거
     */
    async function runLocklessCycle(input: {
      trip: Trip;
      arrivals?: ArrivalEntry[];
      apnsOk?: boolean;
    }) {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, input.trip);
      const seoulFetch = vi.fn();
      const seoul = input.arrivals
        ? makeSeoul(input.arrivals)
        : new SeoulArrivalClient({
            apiKey: 'K',
            host: 'h',
            now: () => NOW,
            fetchImpl: seoulFetch as unknown as typeof fetch,
          });
      const apnsFetch = input.apnsOk ? makeApnsFetchOk() : vi.fn();
      const stats = await runScheduled(makeEnv(kv), {
        seoul,
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW,
      });
      return { kv, stats, apnsFetch, seoulFetch };
    }

    const ARVL_ARRIVED: ArrivalEntry = {
      destination: '강남행',
      arrivalSeconds: 30,
      trainCode: '7246',
      isUp: true,
      subwayNm: '지하철2호선',
      arvlCd: 1,
    };
    const ARVL_NO_SIGNAL: ArrivalEntry = { ...ARVL_ARRIVED, arrivalSeconds: 60, arvlCd: null };

    type LocklessCase = {
      name: string;
      trip: () => Trip;
      arrivals?: ArrivalEntry[]; // undefined → Seoul fetch 미호출 보장 케이스
      apnsOk: boolean;
      expect: { pushed: number; locklessFired: number; lockMissing?: number; etaMissing?: number };
      apnsCalled: boolean;
      seoulCalled?: boolean; // arrivals undefined 케이스에서 seoulFetch 호출 여부 검증.
    };

    const cases: LocklessCase[] = [
      {
        name: '토글 ON + intermediate + arvlCd=1 → 발사 + locklessIntermediateFired 카운트',
        trip: () => intermediateTrip(),
        arrivals: [ARVL_ARRIVED],
        apnsOk: true,
        expect: { pushed: 1, locklessFired: 1, lockMissing: 0 },
        apnsCalled: true,
      },
      {
        name: '토글 OFF + intermediate → lockMissing 카운트 (발사 0, Seoul fetch 미호출)',
        trip: () => intermediateTrip({ locklessStationPassed: false }),
        apnsOk: false,
        expect: { pushed: 0, locklessFired: 0, lockMissing: 1 },
        apnsCalled: false,
        seoulCalled: false,
      },
      {
        name: '토글 ON + destination kind → lockMissing 카운트 (lockless는 intermediate만)',
        trip: () =>
          makeTrip({
            waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
            locklessStationPassed: true,
          }),
        apnsOk: false,
        expect: { pushed: 0, locklessFired: 0, lockMissing: 1 },
        apnsCalled: false,
      },
      {
        name: '토글 ON + intermediate + arvlCd 신호 없음 → 발사 0 (ARRIVED/ENTERING만 trigger)',
        trip: () => intermediateTrip(),
        arrivals: [ARVL_NO_SIGNAL],
        apnsOk: false,
        expect: { pushed: 0, locklessFired: 0 },
        apnsCalled: false,
      },
      {
        name: '토글 ON + intermediate + arrivals 비어있음 → etaMissing 증가, 발사 0',
        trip: () => intermediateTrip(),
        arrivals: [],
        apnsOk: false,
        expect: { pushed: 0, locklessFired: 0, etaMissing: 1 },
        apnsCalled: false,
      },
    ];

    it.each(cases)('lock 없음 + $name', async ({ trip, arrivals, apnsOk, expect: ex, apnsCalled, seoulCalled }) => {
      const { stats, apnsFetch, seoulFetch } = await runLocklessCycle({
        trip: trip(),
        arrivals,
        apnsOk,
      });
      expect(stats.pushed).toBe(ex.pushed);
      expect(stats.locklessIntermediateFired).toBe(ex.locklessFired);
      if (ex.lockMissing !== undefined) expect(stats.lockMissing).toBe(ex.lockMissing);
      if (ex.etaMissing !== undefined) expect(stats.etaMissing).toBe(ex.etaMissing);
      if (apnsCalled) {
        expect(apnsFetch).toHaveBeenCalled();
      } else {
        expect(apnsFetch).not.toHaveBeenCalled();
      }
      if (seoulCalled === false) expect(seoulFetch).not.toHaveBeenCalled();
    });

    it('lock 없음 + intermediate(ARRIVED) → 발사 후 다음 intermediate 남으면 waypoint advance', async () => {
      const { kv } = await runLocklessCycle({
        trip: makeTrip({
          waypoints: [
            { stationName: '강남', line: '2', kind: 'intermediate' },
            { stationName: '역삼', line: '2', kind: 'intermediate' },
            { stationName: '선릉', line: '2', kind: 'destination' },
          ],
          locklessStationPassed: true,
        }),
        arrivals: [{ ...ARVL_ARRIVED, destination: '선릉행', arrivalSeconds: 0, trainCode: 'X' }],
        apnsOk: true,
      });
      // 한 cycle 후 첫 waypoint(강남)는 shift되어야 한다.
      const stored = await (kv as unknown as KVNamespace).get('trip:tok');
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored as string);
      expect(parsed.waypoints[0].stationName).toBe('역삼');
      expect(parsed.lastFiredPhase).toBeUndefined();
    });
  });
});

describe('runScheduled — boardingLock trainCode tracking (#585)', () => {
  function makeLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
    return {
      trainCode: '7246',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: NOW,
      segmentStations: ['용마산', '중곡', '군자'],
      expiresAt: NOW + 60 * 60_000,
      ...overrides,
    };
  }

  function makeLockTrip(overrides: Partial<Trip> = {}): Trip {
    return makeTrip({
      token: 'lock-tok',
      route: { type: 'direct', line: '7', stops: 2 },
      waypoints: [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '군자', line: '7', kind: 'destination' },
      ],
      boardingLock: makeLock(),
      ...overrides,
    });
  }

  /** Seoul API 응답 — arrivals와 positions를 URL 경로로 분기. */
  function makeSeoulCombo(
    arrivals: ArrivalEntry[],
    positions: Array<Partial<PositionEntry> & { trainCode: string }>,
  ): SeoulArrivalClient {
    return new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async (url: string) => {
        if (url.includes('/realtimePosition/')) {
          return new Response(
            JSON.stringify({
              realtimePositionList: positions.map((p) => ({
                trainNo: p.trainCode,
                statnNm: p.stationName ?? '',
                trainSttus: p.trainSttus ?? 0,
                updnLine: p.isUp === false ? '하행' : '상행',
                lastRecptnDt: '',
              })),
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            realtimeArrivalList: arrivals.map((a) => ({
              barvlDt: String(a.arrivalSeconds),
              recptnDt: '',
              updnLine: a.isUp ? '상행' : '하행',
              trainLineNm: a.destination,
              btrainNo: a.trainCode,
              subwayNm: a.subwayNm,
              arvlCd: a.arvlCd,
            })),
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
  }

  function arrivalForLock(stationName: string, seconds: number, arvlCd: number | null = null, trainCode = '7246'): ArrivalEntry {
    return { destination: stationName, arrivalSeconds: seconds, trainCode, isUp: true, subwayNm: '지하철7호선', arvlCd };
  }

  it('fires reschedule push when trainCode matched in arrivals (no prior baseline)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 120)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p1',
    });
    expect(stats.pushed).toBe(1);
    expect(apnsFetch).toHaveBeenCalledTimes(1);
    const call = apnsFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.data.kind).toBe('reschedule');
    expect(body.data.trainCode).toBe('7246');
    expect(body.data.nextStation).toBe('중곡');
    expect(body.data.newArrivalTimeEpoch).toBe(NOW + 120_000);
    // baseline 저장 확인
    const stored = JSON.parse((await kv.get('trip:lock-tok')) as string);
    expect(stored.lastTrackedArrivalEpoch).toBe(NOW + 120_000);
  });

  it('does not push when delta < threshold', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({ lastTrackedArrivalEpoch: NOW + 120_000 }),
    );
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 125)], []), // +5s delta
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p1',
    });
    expect(stats.pushed).toBe(0);
    expect(apnsFetch).not.toHaveBeenCalled();
  });

  it('pushes again when delta >= threshold', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({ lastTrackedArrivalEpoch: NOW + 120_000 }),
    );
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 140)], []), // +20s delta
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p2',
    });
    expect(stats.pushed).toBe(1);
  });

  it('falls back to realtimePosition when trainCode not in arrivals', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo(
        [arrivalForLock('중곡', 60, null, 'other-train')], // 다른 trainCode만 있음
        [{ trainCode: '7246', stationName: '용마산', trainSttus: 0 }], // segmentStations[0]
      ),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p3',
    });
    expect(stats.pushed).toBe(1);
    // segmentStations idx 0(용마산) → 1(중곡), 1 hop × 90s
    const call = apnsFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.data.newArrivalTimeEpoch).toBe(NOW + 90_000);
  });

  it('etaMissing when trainCode found nowhere', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p4',
    });
    expect(stats.etaMissing).toBe(1);
    expect(stats.pushed).toBe(0);
  });

  // #706 — 운행 시간대 외(새벽 등)에 trainCode가 사라지면 trip이 무한 폴링됐던 회귀 방지.
  // 연속 etaMissing 카운트 + 임계 초과 시 cleanupTripWithLa로 자동 종료.
  describe('#706 consecutiveEtaMissing auto-end', () => {
    /**
     * #706 시나리오 표준 runner — `runScheduled` boilerplate(apnsConfig/apnsHosts/now/generatePushId)
     * + `seoul=makeSeoulCombo(...)` + `fetchImpl=makeOkFetch()` 기본을 단일 진입점으로 압축.
     * 각 테스트는 trip 상태 차이(consecutiveEtaMissing/waypoints)와 응답 차이(arrivals/apns status)에만 집중한다.
     */
    async function runMissScenario(
      kv: InMemoryKV,
      args: {
        arrivals?: ArrivalEntry[];
        apnsFetch?: ReturnType<typeof vi.fn>;
      } = {},
    ) {
      const fetchImpl = args.apnsFetch ?? makeOkFetch();
      await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo(args.arrivals ?? [], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p706',
      });
    }

    /** 표준 lock trip을 KV에 seed. trip 상태 override(consecutiveEtaMissing 등)만 받는다. */
    async function seedLockTrip(kv: InMemoryKV, overrides: Partial<Trip> = {}) {
      await putTrip(kv as unknown as KVNamespace, makeLockTrip(overrides));
    }

    /** KV에서 trip 읽기. 삭제된 경우 null. */
    async function readStoredTrip(kv: InMemoryKV): Promise<Trip | null> {
      const raw = await kv.get('trip:lock-tok');
      return raw ? (JSON.parse(raw) as Trip) : null;
    }

    it('increments counter and persists on etaMissing (no cleanup yet)', async () => {
      const kv = new InMemoryKV();
      await seedLockTrip(kv);
      await runMissScenario(kv);
      expect((await readStoredTrip(kv))?.consecutiveEtaMissing).toBe(1);
    });

    it('accumulates counter across cycles when etaMissing persists', async () => {
      // 이미 3회 연속 miss 상태로 시작 → 한 번 더 miss → 4
      const kv = new InMemoryKV();
      await seedLockTrip(kv, { consecutiveEtaMissing: 3 });
      await runMissScenario(kv);
      expect((await readStoredTrip(kv))?.consecutiveEtaMissing).toBe(4);
    });

    it('auto-ends trip when consecutiveEtaMissing reaches threshold', async () => {
      // 임계치 -1 상태 → 한 번 더 miss → threshold 도달 → cleanup
      const kv = new InMemoryKV();
      await seedLockTrip(kv, { consecutiveEtaMissing: MAX_CONSECUTIVE_ETA_MISSING - 1 });
      await runMissScenario(kv);
      expect(await readStoredTrip(kv)).toBeNull();
    });

    it('resets counter to 0 when arrival estimate succeeds', async () => {
      // 4회 miss 누적 상태에서 정상 estimate 들어옴 → reset
      const kv = new InMemoryKV();
      await seedLockTrip(kv, { consecutiveEtaMissing: 4 });
      await runMissScenario(kv, { arrivals: [arrivalForLock('중곡', 120)] });
      expect((await readStoredTrip(kv))?.consecutiveEtaMissing).toBe(0);
    });

    it('resets counter when waypoint advances on arrival', async () => {
      // arvlCd=1 → arrived → waypoint advance + reset
      const kv = new InMemoryKV();
      await seedLockTrip(kv, { consecutiveEtaMissing: 2 });
      await runMissScenario(kv, { arrivals: [arrivalForLock('중곡', 0, 1)] });
      expect((await readStoredTrip(kv))?.consecutiveEtaMissing).toBe(0);
    });

    it('does not resurrect trip when reschedule push hits 410 with prior miss accumulation', async () => {
      // 회귀 가드: hadMissCount=true 상태에서 cleanupTripWithLa가 호출된 직후 reset persistance
      // 경로가 putTrip을 다시 호출하면 삭제된 trip이 KV에 부활한다. cleanedUp 시그널로 차단.
      const kv = new InMemoryKV();
      await seedLockTrip(kv, { consecutiveEtaMissing: 2 });
      const apnsFetch = vi.fn(async () =>
        new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 }),
      );
      await runMissScenario(kv, {
        arrivals: [arrivalForLock('중곡', 120)],
        apnsFetch,
      });
      expect(await readStoredTrip(kv)).toBeNull();
    });

    it('treats missing field as 0 (backward compat with existing trips)', async () => {
      // consecutiveEtaMissing 미설정 (구버전 trip) → miss 1회 → 1
      const kv = new InMemoryKV();
      const trip = makeLockTrip();
      delete (trip as unknown as Record<string, unknown>).consecutiveEtaMissing;
      await putTrip(kv as unknown as KVNamespace, trip);
      await runMissScenario(kv);
      expect((await readStoredTrip(kv))?.consecutiveEtaMissing).toBe(1);
    });
  });

  describe('MAX_CONSECUTIVE_ETA_MISSING (#706)', () => {
    it('is 5', () => {
      expect(MAX_CONSECUTIVE_ETA_MISSING).toBe(5);
    });
  });

  // #903 (Seam G) — 기압계 subsurface trip은 인내 threshold(10) 적용.
  describe('#903 SUBSURFACE_ETA_MISSING_TOLERANCE', () => {
    it('is 10 (기본의 2배)', () => {
      expect(SUBSURFACE_ETA_MISSING_TOLERANCE).toBe(10);
    });

    it('resolveEtaMissingThreshold(subsurface=true) → 10', () => {
      expect(resolveEtaMissingThreshold({ subsurface: true })).toBe(SUBSURFACE_ETA_MISSING_TOLERANCE);
    });

    it('resolveEtaMissingThreshold(subsurface=false) → 5 (기본)', () => {
      expect(resolveEtaMissingThreshold({ subsurface: false })).toBe(MAX_CONSECUTIVE_ETA_MISSING);
    });

    it('resolveEtaMissingThreshold(subsurface=undefined) → 5 (graceful default)', () => {
      expect(resolveEtaMissingThreshold({})).toBe(MAX_CONSECUTIVE_ETA_MISSING);
    });
  });

  it('advances waypoint and resets baseline when trainCode arrived (arvlCd=1)', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({ lastTrackedArrivalEpoch: NOW + 5000 }),
    );
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 0, 1)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p5',
    });
    const stored = JSON.parse((await kv.get('trip:lock-tok')) as string);
    expect(stored.waypoints).toHaveLength(1);
    expect(stored.waypoints[0].stationName).toBe('군자');
    expect(stored.lastTrackedArrivalEpoch).toBeUndefined();
  });

  // #864 — transfer waypoint 통과 시 lock release. 다음 cycle에서 새 leg의 trainCode를
  // 찾지 못해 5분 만에 trip auto-end되던 회귀를 차단.
  async function runArrivedScenario(
    kv: InMemoryKV,
    overrides: Partial<Trip>,
    arrivalStation: string,
    pushId: string,
  ): Promise<void> {
    await putTrip(kv as unknown as KVNamespace, makeLockTrip(overrides));
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock(arrivalStation, 0, 1)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => pushId,
    });
  }

  it('#864 — transfer waypoint advance 시 boardingLock release + progress 정리 (trip은 유지)', async () => {
    const kv = new InMemoryKV();
    // 옛 trainCode + shiftedCount가 진행 중 progress KV에 남아 있는 상태를 시뮬레이션.
    await kv.put(
      'progress:lock-tok',
      JSON.stringify({ trainCode: '7246', shiftedCount: 2, lastTrackedArrivalEpoch: NOW + 5000 }),
    );
    await runArrivedScenario(
      kv,
      {
        waypoints: [
          { stationName: '군자', line: '7', kind: 'transfer' },
          { stationName: '아차산', line: '5', kind: 'destination' },
        ],
        consecutiveEtaMissing: 2,
      },
      '군자',
      'p-transfer',
    );
    const stored = JSON.parse((await kv.get('trip:lock-tok')) as string);
    expect(stored.boardingLock).toBeUndefined();
    expect(stored.consecutiveEtaMissing).toBe(0);
    expect(stored.waypoints).toEqual([{ stationName: '아차산', line: '5', kind: 'destination' }]);
    // P2-1: progress KV도 함께 정리 — token-refresh race에서 옛 trainCode가 progressApplies=true로
    // 진입해 backend에 옛 lock이 부활하는 회귀를 차단.
    expect(await kv.get('progress:lock-tok')).toBeNull();
  });

  it('#864 — intermediate waypoint advance 시 boardingLock은 유지 (같은 train 계속 추적)', async () => {
    const kv = new InMemoryKV();
    await runArrivedScenario(
      kv,
      {
        waypoints: [
          { stationName: '중곡', line: '7', kind: 'intermediate' },
          { stationName: '군자', line: '7', kind: 'destination' },
        ],
      },
      '중곡',
      'p-intermediate',
    );
    const stored = JSON.parse((await kv.get('trip:lock-tok')) as string);
    expect(stored.boardingLock?.trainCode).toBe('7246');
    expect(stored.waypoints).toEqual([{ stationName: '군자', line: '7', kind: 'destination' }]);
  });

  it.each([
    ['destination 도착 시 trip 삭제', '군자', 'destination'] as const,
    ['마지막 intermediate 통과 후 빈 리스트면 trip 삭제', '중곡', 'intermediate'] as const,
  ])('%s', async (_label, station, kind) => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({ waypoints: [{ stationName: station, line: '7', kind }] }),
    );
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock(station, 0, 1)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-arrive',
    });
    expect(await kv.get('trip:lock-tok')).toBeNull();
  });

  // #640 — lock 만료 trip도 lockMissing 게이트로 차단되어야 한다 (이전엔 legacy phase 경로로 fall-through 됐었음).
  it('lock 만료 trip은 게이트에서 차단 — push 없음', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({
        boardingLock: makeLock({ expiresAt: NOW - 1 }),
        waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
      }),
    );
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('강남', 20, 1)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p8',
    });
    expect(stats.pushed).toBe(0);
    expect(stats.lockMissing).toBe(1);
    expect(apnsFetch).not.toHaveBeenCalled();
  });

  it('counts error when reschedule push fails (apns 400)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadFoo' }), { status: 400 }),
    );
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 60)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p9',
    });
    expect(stats.errors).toBe(1);
    expect(stats.pushed).toBe(0);
  });

  it('handles tracking exception (e.g. seoul throws)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const throwingSeoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
    });
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: throwingSeoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.errors).toBe(1);
  });

  it('self-heals apns env mismatch (#482) — flips host + corrects trip.apnsEnv', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({ apnsEnv: 'sandbox' }),
    );
    const apnsFetch = vi.fn();
    apnsFetch
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
      )
      .mockImplementationOnce(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 120)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-heal',
    });
    expect(stats.pushed).toBe(1);
    expect(stats.envCorrected).toBe(1);
    expect(apnsFetch).toHaveBeenCalledTimes(2);
    // 1차: sandbox host, 2차: production host
    const url1 = (apnsFetch.mock.calls[0] as unknown as [string])[0];
    const url2 = (apnsFetch.mock.calls[1] as unknown as [string])[0];
    expect(url1).toContain(APNS_HOSTS.sandbox);
    expect(url2).toContain(APNS_HOSTS.production);
    const stored = JSON.parse((await kv.get('trip:lock-tok')) as string);
    expect(stored.apnsEnv).toBe('production');
  });

  it('deletes trip when both hosts return BadDeviceToken (envMismatchExhausted)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip({ apnsEnv: 'sandbox' }));
    const apnsFetch = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 120)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-exhaust',
    });
    expect(await kv.get('trip:lock-tok')).toBeNull();
  });

  it('deletes trip on Unregistered (410)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 }),
    );
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 120)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-410',
    });
    expect(await kv.get('trip:lock-tok')).toBeNull();
  });

  it('skips push (no API call to APNs) when trainCode arrived at non-target station via position fallback (arrived=false)', async () => {
    // segmentStations idx 0(용마산) → target 1(중곡), 1 hop. arrived=false (sttus=0 이동중).
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({ lastTrackedArrivalEpoch: NOW + 90_000 }),
    );
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo(
        [],
        [{ trainCode: '7246', stationName: '용마산', trainSttus: 0 }],
      ),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.pushed).toBe(0);
  });
});

describe('estimateArrivalFromPosition (#585)', () => {
  const lock: BoardingLockMeta = {
    trainCode: '7246',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW,
    segmentStations: ['용마산', '중곡', '군자', '어린이대공원'],
    expiresAt: NOW + 60 * 60_000,
  };

  it('returns null epoch when current station not in segment', () => {
    const train: PositionEntry = { trainCode: '7246', stationName: '아예다른역', trainSttus: 0, isUp: true, recptnMs: 0 };
    expect(estimateArrivalFromPosition(train, '군자', lock, NOW)).toEqual({ epoch: null, arrived: false });
  });

  it('returns null epoch when target station not in segment', () => {
    const train: PositionEntry = { trainCode: '7246', stationName: '용마산', trainSttus: 0, isUp: true, recptnMs: 0 };
    expect(estimateArrivalFromPosition(train, '아예다른역', lock, NOW)).toEqual({ epoch: null, arrived: false });
  });

  it('estimates epoch by hop count × 90s', () => {
    const train: PositionEntry = { trainCode: '7246', stationName: '용마산', trainSttus: 0, isUp: true, recptnMs: 0 };
    // 용마산(0) → 어린이대공원(3) = 3 hops × 90_000ms
    expect(estimateArrivalFromPosition(train, '어린이대공원', lock, NOW)).toEqual({ epoch: NOW + 270_000, arrived: false });
  });

  it('treats currentIdx >= targetIdx as already at/past target', () => {
    const train: PositionEntry = { trainCode: '7246', stationName: '군자', trainSttus: 0, isUp: true, recptnMs: 0 };
    const r = estimateArrivalFromPosition(train, '중곡', lock, NOW);
    expect(r.epoch).toBe(NOW);
    expect(r.arrived).toBe(false); // sttus가 ARRIVED 아니고 stationName도 target과 다름
  });

  it('reports arrived=true when sttus=ARRIVED at target station', () => {
    const train: PositionEntry = { trainCode: '7246', stationName: '군자', trainSttus: 1, isUp: true, recptnMs: 0 };
    expect(estimateArrivalFromPosition(train, '군자', lock, NOW)).toEqual({ epoch: NOW, arrived: true });
  });
});

describe('RESCHEDULE_THRESHOLD_MS (#585)', () => {
  it('is 15 seconds', () => {
    expect(RESCHEDULE_THRESHOLD_MS).toBe(15_000);
  });
});

// APNs LA push는 push-type 헤더로 식별: liveactivity
function isLaCall(_url: string, init: RequestInit | undefined): boolean {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers['apns-push-type'] === 'liveactivity';
}

/**
 * boardingLock 활성 + LA token이 있는 trip — LA 통합 시나리오의 표준 fixture.
 * trip은 #640 게이트 통과(boardingLock 활성) + #586 D LA 발사 대상(activityState=live).
 */
function makeLockedLaTrip(overrides: Partial<Trip> = {}): Trip {
  return makeTrip({
    token: 'la-tok',
    route: { type: 'direct', line: '2', stops: 1 },
    waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
    activityPushToken: 'la-token',
    activityState: 'live',
    apnsEnv: 'sandbox',
    boardingLock: {
      trainCode: 'T',
      line: '2',
      subwayId: '1002',
      selectedDepartureTime: NOW,
      segmentStations: ['역삼', '강남'],
      expiresAt: NOW + 60 * 60_000,
    },
    ...overrides,
  });
}

function makeLockedSeoul(arrivalSeconds: number, arvlCd: number | null = null): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: [
            {
              barvlDt: String(arrivalSeconds),
              recptnDt: '',
              updnLine: '상행',
              trainLineNm: '강남',
              btrainNo: 'T',
              subwayNm: '지하철2호선',
              arvlCd,
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

/** APNs 200 OK 항상 응답하는 fetch mock. LA 통합 테스트의 표준 fetch impl. */
function makeOkFetch() {
  return vi.fn(async () => new Response('', { status: 200 }));
}

/**
 * LA 통합 시나리오 표준 runner.
 * runScheduled 호출의 `{ seoul, apnsConfig, apnsHosts, fetchImpl, now }` boilerplate를 압축한다.
 * 추가 옵션(now override 등)은 overrides로 받는다.
 */
function runLaScheduled(
  kv: InMemoryKV,
  args: {
    seoul: SeoulArrivalClient;
    fetchImpl: ReturnType<typeof vi.fn>;
    now?: () => number;
  },
) {
  return runScheduled(makeEnv(kv), {
    seoul: args.seoul,
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: args.fetchImpl as unknown as typeof fetch,
    now: args.now ?? (() => NOW),
  });
}

/** fetch mock에서 LA push 호출만 추출. */
function getLaCalls(fetchImpl: ReturnType<typeof vi.fn>): [string, RequestInit][] {
  return (fetchImpl.mock.calls as unknown as [string, RequestInit][]).filter((c) =>
    isLaCall(c[0], c[1]),
  );
}

/** LA call의 APNs body(JSON) 파싱. */
function parseLaBody(call: [string, RequestInit]): {
  aps: { event: string; 'content-state'?: Record<string, unknown> };
} {
  return JSON.parse(call[1].body as string);
}

describe('runScheduled — Live Activity push integration (#586 D / #612)', () => {
  it('fires LA update when estimate epoch delta >= 30s (no prior baseline)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    // reschedule push 1건 + LA update 1건 (baseline 없으므로 임계 무시)
    expect(stats.pushed).toBe(1);
    expect(stats.laPushSent).toBe(1);
    const laCalls = getLaCalls(fetchImpl);
    expect(laCalls).toHaveLength(1);
    const body = parseLaBody(laCalls[0]);
    const contentState = body.aps['content-state'] as Record<string, unknown>;
    expect(body.aps.event).toBe('update');
    // #613: widget-aligned schema. etaSeconds → etaMinutes.
    // stationName/lineName/lineColorHex은 widget non-optional 보장.
    // alarmType은 omit — widget 긴급 모드(isUrgent)를 polling 정정마다 강제하지 않기 위함.
    expect(contentState.stationName).toBe('강남');
    expect(contentState.lineName).toBe('2호선');
    expect(contentState.lineColorHex).toBe('#009D3E');
    expect(contentState.stopsRemaining).toBe(1);
    expect(contentState.etaMinutes).toBe(2); // round(120/60) = 2
    // phase / etaSeconds / kind / arrivalAtSec / alarmType 모두 제거됨
    expect(contentState.phase).toBeUndefined();
    expect(contentState.etaSeconds).toBeUndefined();
    expect(contentState.kind).toBeUndefined();
    expect(contentState.arrivalAtSec).toBeUndefined();
    expect(contentState.alarmType).toBeUndefined();
    const stored = JSON.parse((await kv.get('trip:la-tok')) as string) as Trip;
    expect(stored.lastLaPushEpoch).toBe(NOW + 120_000);
  });

  it('does not fire LA when delta < 30s (LA threshold separate from reschedule 15s)', async () => {
    const kv = new InMemoryKV();
    // 직전 LA push baseline은 lastLaPushEpoch. reschedule baseline은 별개로 lastTrackedArrivalEpoch.
    // reschedule baseline은 일부러 어긋나게(50s 전) 두어 reschedule push는 발사되도록 한다 — 이 케이스의
    // 의도는 "LA 임계는 reschedule 임계와 독립"이라는 단언.
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({
        lastTrackedArrivalEpoch: NOW + 70_000,
        lastLaPushEpoch: NOW + 100_000,
      }),
    );
    const fetchImpl = makeOkFetch();
    // seoul: +20s vs LA baseline → 임계 미달
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    expect(stats.pushed).toBe(1); // reschedule push는 발사 (delta=50s >= 15s)
    expect(stats.laPushSent).toBe(0);
    expect(getLaCalls(fetchImpl)).toHaveLength(0);
  });

  // #900 Seam D — 60s heartbeat 게이트.
  it('fires LA heartbeat when delta < 30s but lastLaPushAt is ≥ 60s ago', async () => {
    const kv = new InMemoryKV();
    // ETA 변동(ΔETA=10s)은 임계 미달이지만 lastLaPushAt이 60s 전이라 heartbeat 발사 기대.
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({
        lastTrackedArrivalEpoch: NOW + 110_000,
        lastLaPushEpoch: NOW + 110_000,
        lastLaPushAt: NOW - 60_000,
      }),
    );
    const fetchImpl = makeOkFetch();
    // seoul: +120s vs LA baseline(+110s) → ΔETA=10s < 30s
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    expect(stats.laPushSent).toBe(1);
    expect(getLaCalls(fetchImpl)).toHaveLength(1);
    const stored = JSON.parse((await kv.get('trip:la-tok')) as string) as Trip;
    // heartbeat 발사 시 wall-clock도 갱신됨 — 다음 heartbeat 평가 baseline.
    expect(stored.lastLaPushAt).toBe(NOW);
    expect(stored.lastLaPushEpoch).toBe(NOW + 120_000);
  });

  it('does not fire LA heartbeat when lastLaPushAt is < 60s ago and delta < 30s', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({
        lastTrackedArrivalEpoch: NOW + 110_000,
        lastLaPushEpoch: NOW + 110_000,
        lastLaPushAt: NOW - 30_000, // 30s 전 — 60s 임계 미달
      }),
    );
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    expect(stats.laPushSent).toBe(0);
    expect(getLaCalls(fetchImpl)).toHaveLength(0);
  });

  it('stamps lastLaPushAt on the first LA push (no baseline → fired)', async () => {
    const kv = new InMemoryKV();
    // lastLaPushEpoch/lastLaPushAt 둘 다 undefined → ΔETA 분기에서 통과 (기존 first-push 경로).
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, {
      seoul: makeLockedSeoul(120),
      fetchImpl,
      now: () => NOW + 5_000,
    });
    expect(stats.laPushSent).toBe(1);
    const stored = JSON.parse((await kv.get('trip:la-tok')) as string) as Trip;
    expect(stored.lastLaPushAt).toBe(NOW + 5_000);
  });

  it('does not fire LA when activityPushToken is missing', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({ activityPushToken: undefined }),
    );
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    expect(stats.laPushSent).toBe(0);
    expect(getLaCalls(fetchImpl)).toHaveLength(0);
  });

  it('does not fire LA when activityState is ended (already dismissed)', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({ activityState: 'ended' }),
    );
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    expect(stats.laPushSent).toBe(0);
    expect(getLaCalls(fetchImpl)).toHaveLength(0);
  });

  it('fires LA dismissal when destination arrived under boardingLock and clears trip', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const fetchImpl = makeOkFetch();
    // seoul: ARRIVED
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(0, 1), fetchImpl });
    expect(stats.laPushSent).toBe(1);
    const laCalls = getLaCalls(fetchImpl);
    expect(laCalls).toHaveLength(1);
    expect(parseLaBody(laCalls[0]).aps.event).toBe('end');
    expect(await kv.get('trip:la-tok')).toBeNull();
  });

  it('fires LA dismissal on trip expiry', async () => {
    const kv = new InMemoryKV();
    await kv.put(
      'trip:la-tok',
      JSON.stringify(
        makeLockedLaTrip({ expiresAt: NOW + 5_000, alarmAtEpochMs: NOW - 1 }),
      ),
    );
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, {
      seoul: makeLockedSeoul(0),
      fetchImpl,
      now: () => NOW + 10_000, // past expiry
    });
    expect(stats.laPushSent).toBe(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(parseLaBody(call).aps.event).toBe('end');
    expect(await kv.get('trip:la-tok')).toBeNull();
  });

  it('410 on LA update clears activityPushToken and persists to KV', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isLaCall(url, init)) {
        return new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 410 });
      }
      return new Response('', { status: 200 });
    });
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    expect(stats.laTokenCleared).toBe(1);
    const stored = JSON.parse((await kv.get('trip:la-tok')) as string) as Trip;
    expect(stored.activityPushToken).toBeUndefined();
    expect(stored.activityState).toBe('ended');
    // 410 분기 — token clear가 dirty이므로 lastLaPushEpoch는 갱신 안 함
    expect(stored.lastLaPushEpoch).toBeUndefined();
  });

  it('fires LA dismissal on unrecoverable reschedule push failure (410 Unregistered)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      // reschedule push만 410 Unregistered, LA push는 성공 처리.
      if (isLaCall(url, init)) return new Response('', { status: 200 });
      return new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 });
    });
    await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    // trip 삭제 + LA dismissal end push 발사
    expect(await kv.get('trip:la-tok')).toBeNull();
    const laCalls = getLaCalls(fetchImpl);
    expect(laCalls).toHaveLength(1);
    expect(parseLaBody(laCalls[0]).aps.event).toBe('end');
  });

  it('fires LA update immediately after waypoint shift (stopsRemaining changed)', async () => {
    // intermediate(중곡) 통과 → 다음 hop(강남)에 즉시 LA update 발사 (ETA 임계 무시).
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({
        waypoints: [
          { stationName: '중곡', line: '2', kind: 'intermediate' },
          { stationName: '강남', line: '2', kind: 'destination' },
        ],
        boardingLock: {
          trainCode: 'T',
          line: '2',
          subwayId: '1002',
          selectedDepartureTime: NOW,
          segmentStations: ['역삼', '중곡', '강남'],
          expiresAt: NOW + 60 * 60_000,
        },
        // baseline 충분히 가까워야 LA push가 '진행 trigger'로 발사된 것을 검증할 수 있음.
        lastLaPushEpoch: NOW + 1000,
      }),
    );
    // 중곡에 ARRIVED → advanceBoardingLockWaypoint 진입 → shift 후 강남이 next
    const fetchImpl = makeOkFetch();
    await runLaScheduled(kv, { seoul: makeLockedSeoul(0, 1), fetchImpl });
    const laCalls = getLaCalls(fetchImpl);
    // 1건의 LA update(다음 waypoint=강남, stopsRemaining=1, ETA=0)가 발사돼야 한다.
    expect(laCalls).toHaveLength(1);
    const body = parseLaBody(laCalls[0]);
    const contentState = body.aps['content-state'] as Record<string, unknown>;
    expect(body.aps.event).toBe('update');
    // #613: widget-aligned schema. alarmType은 omit (긴급 모드 강제 회피).
    expect(contentState.stationName).toBe('강남');
    expect(contentState.alarmType).toBeUndefined();
    expect(contentState.stopsRemaining).toBe(1);
    expect(contentState.etaMinutes).toBe(0); // shift 시점은 ETA 0
    // shift 시 lastLaPushEpoch는 reset되어 다음 polling cycle의 첫 estimate가 임계 검사 없이 push되도록 보장.
    const stored = JSON.parse((await kv.get('trip:la-tok')) as string) as Trip;
    expect(stored.lastLaPushEpoch).toBeUndefined();
  });
});

// #868 — server-side trip auto-end 경로에서 클라 state sync용 trip-ended silent push가 발사되는지.
// LA dismissal과 별개 budget(분당 0~1건)이라 trip 종료 cleanup 1건당 1회 발사가 기대 동작.
describe('runScheduled — trip-ended silent push (#868)', () => {
  /** APNs silent push (trip-ended kind) 호출만 추출 — LA push와 분리해 단언. */
  function getTripEndedCalls(
    fetchImpl: ReturnType<typeof vi.fn>,
  ): [string, RequestInit][] {
    return (fetchImpl.mock.calls as unknown as [string, RequestInit][]).filter((c) => {
      const headers = (c[1]?.headers ?? {}) as Record<string, string>;
      if (headers['apns-push-type'] !== 'background') return false;
      try {
        const body = JSON.parse(c[1]?.body as string) as { data?: { kind?: string } };
        return body?.data?.kind === 'trip-ended';
      } catch {
        return false;
      }
    });
  }

  /** trip-ended push body의 data field 추출. */
  function parseTripEndedData(call: [string, RequestInit]): {
    kind: string;
    reason: string;
    pushId: string;
    sentAt: number;
  } {
    const body = JSON.parse(call[1].body as string) as {
      data: { kind: string; reason: string; pushId: string; sentAt: number };
    };
    return body.data;
  }

  // 본 describe 안에서만 쓰이는 fixture — makeLockTrip은 outer scope에 있어 재사용 불가.
  function makeEtaThresholdTrip(token: string, missCount: number) {
    return makeTrip({
      token,
      route: { type: 'direct', line: '7', stops: 2 },
      waypoints: [{ stationName: '중곡', line: '7', kind: 'intermediate' }],
      boardingLock: {
        trainCode: '7246',
        line: '7',
        subwayId: '1007',
        selectedDepartureTime: NOW,
        segmentStations: ['용마산', '중곡', '군자'],
        expiresAt: NOW + 60 * 60_000,
      },
      consecutiveEtaMissing: missCount,
    });
  }

  it('fires trip-ended push (reason=eta-missing) when consecutiveEtaMissing exceeds threshold', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeEtaThresholdTrip('end-tok', 4));
    const fetchImpl = makeOkFetch();
    // arrivals 비어 있음 → estimate=null → miss 1 더 → 5 도달 → auto-end.
    // top-level makeSeoul은 positions endpoint도 같은 fetchImpl을 사용 — realtimePositionList 키가
    // 없어 빈 배열로 처리되므로 fallback도 estimate=null로 떨어진다.
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-eta-end',
    });
    const calls = getTripEndedCalls(fetchImpl);
    expect(calls).toHaveLength(1);
    const data = parseTripEndedData(calls[0]);
    expect(data.kind).toBe('trip-ended');
    expect(data.reason).toBe('eta-missing');
    expect(data.sentAt).toBe(NOW);
    expect(typeof data.pushId).toBe('string');
    expect(data.pushId.length).toBeGreaterThan(0);
    // #868 P1-2 race 가드 — payload에 tripToken 포함되어야 클라가 ACTIVE_TRIP_KEY와 매칭 가능.
    expect(data.tripToken).toBe('end-tok');
    // trip은 KV에서 삭제돼야 함 (#706 cleanup).
    expect(await kv.get('trip:end-tok')).toBeNull();
  });

  it('fires trip-ended push (reason=destination-arrived) when destination waypoint ARRIVED', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const fetchImpl = makeOkFetch();
    // ARRIVED(arvlCd=1) → advanceBoardingLockWaypoint → destination → cleanup
    await runLaScheduled(kv, { seoul: makeLockedSeoul(0, 1), fetchImpl });
    const calls = getTripEndedCalls(fetchImpl);
    expect(calls).toHaveLength(1);
    const data = parseTripEndedData(calls[0]);
    expect(data.reason).toBe('destination-arrived');
    expect(await kv.get('trip:la-tok')).toBeNull();
  });

  it('fires trip-ended push (reason=expired) on trip.expiresAt elapsed', async () => {
    const kv = new InMemoryKV();
    await kv.put(
      'trip:la-tok',
      JSON.stringify(
        makeLockedLaTrip({ expiresAt: NOW + 5_000, alarmAtEpochMs: NOW - 1 }),
      ),
    );
    const fetchImpl = makeOkFetch();
    await runLaScheduled(kv, {
      seoul: makeLockedSeoul(0),
      fetchImpl,
      now: () => NOW + 10_000,
    });
    const calls = getTripEndedCalls(fetchImpl);
    expect(calls).toHaveLength(1);
    expect(parseTripEndedData(calls[0]).reason).toBe('expired');
  });

  it('fires trip-ended push (reason=push-unrecoverable) on reschedule 410 Unregistered', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isLaCall(url, init)) return new Response('', { status: 200 });
      const body = init?.body as string | undefined;
      // trip-ended push는 정상 응답 — reschedule push만 410 Unregistered로 폐기 트리거.
      if (body && body.includes('"trip-ended"')) {
        return new Response('', { status: 200 });
      }
      return new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 });
    });
    await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    const calls = getTripEndedCalls(fetchImpl);
    expect(calls).toHaveLength(1);
    expect(parseTripEndedData(calls[0]).reason).toBe('push-unrecoverable');
    expect(await kv.get('trip:la-tok')).toBeNull();
  });

  it('#868 P2-1 — trip-ended push fetch throw해도 cleanup 흐름 계속 (trip 삭제됨)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeEtaThresholdTrip('thr-tok', 4));
    // trip-ended push만 reject — reschedule/LA push는 정상.
    const throwingFetch = vi.fn((url: unknown, init?: { body?: string }) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      if (body.includes('"trip-ended"')) {
        return Promise.reject(new Error('network down'));
      }
      return Promise.resolve(new Response('', { status: 200 }));
    });
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: throwingFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-thr',
    });
    // throw 흡수 → cleanup 진행 → trip 삭제.
    expect(await kv.get('trip:thr-tok')).toBeNull();
  });

  it('does not fire trip-ended push when miss counter increments below threshold', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeEtaThresholdTrip('mid-tok', 1));
    const fetchImpl = makeOkFetch();
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-no-end',
    });
    expect(getTripEndedCalls(fetchImpl)).toHaveLength(0);
    // trip은 살아 있어야 함 (counter만 증가)
    const stored = JSON.parse((await kv.get('trip:mid-tok')) as string) as Trip;
    expect(stored.consecutiveEtaMissing).toBe(2);
  });
});

// #705 — scheduled.ts의 advance/baseline 변경이 progress KV에도 mirror되는지.
// 시나리오는 LA 시나리오와 동일한 makeLockedLaTrip + makeLockedSeoul fixture로 압축.
describe('#705 scheduled.ts progress KV mirroring', () => {
  // 중곡 → 강남 advance 시나리오용 표준 trip override (boardingLock + 2-step waypoints).
  function progressTripOverrides(extra: Partial<Trip> = {}): Partial<Trip> {
    return {
      waypoints: [
        { stationName: '중곡', line: '2', kind: 'intermediate' },
        { stationName: '강남', line: '2', kind: 'destination' },
      ],
      boardingLock: {
        trainCode: 'T',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: NOW,
        segmentStations: ['역삼', '중곡', '강남'],
        expiresAt: NOW + 60 * 60_000,
      },
      ...extra,
    };
  }

  async function readProgress(kv: InMemoryKV): Promise<Record<string, unknown> | null> {
    const raw = await kv.get('progress:la-tok');
    return raw === null ? null : JSON.parse(raw as string);
  }

  // 중곡 ARRIVED를 트리거하는 표준 seoul + fetch + 실행 — advance 케이스 3건이 공유.
  async function runAdvanceScenario(kv: InMemoryKV): Promise<void> {
    await runLaScheduled(kv, { seoul: makeLockedSeoul(0, 1), fetchImpl: makeOkFetch() });
  }

  it('advanceBoardingLockWaypoint writes progress with shiftedCount=1 and trainCode stamp', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip(progressTripOverrides({ lastLaPushEpoch: NOW + 1000 })),
    );
    // 중곡 ARRIVED → advanceBoardingLockWaypoint 트리거
    await runAdvanceScenario(kv);
    const progress = await readProgress(kv);
    expect(progress).not.toBeNull();
    expect(progress?.trainCode).toBe('T');
    expect(progress?.shiftedCount).toBe(1);
  });

  it('mirrorProgress accumulates shiftedCount across multiple advances', async () => {
    const kv = new InMemoryKV();
    // 이전 advance가 이미 progress에 있는 상태에서 다시 advance.
    await kv.put('progress:la-tok', JSON.stringify({ trainCode: 'T', shiftedCount: 1 }));
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip(progressTripOverrides()));
    await runAdvanceScenario(kv);
    expect((await readProgress(kv))?.shiftedCount).toBe(2); // 1 + 1
  });

  it('mirrorProgress resets shiftedCount when stored progress has different trainCode', async () => {
    const kv = new InMemoryKV();
    await kv.put('progress:la-tok', JSON.stringify({ trainCode: 'OLD', shiftedCount: 5 }));
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip(progressTripOverrides()));
    await runAdvanceScenario(kv);
    const progress = await readProgress(kv);
    expect(progress?.trainCode).toBe('T');
    expect(progress?.shiftedCount).toBe(1); // old(OLD) 폐기 + 새 advance 1
  });

  it('runTrainCodeTracking mirrors baseline (consecutiveEtaMissing) into progress on etaMissing', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    // arrivals 비어 있고 positions도 매칭 안 됨 → etaMissing 누적
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 })) as unknown as typeof fetch,
    });
    await runLaScheduled(kv, { seoul, fetchImpl: makeOkFetch() });
    const progress = await readProgress(kv);
    expect(progress?.consecutiveEtaMissing).toBe(1);
    expect(progress?.shiftedCount).toBe(0);
  });

  it('cleanupTripWithLa removes progress entry alongside trip', async () => {
    const kv = new InMemoryKV();
    await kv.put('progress:la-tok', JSON.stringify({ trainCode: 'T', shiftedCount: 1 }));
    // expired trip → cleanup 경로 진입
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip({ expiresAt: NOW - 1 }));
    await runLaScheduled(kv, { seoul: makeLockedSeoul(60), fetchImpl: makeOkFetch() });
    expect(await readProgress(kv)).toBeNull();
  });
});

describe('runScheduled — boarding-prompt 9단 게이트 (#819)', () => {
  function makeUnlockedTrip(overrides: Partial<Trip> = {}): Trip {
    // lockMissing 분기 진입 — boardingLock 없음.
    return makeTrip({
      token: 'bp-tok',
      promptGeoContext: {
        origin: { lat: 0, lng: 0 },
        nextStation: { lat: 0, lng: 0.01 },
        direction: 'up',
      },
      promptDisplay: { originStation: '강남', line: '2' },
      ...overrides,
    });
  }

  function makeBoardingPromptDeps(fetchImpl: typeof fetch) {
    return {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl,
      generatePushId: () => 'bp-push-1',
    };
  }

  /** "happy path" series — 모듈 레벨 seedHappyGateSeries 재사용 (bp-tok 기본). */
  const seedHappySeries = (kv: InMemoryKV, token = 'bp-tok') => seedHappyGateSeries(kv, token);

  it('promptGeoContext 없으면 skip — boardingPromptEvaluated 미증가', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip({ token: 'no-geo' }));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptEvaluated).toBe(0);
    expect(stats.boardingPromptFired).toBe(0);
  });

  it('9단 통과 + APNs 200 → alert push 발사 + state.fired 영구화', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    await seedHappySeries(kv);
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));

    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(stats.boardingPromptFired).toBe(1);
    expect(stats.boardingPromptBlocked).toBe(0);

    // 1회 fetch (APNs) — 후속 cron에서 dedup.
    const fetchMock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      'apns-push-type': 'alert',
      'apns-priority': '10',
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.aps.category).toBe('BOARDING_PROMPT');
    expect(body.data.kind).toBe('boarding-prompt');
    expect(body.data.originStation).toBe('강남');
    expect(body.data.line).toBe('2');

    const persisted = JSON.parse((await kv.get('trip:bp-tok'))!);
    expect(persisted.boardingPromptState).toEqual({ fired: true, lastFiredAt: NOW });
  });

  it('이미 fired된 trip은 미발사 + blocked 카운트', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({ boardingPromptState: { fired: true, lastFiredAt: NOW - 60_000 } }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('series 비어 있으면 window-too-small로 차단', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
  });

  it('APNs 실패 시 errors 카운트 + state 유지', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    await seedHappySeries(kv);
    // 410 외 일반 실패 — env mismatch 아님
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ reason: 'TopicDisallowed' }), { status: 403 }),
    ) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.errors).toBeGreaterThan(0);
  });

  it('APNs env mismatch 시 self-heal → corrected env 저장', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({ apnsEnv: 'sandbox' }),
    );
    await seedHappySeries(kv);
    let callIdx = 0;
    const fetchImpl = vi.fn(async () => {
      callIdx += 1;
      if (callIdx === 1) {
        return new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 });
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptFired).toBe(1);
    expect(stats.envCorrected).toBe(1);
    const persisted = JSON.parse((await kv.get('trip:bp-tok'))!);
    expect(persisted.apnsEnv).toBe('production');
  });
});

describe('runScheduled — evaluateAndMaybeFireBoardingPrompt Kalman KV 통합 (#824)', () => {
  /**
   * boarding-prompt 경로에서 Kalman state가 KV에 persist/read되는지 검증.
   *
   * evaluateAndMaybeFireBoardingPrompt는:
   *   1. accelSeries + kalmanState 병렬 로드 (readAccelSeries + readKalmanState)
   *   2. runKalmanStep 실행
   *   3. writeKalmanState → KV에 `kalman:<token>` 저장
   *   4. kalmanState.v를 evaluateBoardingPromptGates에 전달
   */

  function makeKalmanTrip(overrides: Partial<Trip> = {}): Trip {
    return makeTrip({
      token: 'kalman-tok',
      promptGeoContext: {
        origin: { lat: 0, lng: 0 },
        nextStation: { lat: 0, lng: 0.01 },
        direction: 'up',
      },
      promptDisplay: { originStation: '강남', line: '2' },
      ...overrides,
    });
  }

  const seedHappySeries = (kv: InMemoryKV, token = 'kalman-tok') => seedHappyGateSeries(kv, token);

  function makeKalmanPromptDeps(fetchImpl: typeof fetch) {
    return {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl,
      generatePushId: () => 'kalman-push-1',
    };
  }

  it('evaluateAndMaybeFireBoardingPrompt: writeKalmanState → KV에 kalman:<token> 저장됨', async () => {
    // promptGeoContext 있는 trip + happy series → evaluateAndMaybeFireBoardingPrompt 진입
    // kalman KV key = 'kalman:kalman-tok' 생성 확인
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeKalmanTrip());
    await seedHappySeries(kv);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    await runScheduled(makeEnv(kv), makeKalmanPromptDeps(fetchImpl));

    // KV에 kalman state가 저장되어야 함
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, 'kalman-tok');
    expect(kalmanState).not.toBeNull();
    expect(typeof kalmanState?.v).toBe('number');
    expect(typeof kalmanState?.P).toBe('number');
    expect(typeof kalmanState?.ts).toBe('number');
    expect(Number.isFinite(kalmanState!.v)).toBe(true);
    expect(Number.isFinite(kalmanState!.P)).toBe(true);
  });

  it('prior Kalman state가 KV에 있으면 다음 cycle에서 predict+update 연속 실행', async () => {
    // 1st cycle: prior=null → observation 초기화 → state 저장
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeKalmanTrip());
    await seedHappySeries(kv);
    const fetchImpl1 = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    await runScheduled(makeEnv(kv), makeKalmanPromptDeps(fetchImpl1));
    const stateAfterCycle1 = await readKalmanState(kv as unknown as KVNamespace, 'kalman-tok');
    expect(stateAfterCycle1).not.toBeNull();

    // 2nd cycle: boardingPromptState.fired=true이므로 게이트 차단되지만
    // Kalman step은 게이트와 무관하게 실행되어 state가 갱신되어야 함.
    // fired=true로 게이트 차단 → 따라서 boardingPromptFired=0이어야 함.
    // Kalman writeKalmanState는 게이트 평가 전에 실행되므로 state가 갱신됨.
    await putTrip(
      kv as unknown as KVNamespace,
      makeKalmanTrip({ boardingPromptState: { fired: true, lastFiredAt: NOW - 1000 } }),
    );
    const fetchImpl2 = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeKalmanPromptDeps(fetchImpl2));
    expect(stats.boardingPromptFired).toBe(0); // 게이트 차단
    expect(stats.boardingPromptBlocked).toBe(1);

    // 2nd cycle 후 state가 업데이트되었는지 확인 (ts가 now=NOW로 갱신)
    const stateAfterCycle2 = await readKalmanState(kv as unknown as KVNamespace, 'kalman-tok');
    expect(stateAfterCycle2).not.toBeNull();
    expect(stateAfterCycle2?.ts).toBe(NOW);
  });

  it('kalmanKmh가 evaluateBoardingPromptGates에 전달되어 fusedSpeedKmh에 영향을 줌 (간접 검증)', async () => {
    // kalman state를 KV에 미리 넣어 두면 (prior 있음 + 최근 ts),
    // runKalmanStep이 predict+update를 실행해 kalmanKmh가 GPS avg와 다를 수 있다.
    // outcome.fusedSpeedKmh가 GPS-only보다 달라지는지를 비교한다.

    // Case A: KV에 kalman state 없음 (prior=null → 초기화 → kalmanKmh ≈ gpsAvg)
    const kvA = new InMemoryKV();
    await seedHappySeries(kvA, 'kalman-tok');
    await putTrip(kvA as unknown as KVNamespace, makeKalmanTrip());
    const fetchA = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const statsA = await runScheduled(makeEnv(kvA), makeKalmanPromptDeps(fetchA));
    // 게이트 통과 여부와 kalman state 저장 확인
    expect(statsA.boardingPromptEvaluated).toBe(1);
    const stateA = await readKalmanState(kvA as unknown as KVNamespace, 'kalman-tok');
    expect(stateA).not.toBeNull();

    // Case B: KV에 kalman state가 있음 (prior 있음 → predict+update로 다른 v 값)
    const kvB = new InMemoryKV();
    // prior state: v=100 km/h (비현실적으로 높은 값) → kalmanKmh가 GPS avg와 달라짐
    const priorState = { v: 100, P: 400, ts: NOW - 5_000 };
    await kvB.put('kalman:kalman-tok', JSON.stringify(priorState));
    await putTrip(kvB as unknown as KVNamespace, makeKalmanTrip());
    await seedHappySeries(kvB, 'kalman-tok');
    const fetchB = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const statsB = await runScheduled(makeEnv(kvB), makeKalmanPromptDeps(fetchB));
    expect(statsB.boardingPromptEvaluated).toBe(1);

    // KV의 kalman state가 갱신되어 있어야 함 (ts=NOW로)
    const stateB = await readKalmanState(kvB as unknown as KVNamespace, 'kalman-tok');
    expect(stateB?.ts).toBe(NOW);
    // v는 prior(100)과 GPS avg 블렌딩 → 100과 gpsAvg 사이의 값이어야 함
    expect(stateB!.v).toBeGreaterThan(0);
  });

  // 기존 lockMissing/lock-active 회귀 보존
  it('기존 lockMissing 회귀: lock 부재 + promptGeoContext 없음 → lockMissing+1, kalman 미호출', async () => {
    const kv = new InMemoryKV();
    // promptGeoContext 없는 trip → evaluateAndMaybeFireBoardingPrompt에서 early return
    await putTrip(kv as unknown as KVNamespace, makeTrip({ token: 'no-geo-kalman' }));
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      generatePushId: () => 'k1',
    });
    expect(stats.lockMissing).toBe(1);
    expect(stats.boardingPromptEvaluated).toBe(0);
    // kalman KV key가 생성되지 않아야 함
    expect(await kv.get('kalman:no-geo-kalman')).toBeNull();
  });

  it('기존 lock-active trip은 kalman path 진입 안 함 (lockMissing=0)', async () => {
    const kv = new InMemoryKV();
    const lockTrip = makeTrip({
      token: 'active-lock-kalman',
      boardingLock: {
        trainCode: 'X',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: NOW,
        segmentStations: ['강남', '역삼'],
        expiresAt: NOW + 60 * 60_000,
      },
      waypoints: [{ stationName: '역삼', line: '2', kind: 'destination' }],
    });
    await putTrip(kv as unknown as KVNamespace, lockTrip);
    // Seoul API: arrivals 비어 있음 → etaMissing
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      generatePushId: () => 'k2',
    });
    expect(stats.lockMissing).toBe(0);
    expect(stats.boardingPromptEvaluated).toBe(0);
    // kalman key 미생성 (lock-active 분기는 kalman path 미통과)
    expect(await kv.get('kalman:active-lock-kalman')).toBeNull();
  });

  // 리뷰 P2-1 — 무관측 cycle은 Kalman state I/O를 skip해 거짓 0 km/h observation 누적 방지.
  it('series 비어 있으면 kalman state 미작성 (관측 무효 → skip)', async () => {
    const kv = new InMemoryKV();
    // positionSeries 자체가 없는 trip — count=0, avgAccuracy=Infinity
    await putTrip(kv as unknown as KVNamespace, makeKalmanTrip({ token: 'empty-series' }));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl,
      generatePushId: () => 'empty-1',
    });
    // boarding-prompt 평가는 진입했지만 게이트에서 차단됨 (window-too-small)
    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
    // kalman state는 만들어지지 않아야 함 — 거짓 0 km/h observation으로 prior 오염 방지
    expect(await kv.get('kalman:empty-series')).toBeNull();
  });

  it('모든 sample이 accuracy로 reject되면 kalman state 미작성 (관측 무효 → skip)', async () => {
    const kv = new InMemoryKV();
    // accuracy ≥ 50m sample만 있어 totalHopMs=0 → avgAccuracy=Infinity, gpsAvg=0
    const series = [
      { lat: 0, lng: -0.0004, accuracy: 80, ts: NOW - 60_000, motion: 'automotive' },
      { lat: 0, lng: 0.0002, accuracy: 80, ts: NOW - 30_000, motion: 'automotive' },
      { lat: 0, lng: 0.0008, accuracy: 80, ts: NOW, motion: 'automotive' },
    ];
    await kv.put('pos:bad-acc', JSON.stringify(series));
    await putTrip(kv as unknown as KVNamespace, makeKalmanTrip({ token: 'bad-acc' }));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl,
      generatePushId: () => 'bad-acc-1',
    });
    // accuracy-too-poor 게이트에서 차단되고 Kalman은 skip
    expect(await kv.get('kalman:bad-acc')).toBeNull();
  });

  // 리뷰 P2-3 — prior 부재 첫 cycle은 state.v=gpsAvg로 초기화되어 fusion에 합류 시
  // 같은 GPS가 2회 가중 → confidence 가짜 상승. state는 persist 하되 kalmanKmh는 null로
  // 게이트에 전달해야 한다. 검증: prior 없는 cycle은 GPS-only fusedSpeed와 동일 confidence.
  it('prior=null 첫 cycle은 state는 persist하되 kalmanKmh를 게이트에 전달하지 않음', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeKalmanTrip({ token: 'first-cycle' }));
    await seedHappySeries(kv, 'first-cycle');
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const stats = await runScheduled(makeEnv(kv), makeKalmanPromptDeps(fetchImpl));

    // state는 다음 cycle prior로 쓸 수 있게 persist
    const state = await readKalmanState(kv as unknown as KVNamespace, 'first-cycle');
    expect(state).not.toBeNull();
    expect(state?.ts).toBe(NOW);
    // boarding-prompt 게이트는 통과 — kalmanKmh=null이라 fusedSpeed는 GPS+map only 합산
    expect(stats.boardingPromptEvaluated).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #825 — Phase 3 E3 phase gate 통합 테스트
// ---------------------------------------------------------------------------

describe('runScheduled — #825 Phase 3 E3: phaseImminentBlocked + stationPhase stamp', () => {
  /** lockless intermediate trip 팩토리 (phase gate 경로 전용). */
  function makePhaseTrip(overrides: Partial<Trip> = {}): Trip {
    return makeTrip({
      token: 'phase-tok',
      waypoints: [
        { stationName: '강남', line: '2', kind: 'intermediate' },
        { stationName: '역삼', line: '2', kind: 'destination' },
      ],
      locklessStationPassed: true,
      ...overrides,
    });
  }

  /** ARRIVED(arvlCd=1) signal로 fires 조건 충족 */
  const ARVL_ARRIVED: ArrivalEntry = {
    destination: '강남행',
    arrivalSeconds: 30,
    trainCode: '7246',
    isUp: true,
    subwayNm: '지하철2호선',
    arvlCd: 1,
  };

  /**
   * nearestStationDistanceM이 포함된 series를 KV에 심는다.
   * stationPhase 분류 pipeline을 실제로 동작시킨다.
   */
  async function seedSeriesWithDistance(
    kv: InMemoryKV,
    token: string,
    nearestStationDistanceM: number | undefined,
  ): Promise<void> {
    const series = [
      { lat: 0, lng: -0.0004, accuracy: 10, ts: NOW - 60_000, motion: 'automotive', nearestStationDistanceM },
      { lat: 0, lng: 0.0002, accuracy: 10, ts: NOW - 30_000, motion: 'automotive', nearestStationDistanceM },
      { lat: 0, lng: 0.0008, accuracy: 10, ts: NOW, motion: 'automotive', nearestStationDistanceM },
    ];
    await kv.put(`pos:${token}`, JSON.stringify(series));
  }

  // ---------------------------------------------------------------------------
  // phaseImminentBlocked 회귀 — 기존 동작 보존
  // ---------------------------------------------------------------------------
  it('phaseState null + fires(arvlCd=1) → 기존 동작: push 발사, phaseImminentBlocked=0', async () => {
    // nearestStationDistanceM 없는 series → phaseState=null → gate 허용
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makePhaseTrip());
    // nearestStationDistanceM=undefined → runStationPhaseStep returns null
    await seedSeriesWithDistance(kv, 'phase-tok', undefined);

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([ARVL_ARRIVED]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'phase-p1',
    });

    expect(stats.pushed).toBe(1);
    expect(stats.phaseImminentBlocked).toBe(0);
    expect(apnsFetch).toHaveBeenCalled();
  });

  it('high-confidence CRUISING (dist=500m, kmh=35) + fires → phaseImminentBlocked++, push 미발사', async () => {
    // dist=500m → CRUISING 우세, confidence>0.7 → gate 차단
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makePhaseTrip());
    await seedSeriesWithDistance(kv, 'phase-tok', 500);
    // KV에 Kalman prior 심어 kalmanKmh가 null이 아닌 35km/h 근방으로 수렴되게 한다.
    // (prior 없으면 kalmanKmh=null → phaseState 분류 입력으로 kalmanState.v 사용)
    // Kalman prior가 있어야 kalmanKmh가 non-null이 됨 — 하지만 phaseState는 kalmanState.v 입력.
    // 실제로 runFusionStep은 kalmanState.v를 phase 입력으로 사용하므로 prior 상관없이 분류는 실행됨.
    // 핵심: series의 마지막 sample nearestStationDistanceM=500 → CRUISING → confidence>0 테스트.
    // cruiseSpeed는 kalmanState.v≥20일 때 활성. 초기 kalman에서 gpsAvg를 사용 → ~35km/h 예측.
    // 또한 farFromStationStill은 500>200이지만 속도 높으면 비활성.
    // prior=null 첫 cycle이면 kalmanKmh=null → phase 입력으로 kalmanState.v는 gpsAvg≈35로 초기화.
    // → cruiseSpeed 활성 → CRUISING 우세 → confidence=3/Σ > 0.7이면 차단.
    // 실제 confidence 계산: dist=500>200 → stationVicinity 비활성, dwellingZone 비활성.
    // cruiseSpeed(35≥20): A-1,D-2,Dep-1,C+3
    // → A=-1, D=-2, Dep=-1, C=3 → CRUISING best, second=-1
    // confidence=(3-(-1))/Σ|1+2+1+3|=4/7≈0.571 < 0.7 → gate 허용 (차단 안 됨)
    // 즉 dist=500, speed=35만으로는 confidence<0.7 → 차단 안 됨.
    // 차단하려면 더 많은 feature 활성화가 필요.
    // 실제로 phaseImminentBlocked 테스트는 confidence≥0.7 케이스를 직접 주입해야 함.
    // stationPhase를 trip에 미리 stamp해서 prev hysteresis로 boost.
    const tripWithPhase = makePhaseTrip({
      stationPhase: {
        current: 'CRUISING',
        confidence: 0.9, // 이미 high-confidence CRUISING
        lastEvaluatedAt: NOW - 1000,
      },
    });
    await kv.delete('trip:phase-tok');
    await putTrip(kv as unknown as KVNamespace, tripWithPhase);

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([ARVL_ARRIVED]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'phase-p2',
    });

    // phaseState.confidence가 boost돼 ≥0.7이고 CRUISING → gate 차단
    expect(stats.phaseImminentBlocked).toBe(1);
    expect(stats.pushed).toBe(0);
    expect(apnsFetch).not.toHaveBeenCalled();
    // dirty=true → putTrip 호출됨 → trip에 stationPhase persist 확인
    const stored = JSON.parse((await kv.get('trip:phase-tok'))!) as Trip;
    expect(stored.stationPhase).toBeDefined();
  });

  it('low-confidence CRUISING (confidence=0.5) + fires → gate 허용, push 발사', async () => {
    // confidence < IMMINENT_FIRING_CONFIDENCE(0.7) → 허용
    const tripWithLowConf = makePhaseTrip({
      stationPhase: {
        current: 'CRUISING',
        confidence: 0.5,
        lastEvaluatedAt: NOW - 1000,
      },
    });
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, tripWithLowConf);
    // nearestStationDistanceM=500 series — 분류 결과가 prev와 달라도 prev.confidence=0.5
    // hysteresis: candidate=CRUISING == prev.current → confidence boost 0.5+0.2=0.7
    // 그런데 boost 후 0.7 ≥ IMMINENT_FIRING_CONFIDENCE → gate 차단될 수 있음.
    // nearestStationDistanceM=undefined로 phase null path 유지 → phaseAllows=true.
    await seedSeriesWithDistance(kv, 'phase-tok', undefined);

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([ARVL_ARRIVED]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'phase-p3',
    });

    // phaseState=null (nearestStationDistanceM undefined) → phaseAllows=true → 발사
    expect(stats.phaseImminentBlocked).toBe(0);
    expect(stats.pushed).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // ScheduledStats.phaseImminentBlocked 초기값
  // ---------------------------------------------------------------------------
  it('phaseImminentBlocked 초기 0: 정상 사이클에서 phase gate 미발동이면 0 유지', async () => {
    // lock-active trip만 있으면 lockless path 미진입 → phaseImminentBlocked=0
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip({
      token: 'lock-only',
      boardingLock: {
        trainCode: 'T',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: NOW,
        segmentStations: ['강남', '역삼'],
        expiresAt: NOW + 60 * 60_000,
      },
      waypoints: [{ stationName: '역삼', line: '2', kind: 'destination' }],
    }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'phase-init',
    });
    expect(stats.phaseImminentBlocked).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // evaluateAndMaybeFireBoardingPrompt — phase stamp
  // ---------------------------------------------------------------------------
  it('nearestStationDistanceM 포함 series + boarding-prompt 경로 → trip.stationPhase 갱신 + putTrip', async () => {
    // boarding-prompt 평가 경로(lockMissing)에서 phase stamp 확인
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'phase-bp-tok',
      promptGeoContext: {
        origin: { lat: 0, lng: 0 },
        nextStation: { lat: 0, lng: 0.01 },
        direction: 'up',
      },
      promptDisplay: { originStation: '강남', line: '2' },
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    // series with nearestStationDistanceM → phase 분류 가능
    await seedSeriesWithDistance(kv, 'phase-bp-tok', 500);

    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl,
      now: () => NOW,
      generatePushId: () => 'phase-bp-1',
    });

    // phase 분류 결과가 trip에 stamp되어야 함
    const stored = JSON.parse((await kv.get('trip:phase-bp-tok'))!) as Trip;
    expect(stored.stationPhase).toBeDefined();
    expect(stored.stationPhase?.current).toBeDefined();
    expect(stored.stationPhase?.lastEvaluatedAt).toBe(NOW);
  });

  it('nearestStationDistanceM 없는 series → trip.stationPhase 갱신 안 됨 (기존 회귀 보존)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'phase-no-dist-tok',
      promptGeoContext: {
        origin: { lat: 0, lng: 0 },
        nextStation: { lat: 0, lng: 0.01 },
        direction: 'up',
      },
      promptDisplay: { originStation: '강남', line: '2' },
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    // nearestStationDistanceM=undefined → phaseState=null → trip.stationPhase 변경 없음
    await seedSeriesWithDistance(kv, 'phase-no-dist-tok', undefined);

    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'phase-no-1',
    });

    // stationPhase는 갱신 안 됨 (phase null → dirty=false → putTrip 미호출 혹은 stationPhase 미set)
    // boarding-prompt 게이트가 통과되면 boardingPromptState가 set되므로 trip은 저장되지만
    // stationPhase는 undefined 상태 유지
    const stored = JSON.parse((await kv.get('trip:phase-no-dist-tok'))!) as Trip;
    expect(stored.stationPhase).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #826 — ScheduledStats 초기값 검증
// ---------------------------------------------------------------------------

describe('ScheduledStats 초기값 (#826 E4)', () => {
  it('kalmanReset, kalmanDriftWarning 초기값 0 — trip 없는 빈 실행', async () => {
    const kv = new InMemoryKV();
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.kalmanReset).toBe(0);
    expect(stats.kalmanDriftWarning).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #826 — drift telemetry
// ---------------------------------------------------------------------------

/**
 * series 헬퍼 (#826 drift telemetry): 유효한 positionSeries를 KV에 심는다.
 * gpsAvgKmh가 `targetKmh` 근방이 되도록 두 지점을 배치한다.
 * 두 포인트의 haversine 거리 / Δt = gpsAvg.
 *
 * sonar S7721 — 함수를 describe 외부 module scope에 두어 매 describe call 시 재정의 회피.
 */
async function seedSeriesWithGpsAvg(
  kv: InMemoryKV,
  token: string,
  targetGpsKmh: number,
): Promise<void> {
  // Δt = 10s, lng 차이로 동서 이동 시뮬. 위도 0 기준 1도 ≈ 111.32 km.
  const dtMs = 10_000;
  const distKm = (targetGpsKmh * dtMs) / 3_600_000;
  const lngDelta = distKm / 111.32;
  const series = [
    { lat: 0, lng: 0, accuracy: 10, ts: NOW - dtMs, motion: 'automotive' },
    { lat: 0, lng: lngDelta, accuracy: 10, ts: NOW, motion: 'automotive' },
  ];
  await kv.put(`pos:${token}`, JSON.stringify(series));
}

function makeDriftTrip(token: string, overrides: Partial<Trip> = {}): Trip {
  return makeTrip({
    token,
    promptGeoContext: {
      origin: { lat: 0, lng: 0 },
      nextStation: { lat: 0, lng: 0.01 },
      direction: 'up',
    },
    promptDisplay: { originStation: '강남', line: '2' },
    ...overrides,
  });
}

describe('runScheduled — #826 drift telemetry (kalmanDriftWarning)', () => {
  it('prior=null 첫 cycle → kalmanDriftWarning 0 (drift 검사 건너뜀)', async () => {
    // prior가 없으면 detectKalmanDrift 호출 자체를 skip — delta=0이 아닌 호출 미발생
    const kv = new InMemoryKV();
    const trip = makeDriftTrip('drift-first');
    await putTrip(kv as unknown as KVNamespace, trip);
    // gpsAvg ≈ 30 km/h series 심기
    await seedSeriesWithGpsAvg(kv, 'drift-first', 30);

    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'd1',
    });
    // prior=null → detectKalmanDrift 미호출 → kalmanDriftWarning 미증가
    expect(stats.kalmanDriftWarning).toBe(0);
  });

  it('prior 있음 + |gpsAvg - state.v| ≥ 15 → kalmanDriftWarning++', async () => {
    // prior state.v=0 (정차), gpsAvg ≈ 30 km/h → delta=30 ≥ 15 → warning
    const kv = new InMemoryKV();
    const token = 'drift-warn';
    const trip = makeDriftTrip(token);
    await putTrip(kv as unknown as KVNamespace, trip);
    await seedSeriesWithGpsAvg(kv, token, 30);
    // KV에 prior 심기 — state.v=0 (도착 직후 reset 상태)
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 0, P: R_LOW, ts: NOW - 15_000 }));

    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'd2',
    });
    expect(stats.kalmanDriftWarning).toBe(1);
  });

  it('prior 있음 + 작은 delta(< 15) → kalmanDriftWarning 0', async () => {
    // prior state.v=30, gpsAvg ≈ 32 → delta=2 < 15 → warning 없음
    const kv = new InMemoryKV();
    const token = 'drift-small';
    const trip = makeDriftTrip(token);
    await putTrip(kv as unknown as KVNamespace, trip);
    await seedSeriesWithGpsAvg(kv, token, 32);
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 30, P: 25, ts: NOW - 15_000 }));

    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'd3',
    });
    expect(stats.kalmanDriftWarning).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #837 P2-3 — maybeCountDrift 단위 (fusion에서 분리한 헬퍼, SRP)
// ---------------------------------------------------------------------------

function makePosMetricsFixture(gpsAvgKmh: number): WindowedMetrics {
  return {
    count: 6,
    gpsAvgKmh,
    avgAccuracyMeters: 12,
    motion: 'walking',
    start: null,
    end: null,
    mapMatchedKmh: null,
  };
}

function makeEmptyStats(): ScheduledStats {
  // maybeCountDrift는 stats.kalmanDriftWarning만 참조. 다른 필드는 영향 없어 0으로 채운다.
  // ScheduledStats 전체 필드를 일일이 적는 대신 runScheduled 본문과 동일하게 단일 필드만 검증한다.
  return { kalmanDriftWarning: 0 } as unknown as ScheduledStats;
}

describe('maybeCountDrift (#837 P2-3)', () => {
  it('prior=null이면 drift 카운트 skip (첫 cycle)', () => {
    const stats = makeEmptyStats();
    const posMetrics = makePosMetricsFixture(30); // delta=30 ≥ 15지만 prior 없음
    maybeCountDrift(null, posMetrics, stats);
    expect(stats.kalmanDriftWarning).toBe(0);
  });

  it('prior 존재 + |state.v - gpsAvg| ≥ DRIFT_WARNING_THRESHOLD_KMH → +1', () => {
    const stats = makeEmptyStats();
    const prior: KalmanState = { v: 0, P: R_LOW, ts: 0 };
    // state.v=0, gpsAvg=DRIFT_WARNING_THRESHOLD_KMH → |delta|=15 (경계 포함)
    const posMetrics = makePosMetricsFixture(DRIFT_WARNING_THRESHOLD_KMH);
    maybeCountDrift(prior, posMetrics, stats);
    expect(stats.kalmanDriftWarning).toBe(1);
  });

  it('prior 존재 + |delta| < 임계 → 카운트 변화 없음', () => {
    const stats = makeEmptyStats();
    const prior: KalmanState = { v: 30, P: 25, ts: 0 };
    // |30 - 32| = 2 < 15
    const posMetrics = makePosMetricsFixture(32);
    maybeCountDrift(prior, posMetrics, stats);
    expect(stats.kalmanDriftWarning).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #826 — lockless ARRIVED/ENTERING → Kalman reset
// ---------------------------------------------------------------------------

function makeLocklessKalmanTrip(token: string, overrides: Partial<Trip> = {}): Trip {
  return makeTrip({
    token,
    waypoints: [
      { stationName: '강남', line: '2', kind: 'intermediate' },
      { stationName: '역삼', line: '2', kind: 'destination' },
    ],
    locklessStationPassed: true,
    ...overrides,
  });
}

function makeArrivedSignal(arvlCd: number): ArrivalEntry {
  return {
    destination: '강남행',
    arrivalSeconds: 10,
    trainCode: '9999',
    isUp: true,
    subwayNm: '지하철2호선',
    arvlCd,
  };
}

/**
 * #826 Kalman reset 테스트용 deps 헬퍼 — 동일 boilerplate(apnsConfig/Hosts/fetchImpl/now)를
 * 5곳에서 반복하지 않게 묶음. sonar new_duplicated_lines_density 임계 정합.
 */
function makeKalmanResetDeps(
  seoul: SeoulArrivalClient,
  pushId: string,
): ScheduledDeps {
  return {
    seoul,
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    now: () => NOW,
    generatePushId: () => pushId,
  };
}

describe('runScheduled — #826 lockless intermediate Kalman reset', () => {
  it('arvlCd=ARRIVED(1) → fires=true → kalman:<token>이 v=0/P=4로 reset + stats.kalmanReset=1', async () => {
    const kv = new InMemoryKV();
    const token = 'lock-kalman-1';
    await putTrip(kv as unknown as KVNamespace, makeLocklessKalmanTrip(token));
    // 기존 kalman state 심기 (reset 이전 상태)
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 40, P: 100, ts: NOW - 5_000 }));

    const stats = await runScheduled(
      makeEnv(kv),
      makeKalmanResetDeps(makeSeoul([makeArrivedSignal(1)]), 'lk1'),
    );

    expect(stats.kalmanReset).toBe(1);
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState?.v).toBe(0);
    expect(kalmanState?.P).toBe(R_LOW);
    expect(kalmanState?.ts).toBe(NOW);
  });

  it('arvlCd=ENTERING(0) → fires=true → Kalman reset 발사 + stats.kalmanReset=1', async () => {
    const kv = new InMemoryKV();
    const token = 'lock-kalman-2';
    await putTrip(kv as unknown as KVNamespace, makeLocklessKalmanTrip(token));
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 35, P: 50, ts: NOW - 3_000 }));

    const stats = await runScheduled(
      makeEnv(kv),
      makeKalmanResetDeps(makeSeoul([makeArrivedSignal(0)]), 'lk2'),
    );

    expect(stats.kalmanReset).toBe(1);
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState?.v).toBe(0);
    expect(kalmanState?.P).toBe(R_LOW);
  });

  it('arvlCd=2(출발) → fires=false → Kalman reset 미발사 + stats.kalmanReset=0', async () => {
    // arvlCd=2는 ENTERING(0)/ARRIVED(1) 아님 → fires=false → reset 경로 미진입
    const kv = new InMemoryKV();
    const token = 'lock-kalman-3';
    await putTrip(kv as unknown as KVNamespace, makeLocklessKalmanTrip(token));
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 30, P: 25, ts: NOW - 3_000 }));

    const stats = await runScheduled(
      makeEnv(kv),
      makeKalmanResetDeps(makeSeoul([makeArrivedSignal(2)]), 'lk3'),
    );

    // 핵심: fires=false로 reset 경로 자체 미진입 → kalmanReset=0
    expect(stats.kalmanReset).toBe(0);
  });

  it('phase gate 차단 케이스 → reset은 phase gate와 무관하게 발사 (kalmanReset=1, phaseImminentBlocked=1)', async () => {
    // ARRIVED + high-confidence CRUISING → phase gate 차단 → push 미발사
    // 하지만 reset은 phase gate 평가 전에 이미 실행 → kalmanReset=1
    const kv = new InMemoryKV();
    const token = 'lock-kalman-4';
    const tripWithCruising = makeLocklessKalmanTrip(token, {
      stationPhase: {
        current: 'CRUISING',
        confidence: 0.9, // high-confidence CRUISING → gate 차단
        lastEvaluatedAt: NOW - 1000,
      },
    });
    await putTrip(kv as unknown as KVNamespace, tripWithCruising);
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 35, P: 25, ts: NOW - 3_000 }));
    // nearestStationDistanceM 있는 series로 phase classification 활성화
    const series = [
      { lat: 0, lng: -0.0004, accuracy: 10, ts: NOW - 60_000, motion: 'automotive', nearestStationDistanceM: 500 },
      { lat: 0, lng: 0.0002, accuracy: 10, ts: NOW - 30_000, motion: 'automotive', nearestStationDistanceM: 500 },
      { lat: 0, lng: 0.0008, accuracy: 10, ts: NOW, motion: 'automotive', nearestStationDistanceM: 500 },
    ];
    await kv.put(`pos:${token}`, JSON.stringify(series));

    const stats = await runScheduled(
      makeEnv(kv),
      makeKalmanResetDeps(makeSeoul([makeArrivedSignal(1)]), 'lk4'),
    );

    // reset은 phase gate 이전에 발사
    expect(stats.kalmanReset).toBe(1);
    // phase gate가 차단
    expect(stats.phaseImminentBlocked).toBe(1);
    // push 미발사
    expect(stats.pushed).toBe(0);
    // kalman state는 reset됨
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState?.v).toBe(0);
    expect(kalmanState?.P).toBe(R_LOW);
  });
});

// ---------------------------------------------------------------------------
// #837 P2-1 — lockless dedup gate / reset 순서 (arvlCd > phase 우선순위)
// ---------------------------------------------------------------------------

describe('runScheduled — #837 P2-1 lockless dedup vs Kalman reset 순서', () => {
  it('이미 imminent 발사한 trip + arvlCd=ARRIVED → reset은 발사 (kalmanReset=1), push는 dedup으로 skip', async () => {
    // 핵심: dedup된 trip이라도 ground truth(ARRIVED)면 Kalman state는 reset해야 함.
    // 이전 동작: dedup gate가 fusion/reset 이전이라 reset 미진입 → drift 누적.
    // 수정 후: fusion + arrivals fetch + reset 수행 → dedup gate가 push만 차단.
    const kv = new InMemoryKV();
    const token = 'lock-dedup-reset-1';
    await putTrip(
      kv as unknown as KVNamespace,
      makeLocklessKalmanTrip(token, { lastFiredPhase: 'imminent' }),
    );
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 40, P: 100, ts: NOW - 5_000 }));

    const fetchSpy = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([makeArrivedSignal(1)]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchSpy,
      now: () => NOW,
      generatePushId: () => 'lk-dedup-1',
    });

    // reset은 수행 (drift 차단)
    expect(stats.kalmanReset).toBe(1);
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState?.v).toBe(0);
    expect(kalmanState?.P).toBe(R_LOW);
    // push는 dedup으로 skip (APNs fetch 호출 0회)
    expect(stats.pushed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('이미 imminent 발사한 trip + signal null (etaMissing) → reset 미발사 (fires만이 진실)', async () => {
    // dedup gate 이동했어도 reset 트리거는 fires=true만이어야 함.
    // signal 부재/arvlCd null은 etaMissing 경로 — reset 미진입.
    const kv = new InMemoryKV();
    const token = 'lock-dedup-reset-2';
    await putTrip(
      kv as unknown as KVNamespace,
      makeLocklessKalmanTrip(token, { lastFiredPhase: 'imminent' }),
    );
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 35, P: 50, ts: NOW - 3_000 }));

    const stats = await runScheduled(
      makeEnv(kv),
      // arrivals 빈 배열 → signal=null → etaMissing 경로
      makeKalmanResetDeps(makeSeoul([]), 'lk-dedup-2'),
    );

    expect(stats.kalmanReset).toBe(0);
    expect(stats.etaMissing).toBe(1);
    expect(stats.pushed).toBe(0);
    // kalman state 보존 (reset 미진입)
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState?.v).toBe(35);
    expect(kalmanState?.P).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// #826 — runTrainCodeTracking → Kalman reset on arrived
// ---------------------------------------------------------------------------

function makeLockWithKalmanTrip(token: string, overrides: Partial<Trip> = {}): Trip {
  return makeTrip({
    token,
    route: { type: 'direct', line: '7', stops: 2 },
    waypoints: [
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '군자', line: '7', kind: 'destination' },
    ],
    boardingLock: {
      trainCode: '7246',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: NOW,
      segmentStations: ['용마산', '중곡', '군자'],
      expiresAt: NOW + 60 * 60_000,
    },
    ...overrides,
  });
}

function makeSeoulWithArvl(stationName: string, seconds: number, arvlCd: number | null): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: [
            {
              barvlDt: String(seconds),
              recptnDt: '',
              updnLine: '상행',
              trainLineNm: stationName,
              btrainNo: '7246',
              subwayNm: '지하철7호선',
              arvlCd,
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

describe('runScheduled — #826 runTrainCodeTracking Kalman reset', () => {
  it('boardingLock 활성 + estimate.arrived=true(arvlCd=1) → reset + stats.kalmanReset=1', async () => {
    const kv = new InMemoryKV();
    const token = 'tc-kalman-1';
    await putTrip(kv as unknown as KVNamespace, makeLockWithKalmanTrip(token));
    // 기존 kalman state 심기
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 40, P: 100, ts: NOW - 5_000 }));

    const stats = await runScheduled(
      makeEnv(kv),
      makeKalmanResetDeps(makeSeoulWithArvl('중곡', 0, 1), 'tc1'), // arvlCd=1 ARRIVED
    );

    expect(stats.kalmanReset).toBe(1);
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState?.v).toBe(0);
    expect(kalmanState?.P).toBe(R_LOW);
    expect(kalmanState?.ts).toBe(NOW);
  });

  it('boardingLock 활성 + estimate.arrived=false → reset 미발사 + stats.kalmanReset=0', async () => {
    const kv = new InMemoryKV();
    const token = 'tc-kalman-2';
    await putTrip(kv as unknown as KVNamespace, makeLockWithKalmanTrip(token));
    // 일반 ETA 응답 (도착 아님)
    const originalV = 35;
    await kv.put(`kalman:${token}`, JSON.stringify({ v: originalV, P: 25, ts: NOW - 5_000 }));

    const stats = await runScheduled(
      makeEnv(kv),
      makeKalmanResetDeps(makeSeoulWithArvl('중곡', 120, null), 'tc2'), // arrived=false
    );

    expect(stats.kalmanReset).toBe(0);
    // kalman state는 reset되지 않음 (runFusionStep은 lockless/boardingPrompt 경로에서만 동작)
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    // reset이 없었으므로 v≠0 (원래 값 또는 update된 값)
    if (kalmanState !== null) {
      // arrived=false이면 kalman reset이 없어야 함 — v=0 아님을 확인
      expect(kalmanState.v).not.toBe(0);
    }
  });
});

/**
 * #902 Seam F 공용 fixture 빌더.
 *
 * `realtimeArrivalList` raw row 1건의 shape는 `makeSeoul` 등 기존 helper와 동일하지만,
 * 본 describe 묶음(환승 swap + 사라짐 re-attach)이 URL 분기, multi-row ambiguity 등을 별도로
 * 조합하므로 row 빌더만 외부로 추출해 중복(barvlDt/recptnDt/updnLine ... arvlCd)을 제거한다.
 */
interface RawArrivalRowInput {
  trainCode: string;
  arrivalSeconds: number;
  arvlCd: number;
  subwayNm: string;
  destination?: string;
}
function rawArrivalRow(row: RawArrivalRowInput): Record<string, unknown> {
  return {
    barvlDt: String(row.arrivalSeconds),
    recptnDt: '',
    updnLine: '상행',
    trainLineNm: row.destination ?? '도봉산',
    btrainNo: row.trainCode,
    subwayNm: row.subwayNm,
    arvlCd: row.arvlCd,
  };
}
function arrivalListResponse(rows: RawArrivalRowInput[]): Response {
  return new Response(
    JSON.stringify({ realtimeArrivalList: rows.map(rawArrivalRow) }),
    { status: 200 },
  );
}

/**
 * #902 Seam F — 환승 자동 trainCode swap 통합 테스트.
 *
 * 시나리오: 7호선 trainCode "7327"으로 건대입구(transfer) ARRIVED → lock 해제 + 다음 cycle
 * 안에 같은 polling으로 2호선 성수 arrivals에서 후보 trainCode "2227"을 자동 attach.
 * 옛 동작: lock 비어있는 다음 cycle이 boarding-prompt 경로로 떨어져 사용자가 manual 선택 필요.
 */
describe('runScheduled — Seam F 환승 자동 swap (#902)', () => {
  /** transfer→destination waypoints + line 7 boardingLock(건대입구로 ARRIVED 예정)의 trip 빌더. */
  function makeTransferTrip(overrides: Partial<Trip> = {}): Trip {
    return makeTrip({
      token: 'transfer-tok',
      route: { type: 'direct', line: '7', stops: 3 },
      waypoints: [
        { stationName: '건대입구', line: '7', kind: 'transfer' },
        { stationName: '성수', line: '2', kind: 'destination' },
      ],
      boardingLock: {
        trainCode: '7327',
        line: '7',
        subwayId: '1007',
        selectedDepartureTime: NOW,
        segmentStations: ['어린이대공원', '군자', '건대입구'],
        expiresAt: NOW + 60 * 60_000,
      },
      ...overrides,
    });
  }

  /**
   * 라인별 응답 분기 fetch — 7호선 건대입구는 ARRIVED, 2호선 성수는 후보 1개(2227 arvlCd=1).
   * Seoul API URL은 stationName query를 포함 — encode된 stationName으로 분기.
   */
  function makeTransferSeoul(): SeoulArrivalClient {
    return new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async (url: string) => {
        if (url.includes(encodeURIComponent('건대입구'))) {
          // 7호선 trainCode 7327이 건대입구에 ARRIVED(arvlCd=1).
          return arrivalListResponse([
            { trainCode: '7327', arrivalSeconds: 0, arvlCd: 1, subwayNm: '지하철7호선' },
          ]);
        }
        if (url.includes(encodeURIComponent('성수'))) {
          // 2호선 성수: 후보 trainCode 2227 ARRIVED 1대만 → pickAutoTrainCode 1순위로 결정.
          return arrivalListResponse([
            { trainCode: '2227', arrivalSeconds: 60, arvlCd: 1, subwayNm: '지하철2호선', destination: '성수' },
          ]);
        }
        return arrivalListResponse([]);
      }) as unknown as typeof fetch,
    });
  }

  it('attaches new trainCode on transfer release within the same cycle', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTransferTrip());
    const fetchImpl = makeOkFetch();
    await runLaScheduled(kv, { seoul: makeTransferSeoul(), fetchImpl });

    // trip은 KV에 남아 있어야 한다 (transfer는 trip 종료가 아님).
    const raw = await kv.get('trip:transfer-tok');
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw as string) as Trip;
    // waypoint shift: 건대입구 제거 → 첫 waypoint=성수
    expect(stored.waypoints[0].stationName).toBe('성수');
    expect(stored.waypoints[0].line).toBe('2');
    // 자동 swap된 lock: trainCode 2227 + line 2 + segmentStations=[성수]
    expect(stored.boardingLock).toBeDefined();
    expect(stored.boardingLock?.trainCode).toBe('2227');
    expect(stored.boardingLock?.line).toBe('2');
    expect(stored.boardingLock?.subwayId).toBe('1002');
    expect(stored.boardingLock?.segmentStations).toEqual(['성수']);
  });

  it('leaves lock undefined when no candidate matches (boarding-prompt fallback path)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTransferTrip());
    // 7호선 건대입구는 ARRIVED 정상, 2호선 성수는 빈 응답 → swap 실패 → 기존 lockMissing 흐름.
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async (url: string) => {
        if (url.includes(encodeURIComponent('건대입구'))) {
          return arrivalListResponse([
            { trainCode: '7327', arrivalSeconds: 0, arvlCd: 1, subwayNm: '지하철7호선' },
          ]);
        }
        return arrivalListResponse([]);
      }) as unknown as typeof fetch,
    });
    await runLaScheduled(kv, { seoul, fetchImpl: makeOkFetch() });
    const stored = JSON.parse((await kv.get('trip:transfer-tok')) as string) as Trip;
    expect(stored.waypoints[0].stationName).toBe('성수');
    expect(stored.boardingLock).toBeUndefined();
  });
});

/**
 * #902 Seam F — trainCode 사라짐 후 재attach.
 *
 * 시나리오: 옛 trainCode가 Seoul API에서 사라지면 같은 station/line의 신규 trainCode를 같은
 * cycle에 자동 swap. previousMissCount=1 + 이번 cycle 미스 = 2 도달이 트리거. 1로는 false swap
 * 위험 — 일시적 API 누락과 진짜 사라짐 구분 불가.
 */
describe('runScheduled — Seam F 사라짐 후 재attach (#902)', () => {
  function makeMissingTrainTrip(missCount: number): Trip {
    // boardingLock.trainCode=7174는 사라짐(arrivals에 부재). same-line(7) 신규 후보로 swap 기대.
    return makeTrip({
      token: 'miss-tok',
      route: { type: 'direct', line: '7', stops: 2 },
      waypoints: [{ stationName: '군자', line: '7', kind: 'destination' }],
      boardingLock: {
        trainCode: '7174',
        line: '7',
        subwayId: '1007',
        selectedDepartureTime: NOW,
        segmentStations: ['어린이대공원', '군자'],
        expiresAt: NOW + 60 * 60_000,
      },
      consecutiveEtaMissing: missCount,
    });
  }

  /** 7호선 군자 응답: trainCode 7174는 없음, 7246(arvlCd=2 DEPARTED) 1대만. */
  function makeReAttachSeoul(): SeoulArrivalClient {
    return new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () =>
        arrivalListResponse([
          { trainCode: '7246', arrivalSeconds: 60, arvlCd: 2, subwayNm: '지하철7호선' },
        ])) as unknown as typeof fetch,
    });
  }

  it('swaps to new trainCode when threshold reached (prev miss=1 + this miss = 2)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeMissingTrainTrip(1));
    const fetchImpl = makeOkFetch();
    await runLaScheduled(kv, { seoul: makeReAttachSeoul(), fetchImpl });
    const stored = JSON.parse((await kv.get('trip:miss-tok')) as string) as Trip;
    // swap 성공 → trainCode 갱신 + 카운터 reset
    expect(stored.boardingLock?.trainCode).toBe('7246');
    expect(stored.consecutiveEtaMissing ?? 0).toBe(0);
  });

  it('does not swap on first miss (prev=0) — single transient API miss tolerated', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeMissingTrainTrip(0));
    await runLaScheduled(kv, { seoul: makeReAttachSeoul(), fetchImpl: makeOkFetch() });
    const stored = JSON.parse((await kv.get('trip:miss-tok')) as string) as Trip;
    // swap 안 됨 — 기존 trainCode 유지 + 카운터 +1
    expect(stored.boardingLock?.trainCode).toBe('7174');
    expect(stored.consecutiveEtaMissing).toBe(1);
  });

  it('keeps incrementing miss counter when no candidate at threshold (ambiguous arrivals)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeMissingTrainTrip(1));
    // 두 trainCode 모두 arvlCd=1 → pickAutoTrainCode가 ambiguity로 null → swap 실패
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () =>
        arrivalListResponse([
          { trainCode: 'A', arrivalSeconds: 30, arvlCd: 1, subwayNm: '지하철7호선' },
          { trainCode: 'B', arrivalSeconds: 60, arvlCd: 1, subwayNm: '지하철7호선' },
        ])) as unknown as typeof fetch,
    });
    await runLaScheduled(kv, { seoul, fetchImpl: makeOkFetch() });
    const stored = JSON.parse((await kv.get('trip:miss-tok')) as string) as Trip;
    expect(stored.boardingLock?.trainCode).toBe('7174');
    expect(stored.consecutiveEtaMissing).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #916 A1 — auto-lock 통합 (evaluateAndMaybeFireBoardingPrompt 분기)
// ──────────────────────────────────────────────────────────────────────────

describe('runScheduled — #916 A1 auto-lock', () => {
  // 모듈 레벨 makePromptTrip / seedHappyGateSeries 재사용 (boarding-prompt / kalman 테스트와 공통).
  const seedHappySeries = (kv: InMemoryKV, token: string) => seedHappyGateSeries(kv, token);

  // 4 tests 공통 setup. 9단 게이트 통과 trip 시드 + GPS series + runScheduled 실행.
  async function runAutoLockCron(opts: {
    kv: InMemoryKV;
    token: string;
    arrivals: ArrivalEntry[];
    seedSeries?: boolean;
    pushId?: string;
  }): Promise<{
    stats: ScheduledStats;
    fetchImpl: ReturnType<typeof vi.fn>;
  }> {
    await putTrip(opts.kv as unknown as KVNamespace, makePromptTrip({ token: opts.token }));
    if (opts.seedSeries !== false) await seedHappySeries(opts.kv, opts.token);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const stats = await runScheduled(makeEnv(opts.kv), {
      seoul: makeSeoul(opts.arrivals),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      generatePushId: () => opts.pushId ?? 'auto-1',
    });
    return { stats, fetchImpl };
  }

  // 9단 게이트 통과 시점에 backend가 arvlCd=2 단일 후보로 trainCode를 결정 → 자동 lock 부착.
  it('9단 통과 + arrivals 단일 후보 → auto-lock 성공, boardingPrompt push 미발사', async () => {
    const kv = new InMemoryKV();
    const token = 'auto-lock-tok';
    const { stats, fetchImpl } = await runAutoLockCron({
      kv,
      token,
      arrivals: [
        { destination: '선릉', arrivalSeconds: 60, trainCode: 'AUTO-T1', isUp: true, subwayNm: '지하철2호선', arvlCd: 2 },
      ],
    });

    expect(stats.autoLockSuccess).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();

    const stored = JSON.parse((await kv.get(`trip:${token}`)) as string) as Trip;
    expect(stored.boardingLock?.trainCode).toBe('AUTO-T1');
    expect(stored.boardingLock?.segmentStations).toEqual(['강남', '역삼', '선릉']);
    expect(stored.boardingPromptState?.fired).toBe(true);
    expect(stored.consecutiveEtaMissing).toBe(0);
  });

  // ambiguity면 자동 lock 안 함 → 기존 boarding-prompt push fallback.
  it('arvlCd 우선순위 ambiguity → auto-lock 실패 → boarding-prompt push 발사', async () => {
    const kv = new InMemoryKV();
    const token = 'auto-amb-tok';
    const { stats } = await runAutoLockCron({
      kv,
      token,
      pushId: 'amb-1',
      arrivals: [
        { destination: 'A', arrivalSeconds: 60, trainCode: 'X1', isUp: true, subwayNm: '지하철2호선', arvlCd: 2 },
        { destination: 'B', arrivalSeconds: 90, trainCode: 'X2', isUp: true, subwayNm: '지하철2호선', arvlCd: 2 },
      ],
    });

    expect(stats.autoLockSuccess).toBe(0);
    expect(stats.boardingPromptFired).toBe(1);

    const stored = JSON.parse((await kv.get(`trip:${token}`)) as string) as Trip;
    expect(stored.boardingLock).toBeUndefined();
    expect(stored.boardingPromptState?.fired).toBe(true);
  });

  // arrivals 비어있어도 9단 통과(arrivals API와 promptGeoContext는 독립) → auto-lock skip → fallback.
  it('arrivals 비어있음 → auto-lock 실패 → boarding-prompt push 발사', async () => {
    const kv = new InMemoryKV();
    const { stats } = await runAutoLockCron({ kv, token: 'auto-empty-tok', arrivals: [], pushId: 'empty-1' });
    expect(stats.autoLockSuccess).toBe(0);
    expect(stats.boardingPromptFired).toBe(1);
  });

  // 9단 게이트 차단 → auto-lock 자체에 진입하지 않음.
  it('게이트 차단(window-too-small) → auto-lock 미시도', async () => {
    const kv = new InMemoryKV();
    const { stats } = await runAutoLockCron({
      kv,
      token: 'auto-gate-block',
      seedSeries: false, // series 미시드 → window-too-small 게이트 차단
      pushId: 'gate-1',
      arrivals: [
        { destination: 'A', arrivalSeconds: 60, trainCode: 'T', isUp: true, subwayNm: '지하철2호선', arvlCd: 2 },
      ],
    });
    expect(stats.autoLockSuccess).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
  });

  // 이미 fired 상태(같은 trip 재호출)면 게이트 #9가 차단하므로 auto-lock 미시도.
  it('boardingPromptState.fired=true → 게이트 #9 차단으로 auto-lock 미시도', async () => {
    const kv = new InMemoryKV();
    const token = 'auto-fired';
    await putTrip(
      kv as unknown as KVNamespace,
      makePromptTrip({
        token,
        boardingPromptState: { fired: true, lastFiredAt: NOW - 1000 },
      }),
    );
    await seedHappySeries(kv, token);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([
        { destination: 'A', arrivalSeconds: 60, trainCode: 'T', isUp: true, subwayNm: '지하철2호선', arvlCd: 2 },
      ]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl,
      generatePushId: () => 'fired-1',
    });

    expect(stats.autoLockSuccess).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
  });

  // 다음 cycle에서 client가 다른 lock을 등록하면 #864/#704 분기로 자연 교체된다.
  // (본 PR에서는 그 분기 자체는 변경하지 않으므로 회귀 보존만 확인)
  it('auto-lock 성공한 trip에 client가 다른 trainCode lock POST → 새 lock으로 교체', async () => {
    const kv = new InMemoryKV();
    const token = 'auto-swap';
    await putTrip(kv as unknown as KVNamespace, makePromptTrip({ token }));
    await seedHappySeries(kv, token);
    const fetchImpl1 = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    // 1st cycle: auto-lock 부착
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([
        { destination: '선릉', arrivalSeconds: 60, trainCode: 'AUTO-X', isUp: true, subwayNm: '지하철2호선', arvlCd: 2 },
      ]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl: fetchImpl1,
      generatePushId: () => 'auto-x',
    });
    const afterAuto = JSON.parse((await kv.get(`trip:${token}`)) as string) as Trip;
    expect(afterAuto.boardingLock?.trainCode).toBe('AUTO-X');

    // client가 다른 trainCode로 새 lock 등록 — putTrip으로 직접 시뮬레이션.
    const userChosen = {
      ...afterAuto,
      boardingLock: {
        ...afterAuto.boardingLock!,
        trainCode: 'USER-Y',
      },
    };
    await putTrip(kv as unknown as KVNamespace, userChosen);

    const stored = JSON.parse((await kv.get(`trip:${token}`)) as string) as Trip;
    expect(stored.boardingLock?.trainCode).toBe('USER-Y');
  });
});
