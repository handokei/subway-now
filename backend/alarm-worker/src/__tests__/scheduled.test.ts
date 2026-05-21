import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import {
  flipApnsEnv,
  pickActiveWaypoint,
  pickApnsHost,
  pickBestArrivalSignal,
  runScheduled,
} from '../scheduled';
import { SeoulArrivalClient, type ArrivalEntry } from '../seoul';
import { putTrip } from '../trips';
import type { Env, Trip } from '../types';

class InMemoryKV {
  store = new Map<string, { value: string }>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, { value });
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(options?: { prefix?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor: string;
  }> {
    const prefix = options?.prefix ?? '';
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
    return { keys, list_complete: true, cursor: '' };
  }
}

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

function makeEnv(kv: InMemoryKV): Env {
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

function makeImminentArrival(stationName: string): ArrivalEntry {
  return {
    destination: stationName,
    arrivalSeconds: 20,
    trainCode: 'T',
    isUp: true,
    subwayNm: '지하철2호선',
    arvlCd: null,
  };
}

async function runWithImminent(
  kv: InMemoryKV,
  stationName: string,
): Promise<{ stats: Awaited<ReturnType<typeof runScheduled>>; apnsFetch: ReturnType<typeof vi.fn> }> {
  const seoul = makeSeoul([makeImminentArrival(stationName)]);
  const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
  const stats = await runScheduled(makeEnv(kv), {
    seoul,
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: apnsFetch as unknown as typeof fetch,
    now: () => NOW,
  });
  return { stats, apnsFetch };
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

  it('fires imminent push and removes trip when waypoint kind is destination', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const { stats, apnsFetch } = await runWithImminent(kv, '강남');
    expect(stats.pushed).toBe(1);
    expect(apnsFetch).toHaveBeenCalledTimes(1);
    expect(kv.store.size).toBe(0); // destination imminent → 트립 종료
  });

  it('keeps trip and advances waypoint when transfer waypoint reaches imminent', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        waypoints: [
          { stationName: '신도림', line: '2', kind: 'transfer' },
          { stationName: '강남', line: '2', kind: 'destination' },
        ],
      }),
    );
    const { stats } = await runWithImminent(kv, '신도림');
    expect(stats.pushed).toBe(1);
    expect(kv.store.size).toBe(1); // trip retained
    const stored = JSON.parse(kv.store.get('trip:tok')!.value) as Trip;
    expect(stored.waypoints).toHaveLength(1);
    expect(stored.waypoints[0].stationName).toBe('강남');
    expect(stored.lastFiredPhase).toBeUndefined();
    expect(stored.lastEtaSeconds).toBeUndefined();
  });

  it('deletes trip when last waypoint (after shift) is empty', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        // 비정상 케이스: transfer만 있고 destination 없음. shift 후 비면 trip 삭제.
        waypoints: [{ stationName: '신도림', line: '2', kind: 'transfer' }],
      }),
    );
    const { stats } = await runWithImminent(kv, '신도림');
    expect(stats.pushed).toBe(1);
    expect(kv.store.size).toBe(0);
  });

  it('counts ETA-missing cycles separately from errors', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const seoul = makeSeoul([]); // 빈 응답
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
    });
    expect(stats.etaMissing).toBe(1);
    expect(stats.pushed).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it('fires early then upgrades to imminent', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip());

    // 1st cycle: early (eta=120s)
    const seoul1 = makeSeoul([
      { destination: '강남', arrivalSeconds: 120, trainCode: 'T', isUp: true, subwayNm: '지하철2호선', arvlCd: null },
    ]);
    const fetchEarly = vi.fn(async () => new Response('', { status: 200 }));
    const stats1 = await runScheduled(makeEnv(kv), {
      seoul: seoul1,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchEarly as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats1.pushed).toBe(1);
    expect(kv.store.size).toBe(1); // 트립 유지

    // 2nd cycle: imminent (eta=20s)
    const seoul2 = makeSeoul([
      { destination: '강남', arrivalSeconds: 20, trainCode: 'T', isUp: true, subwayNm: '지하철2호선', arvlCd: null },
    ]);
    const fetchImminent = vi.fn(async () => new Response('', { status: 200 }));
    const stats2 = await runScheduled(makeEnv(kv), {
      seoul: seoul2,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImminent as unknown as typeof fetch,
      now: () => NOW + 30_000,
    });
    expect(stats2.pushed).toBe(1);
    expect(kv.store.size).toBe(0);
  });

  it('does not re-fire same phase', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({ lastFiredPhase: 'early', lastEtaSeconds: 150 }),
    );
    const seoul = makeSeoul([
      { destination: '강남', arrivalSeconds: 140, trainCode: 'T', isUp: true, subwayNm: '지하철2호선', arvlCd: null },
    ]);
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });
    // phase=early, lastFired=early → re-fire blocked. ETA delta=10s → not significant
    expect(stats.pushed).toBe(0);
  });

  // #482 self-heal (D안): BadDeviceToken은 토큰 자체 무효가 아니라 host 환경 불일치인 경우가
  // 압도적. 반대 host로 1회 재시도해 성공하면 trip.apnsEnv를 정정하고, 재시도도 실패하면
  // 그제서야 진짜 unrecoverable로 분류해 trip을 삭제한다.
  const BAD_TOKEN = () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 });
  const PAYLOAD_TOO_LARGE = () => new Response(JSON.stringify({ reason: 'PayloadTooLarge' }), { status: 400 });
  const UNREGISTERED = () => new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 });
  const OK = () => new Response('', { status: 200 });

  async function runWithFetch(
    apnsEnv: 'sandbox' | 'production' | undefined,
    apnsFetch: ReturnType<typeof vi.fn>,
  ) {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip({ apnsEnv }));
    const seoul = makeSeoul([
      { destination: '강남', arrivalSeconds: 120, trainCode: 'T', isUp: true, subwayNm: '지하철2호선', arvlCd: null },
    ]);
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });
    return { stats, kv };
  }

  /** host(sandbox/production)별로 다른 응답을 내는 fetch mock. */
  function fetchByHost(handlers: { sandbox: () => Response; production: () => Response }) {
    return vi.fn(async (url: string) =>
      url.includes('sandbox') ? handlers.sandbox() : handlers.production(),
    );
  }

  function storedTrip(kv: InMemoryKV): Trip {
    return JSON.parse(kv.store.get('trip:tok')!.value) as Trip;
  }

  it('self-heal: 1차 sandbox 실패(BadDeviceToken) → 2차 production 성공 → apnsEnv 정정', async () => {
    const apnsFetch = fetchByHost({ sandbox: BAD_TOKEN, production: OK });
    const { stats, kv } = await runWithFetch('sandbox', apnsFetch);
    expect(stats.pushed).toBe(1);
    expect(stats.errors).toBe(0);
    expect(stats.envCorrected).toBe(1);
    expect(apnsFetch).toHaveBeenCalledTimes(2);
    expect(storedTrip(kv).apnsEnv).toBe('production');
  });

  it('self-heal: 1차 production 실패 → 2차 sandbox 성공 → apnsEnv=sandbox 정정', async () => {
    const apnsFetch = fetchByHost({ sandbox: OK, production: BAD_TOKEN });
    const { stats, kv } = await runWithFetch('production', apnsFetch);
    expect(stats.pushed).toBe(1);
    expect(stats.envCorrected).toBe(1);
    expect(storedTrip(kv).apnsEnv).toBe('sandbox');
  });

  it('self-heal: 1차/2차 모두 BadDeviceToken → 진짜 unrecoverable, trip 삭제', async () => {
    const apnsFetch = vi.fn(BAD_TOKEN);
    const { stats, kv } = await runWithFetch('sandbox', apnsFetch);
    expect(apnsFetch).toHaveBeenCalledTimes(2);
    expect(stats.errors).toBe(1);
    expect(stats.envCorrected).toBe(0);
    expect(kv.store.size).toBe(0);
  });

  it('self-heal: apnsEnv=undefined trip(구버전 클라이언트) → sandbox로 시작 → production 정정', async () => {
    // 1차: sandbox host (pickApnsHost fallback) → 실패. 2차: production → 성공.
    const apnsFetch = fetchByHost({ sandbox: BAD_TOKEN, production: OK });
    const { stats, kv } = await runWithFetch(undefined, apnsFetch);
    expect(stats.envCorrected).toBe(1);
    expect(stats.pushed).toBe(1);
    expect(storedTrip(kv).apnsEnv).toBe('production');
  });

  it('self-heal retry가 다른 종류 에러(non-mismatch 400)면 trip 유지, exhausted 아님', async () => {
    // 1차 sandbox BadDeviceToken → 2차 production은 PayloadTooLarge (env 문제는 아님)
    const apnsFetch = fetchByHost({ sandbox: BAD_TOKEN, production: PAYLOAD_TOO_LARGE });
    const { stats, kv } = await runWithFetch('sandbox', apnsFetch);
    expect(stats.errors).toBe(1);
    expect(stats.envCorrected).toBe(0);
    expect(kv.store.size).toBe(1);
  });

  it('410 Unregistered → self-heal 우회, 즉시 trip 삭제 (회귀 방지)', async () => {
    const apnsFetch = vi.fn(UNREGISTERED);
    const { stats, kv } = await runWithFetch('production', apnsFetch);
    expect(apnsFetch).toHaveBeenCalledTimes(1); // 410은 retry 안 함
    expect(stats.errors).toBe(1);
    expect(stats.envCorrected).toBe(0);
    expect(kv.store.size).toBe(0);
  });

  it('400 그 외 reason은 self-heal 안 함, trip 유지 (recoverable error)', async () => {
    const apnsFetch = vi.fn(PAYLOAD_TOO_LARGE);
    const { stats, kv } = await runWithFetch('production', apnsFetch);
    expect(apnsFetch).toHaveBeenCalledTimes(1);
    expect(stats.errors).toBe(1);
    expect(stats.envCorrected).toBe(0);
    expect(kv.store.size).toBe(1);
  });

  // #416: 중간역(intermediate) 처리 — early phase 스킵, imminent에서만 push + shift.
  it('intermediate waypoint: early ETA에서는 push 안 함', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        waypoints: [
          { stationName: '중곡', line: '7', kind: 'intermediate' },
          { stationName: '강남', line: '2', kind: 'destination' },
        ],
      }),
    );
    const seoul = makeSeoul([
      { destination: '중곡', arrivalSeconds: 120, trainCode: 'T', isUp: true, subwayNm: '7호선', arvlCd: null },
    ]);
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.pushed).toBe(0);
    // trip은 유지 (다음 사이클에 imminent까지 폴링)
    expect(kv.store.size).toBe(1);
    const stored = JSON.parse(kv.store.get('trip:tok')!.value) as Trip;
    expect(stored.waypoints).toHaveLength(2);
  });

  it('intermediate waypoint: imminent에서 push + shift', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        waypoints: [
          { stationName: '중곡', line: '7', kind: 'intermediate' },
          { stationName: '강남', line: '2', kind: 'destination' },
        ],
      }),
    );
    const seoul = makeSeoul([
      { destination: '중곡', arrivalSeconds: 20, trainCode: 'T', isUp: true, subwayNm: '7호선', arvlCd: null },
    ]);
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.pushed).toBe(1);
    // body에 kind=intermediate 포함 검증
    const call = apnsFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.data.kind).toBe('intermediate');
    expect(body.data.phase).toBe('imminent');
    // shift 후 destination만 남음
    expect(kv.store.size).toBe(1);
    const stored = JSON.parse(kv.store.get('trip:tok')!.value) as Trip;
    expect(stored.waypoints).toHaveLength(1);
    expect(stored.waypoints[0].kind).toBe('destination');
    expect(stored.lastFiredPhase).toBeUndefined();
    expect(stored.lastEtaSeconds).toBeUndefined();
  });

  it('counts seoul errors as poll errors', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const failingSeoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    });
    const stats = await runScheduled(makeEnv(kv), {
      seoul: failingSeoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
    });
    expect(stats.errors).toBe(1);
  });
});
