/**
 * #3141 — lock 열차 번호 변경(vanish-swap / 재등록 교체) 후 이미 알린 역 재발사 차단.
 *
 * `stationPassedFiredKey`는 trainCode 단위라 lock이 A→B로 바뀌면 A로 이미 알린 역이 B로 다시
 * 발사됐다. `Trip.lockCodeHistory`(이전 lock trainCode, cap)를 dedup 조회에 합친다.
 *
 * 구성: (1) station-passed dedup 4개 사이트 (2) same-session register carry/append/새 세션 소거
 * (3) leg 전환(환승 release) 시 소거 (4) cap 헬퍼.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { ARRIVAL_CODE } from '../alarm';
import { appendLockCodeHistory, LOCK_CODE_HISTORY_MAX } from '../lockSwap';
import {
  createEmptyScheduledStats,
  fireArvlCdStationPush,
  fireSyncSkippedStationPasses,
  fireVanishFallbackStationPush,
  runMidCycleFireOnly,
  stationPassedFiredKey,
  type ScheduledDeps,
  type ScheduledStats,
} from '../scheduled';
import { SeoulArrivalClient, type ArrivalEntry } from '../seoul';
import { getTrip, putTrip } from '../trips';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: pem, bundleId: 'com.example.app' };
});

beforeEach(() => resetApnsJwtCache());

const NOW = 1_700_000_000_000;
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;
const TOKEN = 'tok-3141';
// 10/20·10/21 실측 renumber 쌍(성수 3009→3045).
const OLD_CODE = '3009';
const NEW_CODE = '3045';
const STATION = '건대입구';

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

function makeLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: NEW_CODE,
    line: '2',
    subwayId: '1002',
    selectedDepartureTime: NOW,
    segmentStations: [STATION, '성수', '뚝섬'],
    expiresAt: NOW + 60 * 60_000,
    ...overrides,
  };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: TOKEN,
    route: { type: 'direct', line: '2', stops: 2 },
    destination: '뚝섬',
    waypoints: [
      { stationName: STATION, line: '2', kind: 'intermediate' },
      { stationName: '성수', line: '2', kind: 'intermediate' },
      { stationName: '뚝섬', line: '2', kind: 'destination' },
    ],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW - 60_000,
    boardingLock: makeLock(),
    lockCodeHistory: [OLD_CODE],
    ...overrides,
  };
}

const makeStats = (): ScheduledStats => createEmptyScheduledStats(NOW);

function seoulWith(arrivals: ArrivalEntry[]): SeoulArrivalClient {
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

const ENTERING: ArrivalEntry = {
  trainCode: NEW_CODE,
  arrivalSeconds: 30,
  isUp: true,
  destination: '성수',
  subwayNm: '2호선',
  arvlCd: ARRIVAL_CODE.ENTERING,
};

describe('#3141 station-passed dedup — 이전 lock 번호로 이미 알린 역은 새 번호로 재발사되지 않는다', () => {
  let kv: InMemoryKV;
  let apnsFetch: ReturnType<typeof vi.fn>;
  const apnsDeps = (): ScheduledDeps =>
    ({
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    }) as ScheduledDeps;

  beforeEach(() => {
    kv = new InMemoryKV(() => NOW);
    apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
  });

  describe('사이트 2 — runMidCycleFireOnly', () => {
    const run = async (trip: Trip) =>
      runMidCycleFireOnly(
        makeEnv(kv),
        [{ trip, waypoint: trip.waypoints[0], lock: trip.boardingLock! }],
        {
          seoul: seoulWith([ENTERING]),
          apnsConfig,
          apnsHosts: APNS_HOSTS,
          fetchImpl: apnsFetch as unknown as typeof fetch,
        },
        NOW,
        () => undefined,
        () => 'push-1',
      );

    it('A로 이미 알린 역 → B 전환 후 재발사 0', async () => {
      await kv.put(stationPassedFiredKey(TOKEN, OLD_CODE, STATION), '1');
      const stats = await run(makeTrip());
      expect(stats.fired).toBe(0);
      expect(apnsFetch).not.toHaveBeenCalled();
    });

    it('거부 케이스 — 아직 알리지 않은 역은 B로 정상 발사', async () => {
      const stats = await run(makeTrip());
      expect(stats.fired).toBe(1);
    });

    it('거부 케이스 — history에 없는 번호로 알린 키는 dedup하지 않는다', async () => {
      await kv.put(stationPassedFiredKey(TOKEN, '9999', STATION), '1');
      const stats = await run(makeTrip());
      expect(stats.fired).toBe(1);
    });
  });

  describe('사이트 1 — fireArvlCdStationPush', () => {
    const inputs = (trip: Trip, stats: ScheduledStats) => ({
      trip,
      waypoint: trip.waypoints[0],
      lock: trip.boardingLock!,
      env: makeEnv(kv),
      deps: apnsDeps(),
      stats,
      now: NOW,
      log: () => undefined,
      generatePushId: () => 'p-1',
      arvlCd: ARRIVAL_CODE.ENTERING,
    });

    it('A로 이미 알린 역 → dedup skip (arvlCdFireDedup=1, push 0)', async () => {
      await kv.put(stationPassedFiredKey(TOKEN, OLD_CODE, STATION), '1');
      const stats = makeStats();
      const res = await fireArvlCdStationPush(inputs(makeTrip(), stats));
      expect(res.dirty).toBe(false);
      expect(stats.arvlCdFireDedup).toBe(1);
      expect(apnsFetch).not.toHaveBeenCalled();
    });

    it('거부 케이스 — 미발사 역은 발사된다', async () => {
      const stats = makeStats();
      await fireArvlCdStationPush(inputs(makeTrip(), stats));
      expect(stats.arvlCdFireDedup).toBe(0);
      expect(stats.arvlCdFireSuccess).toBe(1);
    });
  });

  describe('사이트 4 — fireVanishFallbackStationPush', () => {
    const inputs = (trip: Trip, stats: ScheduledStats) => ({
      trip,
      waypoint: trip.waypoints[0],
      lock: trip.boardingLock!,
      env: makeEnv(kv),
      deps: apnsDeps(),
      stats,
      now: NOW,
      log: () => undefined,
      generatePushId: () => 'p-1',
      origin: 'vanish-fallback' as const,
    });

    it('A로 이미 알린 역 → push 0', async () => {
      await kv.put(stationPassedFiredKey(TOKEN, OLD_CODE, STATION), '1');
      await fireVanishFallbackStationPush(inputs(makeTrip(), makeStats()));
      expect(apnsFetch).not.toHaveBeenCalled();
    });

    it('거부 케이스 — 미발사 역은 발사된다', async () => {
      await fireVanishFallbackStationPush(inputs(makeTrip(), makeStats()));
      expect(apnsFetch).toHaveBeenCalled();
    });
  });

  describe('사이트 3 — fireSyncSkippedStationPasses', () => {
    const run = async (trip: Trip) =>
      fireSyncSkippedStationPasses(
        makeEnv(kv),
        trip,
        [trip.waypoints[0]],
        trip.boardingLock!,
        { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: apnsFetch as unknown as typeof fetch },
        NOW,
        () => undefined,
        () => 'p-1',
      );

    it('A로 이미 알린 역 → dedupSkipped=1, fired=0', async () => {
      await kv.put(stationPassedFiredKey(TOKEN, OLD_CODE, STATION), '1');
      const stats = await run(makeTrip());
      expect(stats.dedupSkipped).toBe(1);
      expect(stats.fired).toBe(0);
    });

    it('거부 케이스 — 미발사 역은 발사된다', async () => {
      const stats = await run(makeTrip());
      expect(stats.dedupSkipped).toBe(0);
      expect(stats.fired).toBe(1);
    });
  });
});

describe('#3141 same-session register — lockCodeHistory carry / append / 새 세션 소거', () => {
  const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    token: TOKEN,
    route: { type: 'direct', line: '2', stops: 2 },
    destination: '뚝섬',
    waypoints: [
      { stationName: STATION, line: '2', kind: 'intermediate' },
      { stationName: '성수', line: '2', kind: 'intermediate' },
      { stationName: '뚝섬', line: '2', kind: 'destination' },
    ],
    expiresAt: Date.now() + 60 * 60_000,
    alarmAtEpochMs: NOW,
    createdAt: NOW,
    ...extra,
  });
  const post = (env: Env, payload: Record<string, unknown>) =>
    app.fetch(
      new Request('http://example.com/trips', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      env,
    );
  const live = (overrides: Partial<Trip> = {}): Trip =>
    makeTrip({ expiresAt: Date.now() + 60 * 60_000, ...overrides });

  it('lock 없이 재등록(GPS update)해도 history가 운반된다', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, live());
    expect((await post(makeEnv(kv), body())).status).toBe(200);
    const stored = await getTrip(kv as unknown as KVNamespace, TOKEN);
    expect(stored?.lockCodeHistory).toEqual([OLD_CODE]);
  });

  it('incoming lock이 다른 trainCode로 교체하면 old code가 append된다', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, live({ lockCodeHistory: undefined }));
    const res = await post(makeEnv(kv), body({ boardingLock: makeLock({ trainCode: '3048' }) }));
    expect(res.status).toBe(200);
    const stored = await getTrip(kv as unknown as KVNamespace, TOKEN);
    expect(stored?.boardingLock?.trainCode).toBe('3048');
    expect(stored?.lockCodeHistory).toEqual([NEW_CODE]);
  });

  it('거부 케이스 — 같은 trainCode 재송신은 history를 늘리지 않는다', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, live({ lockCodeHistory: undefined }));
    await post(makeEnv(kv), body({ boardingLock: makeLock() }));
    const stored = await getTrip(kv as unknown as KVNamespace, TOKEN);
    expect(stored?.lockCodeHistory ?? []).toEqual([]);
  });

  it('trip 종료 후 같은 token의 새 세션 등록은 history를 이어받지 않는다', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, live());
    // createdAt drift > 5s → 새 세션 판정.
    expect((await post(makeEnv(kv), body({ createdAt: NOW + 60_000 }))).status).toBe(200);
    const stored = await getTrip(kv as unknown as KVNamespace, TOKEN);
    expect(stored?.lockCodeHistory).toBeUndefined();
  });
});

describe('#3141 leg 전환(환승 release) — history 소거', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('7→2 환승 통과로 lock이 release되면 leg-1의 history가 소거된다', async () => {
    const kv = new InMemoryKV();
    const trip: Trip = {
      token: 'tok-3141-leg',
      route: {
        type: 'transfer',
        fromLine: '7',
        toLine: '2',
        transferName: '건대입구',
        stops: 7,
        stopsToTransfer: 5,
        stopsFromTransfer: 2,
      } as unknown as Trip['route'],
      destination: '뚝섬',
      waypoints: [
        { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
        { stationName: '건대입구', line: '7', kind: 'transfer' },
        { stationName: '성수', line: '2', kind: 'intermediate' },
        { stationName: '뚝섬', line: '2', kind: 'destination' },
      ],
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW - 10 * 60_000,
      alarmAtEpochMs: NOW,
      infoModeEnabled: true,
      boardingLock: makeLock({
        trainCode: '7035',
        line: '7',
        subwayId: '1007',
        segmentStations: ['군자(능동)', '건대입구'],
      }),
      lockCodeHistory: ['7001'],
    };
    await putTrip(kv as unknown as KVNamespace, trip);
    const res = await app.fetch(
      new Request('http://example.com/boarding-lock/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: trip.token,
          observedStationName: '건대입구',
          observedAtMs: NOW,
          accuracy: 20,
        }),
      }),
      makeEnv(kv),
    );
    expect(res.status).toBe(200);
    const after = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(after?.boardingLock).toBeUndefined();
    expect(after?.lockCodeHistory).toBeUndefined();
  });
});

describe('#3141 appendLockCodeHistory', () => {
  it('끝에 append하고 cap 초과 시 가장 오래된 것부터 버린다', () => {
    let h: string[] | undefined;
    for (let i = 0; i < LOCK_CODE_HISTORY_MAX + 2; i += 1) h = appendLockCodeHistory(h, `c${i}`);
    expect(h).toHaveLength(LOCK_CODE_HISTORY_MAX);
    expect(h?.[h.length - 1]).toBe(`c${LOCK_CODE_HISTORY_MAX + 1}`);
    expect(h).not.toContain('c0');
  });

  it('중복 코드는 다시 넣지 않는다', () => {
    expect(appendLockCodeHistory(['a'], 'a')).toEqual(['a']);
  });
});
