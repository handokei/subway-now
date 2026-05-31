import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import {
  MAX_CONSECUTIVE_ETA_MISSING,
  RESCHEDULE_THRESHOLD_MS,
  estimateArrivalFromPosition,
  flipApnsEnv,
  pickActiveWaypoint,
  pickApnsHost,
  pickBestArrivalSignal,
  runScheduled,
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
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
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

// #705 — scheduled.ts의 advance/baseline 변경이 progress KV에도 mirror되는지.
// 시나리오는 LA 시나리오와 동일한 makeLockedLaTrip + makeLockedSeoul fixture로 압축.
describe('#705 scheduled.ts progress KV mirroring', () => {
  it('advanceBoardingLockWaypoint writes progress with shiftedCount=1 and trainCode stamp', async () => {
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
        lastLaPushEpoch: NOW + 1000,
      }),
    );
    const fetchImpl = makeOkFetch();
    // 중곡 ARRIVED → advanceBoardingLockWaypoint 트리거
    await runLaScheduled(kv, { seoul: makeLockedSeoul(0, 1), fetchImpl });
    const progressRaw = await kv.get('progress:la-tok');
    expect(progressRaw).not.toBeNull();
    const progress = JSON.parse(progressRaw as string);
    expect(progress.trainCode).toBe('T');
    expect(progress.shiftedCount).toBe(1);
  });

  it('mirrorProgress accumulates shiftedCount across multiple advances', async () => {
    const kv = new InMemoryKV();
    // 이전 advance가 이미 progress에 있는 상태에서 다시 advance.
    await kv.put(
      'progress:la-tok',
      JSON.stringify({ trainCode: 'T', shiftedCount: 1 }),
    );
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
      }),
    );
    await runLaScheduled(kv, { seoul: makeLockedSeoul(0, 1), fetchImpl: makeOkFetch() });
    const progress = JSON.parse((await kv.get('progress:la-tok')) as string);
    expect(progress.shiftedCount).toBe(2); // 1 + 1
  });

  it('mirrorProgress resets shiftedCount when stored progress has different trainCode', async () => {
    const kv = new InMemoryKV();
    await kv.put(
      'progress:la-tok',
      JSON.stringify({ trainCode: 'OLD', shiftedCount: 5 }),
    );
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
      }),
    );
    await runLaScheduled(kv, { seoul: makeLockedSeoul(0, 1), fetchImpl: makeOkFetch() });
    const progress = JSON.parse((await kv.get('progress:la-tok')) as string);
    expect(progress.trainCode).toBe('T');
    expect(progress.shiftedCount).toBe(1); // old(OLD) 폐기 + 새 advance 1
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
    const progress = JSON.parse((await kv.get('progress:la-tok')) as string);
    expect(progress.consecutiveEtaMissing).toBe(1);
    expect(progress.shiftedCount).toBe(0);
  });

  it('cleanupTripWithLa removes progress entry alongside trip', async () => {
    const kv = new InMemoryKV();
    await kv.put('progress:la-tok', JSON.stringify({ trainCode: 'T', shiftedCount: 1 }));
    // expired trip → cleanup 경로 진입
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({ expiresAt: NOW - 1 }),
    );
    await runLaScheduled(kv, { seoul: makeLockedSeoul(60), fetchImpl: makeOkFetch() });
    expect(await kv.get('progress:la-tok')).toBeNull();
  });
});
