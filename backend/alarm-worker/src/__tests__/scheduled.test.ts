import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { pickActiveWaypoint, pickBestEtaSeconds, runScheduled } from '../scheduled';
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
    host: 'api.push.apple.com',
    keyId: 'K',
    teamId: 'T',
    privateKeyPem: pem,
    bundleId: 'com.example.app',
  };
});

beforeEach(() => resetApnsJwtCache());

const NOW = 1_700_000_000_000;

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: 'api.push.apple.com',
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

describe('pickBestEtaSeconds', () => {
  const wp = { stationName: '강남', line: '2', kind: 'destination' as const };
  it('returns null when no arrivals', () => {
    expect(pickBestEtaSeconds([], wp)).toBeNull();
  });
  it('matches by subwayNm and picks min', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 200, trainCode: '1', isUp: true, subwayNm: '지하철2호선' },
      { destination: 'B', arrivalSeconds: 60, trainCode: '2', isUp: true, subwayNm: '지하철2호선' },
      { destination: 'C', arrivalSeconds: 30, trainCode: '3', isUp: true, subwayNm: '지하철9호선' },
    ];
    expect(pickBestEtaSeconds(arrivals, wp)).toBe(60);
  });
  it('falls back to all arrivals when no line match', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 100, trainCode: '1', isUp: true, subwayNm: '지하철9호선' },
    ];
    expect(pickBestEtaSeconds(arrivals, wp)).toBe(100);
  });
  it('matches gyeongui line against 경의중앙선 subwayNm via alias map', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: '용문', arrivalSeconds: 90, trainCode: 'G', isUp: true, subwayNm: '경의중앙선' },
      { destination: '용문', arrivalSeconds: 200, trainCode: 'H', isUp: true, subwayNm: '지하철1호선' },
    ];
    const gyeonguiWp = { stationName: '회기', line: 'gyeongui', kind: 'destination' as const };
    expect(pickBestEtaSeconds(arrivals, gyeonguiWp)).toBe(90);
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
      { destination: '강남', arrivalSeconds: 120, trainCode: 'T', isUp: true, subwayNm: '지하철2호선' },
    ]);
    const fetchEarly = vi.fn(async () => new Response('', { status: 200 }));
    const stats1 = await runScheduled(makeEnv(kv), {
      seoul: seoul1,
      apnsConfig,
      fetchImpl: fetchEarly as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats1.pushed).toBe(1);
    expect(kv.store.size).toBe(1); // 트립 유지

    // 2nd cycle: imminent (eta=20s)
    const seoul2 = makeSeoul([
      { destination: '강남', arrivalSeconds: 20, trainCode: 'T', isUp: true, subwayNm: '지하철2호선' },
    ]);
    const fetchImminent = vi.fn(async () => new Response('', { status: 200 }));
    const stats2 = await runScheduled(makeEnv(kv), {
      seoul: seoul2,
      apnsConfig,
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
      { destination: '강남', arrivalSeconds: 140, trainCode: 'T', isUp: true, subwayNm: '지하철2호선' },
    ]);
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });
    // phase=early, lastFired=early → re-fire blocked. ETA delta=10s → not significant
    expect(stats.pushed).toBe(0);
  });

  it('removes trip on BadDeviceToken', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const seoul = makeSeoul([
      { destination: '강남', arrivalSeconds: 120, trainCode: 'T', isUp: true, subwayNm: '지하철2호선' },
    ]);
    const apnsFetch = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.errors).toBe(1);
    expect(kv.store.size).toBe(0);
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
      now: () => NOW,
    });
    expect(stats.errors).toBe(1);
  });
});
