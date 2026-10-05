import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import {
  VANISH_RE_ATTACH_THRESHOLD,
  createEmptyScheduledStats,
  runTrainCodeTracking,
  stationPassedFiredKey,
  type ScheduledDeps,
} from '../scheduled';
import { SeoulArrivalClient, type ArrivalEntry, type PositionEntry } from '../seoul';
import { writeSelfPollPosition } from '../selfPollPosition';
import { getTrip, putTrip } from '../trips';
import { readSsot, seedSsot } from '../tripPositionSsot';
import type { Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

/**
 * #2869 — 10/3 신당 고착 RCA red-first fixture.
 *
 * 실측(R2 seoul-capture/2026-10-03/1791002004417.json, trip D1 trip_events) 메커니즘을 그대로
 * 재현한다: lock 열차(3174)가 피드에서 소실 → vanish swap이 새 열차(2182)로 swap하지만
 * `trip.boardingLock`을 in-memory에만 반영 → 직후 fire/advance 평가가 KV를 재독해 stale lock을
 * 보고 blocked(env-consensus-fail) → blocked 분기는 putTrip 없이 return → swap 자체가 매 tick
 * 소실된다.
 *
 * fixture 데이터는 이슈 본문 발췌(실측) — 통과시키기 위해 조정하지 않는다.
 */

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: pem, bundleId: 'com.example.app' };
});

beforeEach(() => resetApnsJwtCache());

const NOW = 1_700_000_000_000;
const TOKEN = 'tok-2869-sindang';
const LINE = '2';

const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;

function makeEnv(kv: InMemoryKV, db?: D1Database): Env {
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
    DB: db,
  };
}

function makeFireLogDb(): { db: D1Database; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => {
        inserts.push(args);
        return { run: async () => ({ success: true }), first: async () => null };
      },
    }),
  } as unknown as D1Database;
  return { db, inserts };
}

/** 신당(2호선) 이후 leg — 이슈 본문 fixture waypoints/segmentStations 그대로. */
const WAYPOINTS: Waypoint[] = [
  { stationName: '신당', line: LINE, kind: 'intermediate' },
  { stationName: '동대문역사문화공원', line: LINE, kind: 'intermediate' },
  { stationName: '을지로4가', line: LINE, kind: 'intermediate' },
  { stationName: '을지로3가', line: LINE, kind: 'intermediate' },
  { stationName: '을지로입구', line: LINE, kind: 'destination' },
];

const OLD_LOCK_SEGMENT_STATIONS = [
  '성수', '뚝섬', '한양대', '왕십리', '상왕십리',
  '신당', '동대문역사문화공원', '을지로4가', '을지로3가', '을지로입구',
];

function makeSindangTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: TOKEN,
    route: { type: 'direct', line: LINE, stops: 9 },
    destination: '을지로입구',
    waypoints: WAYPOINTS,
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW + 60_000,
    promptOptIn: true,
    boardingLock: {
      trainCode: '3174',
      line: LINE,
      subwayId: '1002',
      selectedDepartureTime: NOW,
      segmentStations: OLD_LOCK_SEGMENT_STATIONS,
      expiresAt: NOW + 60 * 60_000,
    },
    // VANISH_RE_ATTACH_THRESHOLD(2) - 1 → 이번 tick이 swap 임계 도달.
    consecutiveEtaMissing: VANISH_RE_ATTACH_THRESHOLD - 1,
    lastTrackedArrivalEpoch: NOW - 60_000,
    ...overrides,
  };
}

/** 2182 swap 후보가 신당에서 잡히는 Seoul mock — arrivals는 old/new 모두 빈 응답(피드 소실),
 * positions은 2182가 신당에 정차(ARRIVED)해 있다고 보고한다. */
function makeSindangSeoul(): SeoulArrivalClient {
  const positions: Array<Partial<PositionEntry> & { trainCode: string }> = [
    { trainCode: '2182', stationName: '신당', trainSttus: 1, isUp: true },
  ];
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
              updnLine: p.isUp === false ? '1' : '0',
              lastRecptnDt: '',
            })),
          }),
          { status: 200 },
        );
      }
      // arrivals는 어느 역을 조회하든 빈 배열 — 3174/2182 모두 arrivals 경로에서는 보이지 않음
      // (positions fallback으로만 swap/재estimate가 성립하는 시나리오).
      return new Response(JSON.stringify({ realtimeArrivalList: [] satisfies ArrivalEntry[] }), {
        status: 200,
      });
    }) as unknown as typeof fetch,
  });
}

async function seedSelfPoll(kv: InMemoryKV, now: number): Promise<void> {
  const entry: PositionEntry[] = [
    { trainCode: '2182', stationName: '신당', trainSttus: 1, isUp: true, recptnMs: now },
  ];
  await writeSelfPollPosition(kv as unknown as KVNamespace, LINE, entry, now);
}

function makeDeps(seoul: SeoulArrivalClient, fetchImpl: typeof fetch): ScheduledDeps {
  return { seoul, apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl, archFlag: 'off' };
}

describe('#2869 — vanish swap KV persist + stale-lock env-consensus bypass (신당 10/3 고착 RCA)', () => {
  let kv: InMemoryKV;

  beforeEach(async () => {
    kv = new InMemoryKV();
    await seedSsot(kv as unknown as KVNamespace, TOKEN, '상왕십리', { expiresAt: NOW + 60 * 60_000 });
    await seedSelfPoll(kv, NOW);
  });

  it('red 1 — tick 1 직후 KV trip.boardingLock.trainCode가 swap된 값(2182)으로 영속된다', async () => {
    const trip = makeSindangTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    const deps = makeDeps(makeSindangSeoul(), (async () => new Response('', { status: 200 })) as unknown as typeof fetch);
    const stats = createEmptyScheduledStats(NOW);

    await runTrainCodeTracking(
      trip,
      trip.waypoints[0],
      trip.boardingLock!,
      makeEnv(kv),
      deps,
      stats,
      NOW,
      () => {},
      () => 'pid-2869-t1',
      await readSsot(kv as unknown as KVNamespace, TOKEN),
    );

    const stored = await getTrip(kv as unknown as KVNamespace, TOKEN);
    expect(stored?.boardingLock?.trainCode).toBe('2182');
  });

  it('red 2 — tick 1의 advance가 env-consensus-fail로 blocked되지 않는다 (evidence.trainCode===lock.trainCode bypass)', async () => {
    const trip = makeSindangTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    const deps = makeDeps(makeSindangSeoul(), (async () => new Response('', { status: 200 })) as unknown as typeof fetch);
    const stats = createEmptyScheduledStats(NOW);

    await runTrainCodeTracking(
      trip,
      trip.waypoints[0],
      trip.boardingLock!,
      makeEnv(kv),
      deps,
      stats,
      NOW,
      () => {},
      () => 'pid-2869-t1b',
      await readSsot(kv as unknown as KVNamespace, TOKEN),
    );

    // blocked됐다면 boardingLockWaypointAdvanceBlocked가 증가하고 SSoT currentStationId가
    // 신당으로 전진하지 못한다. 고쳐진 상태에서는 advance가 통과해 신당으로 전진한다.
    expect(stats.boardingLockWaypointAdvanceBlocked).toBe(0);
    const ssotAfter = await readSsot(kv as unknown as KVNamespace, TOKEN);
    expect(ssotAfter?.currentStationId).toBe('신당');
  });

  it('red 3 — tick 2에서는 vanish swap 재시도가 발생하지 않고 동일 역 재발사도 없다', async () => {
    const trip = makeSindangTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const deps = makeDeps(makeSindangSeoul(), fetchImpl);
    const stats = createEmptyScheduledStats(NOW);

    await runTrainCodeTracking(
      trip,
      trip.waypoints[0],
      trip.boardingLock!,
      makeEnv(kv),
      deps,
      stats,
      NOW,
      () => {},
      () => 'pid-2869-t2a',
      await readSsot(kv as unknown as KVNamespace, TOKEN),
    );
    const vanishFiredAfterTick1 = stats.vanishFallbackFired;

    // tick 2 — trip/ssot를 KV에서 재조회(실 cron 재진입과 동일). 다음 waypoint
    // (동대문역사문화공원)에서 2182가 아직 진입 전(ENTERING)이라고 응답 → estimate!==null이라
    // vanish swap 경로 자체에 진입하지 않는다.
    const tripTick2 = await getTrip(kv as unknown as KVNamespace, TOKEN);
    expect(tripTick2).not.toBeNull();
    // 사전 조건(tick1 결과물) — runTrainCodeTracking이 tripTick2를 in-place mutate하기 전에
    // 먼저 확인해야 red 1/2와 같은 근거(swap 영속 + advance 통과)로 red가 된다.
    expect(tripTick2!.boardingLock?.trainCode).toBe('2182');
    expect(tripTick2!.waypoints[0]?.stationName).toBe('동대문역사문화공원');
    const ssotTick2 = await readSsot(kv as unknown as KVNamespace, TOKEN);
    const seoulTick2 = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW + 60_000,
      fetchImpl: (async (url: string) => {
        if (url.includes('/realtimePosition/')) {
          return new Response(
            JSON.stringify({
              realtimePositionList: [
                {
                  trainNo: '2182',
                  statnNm: '동대문역사문화공원',
                  trainSttus: 0,
                  updnLine: '0',
                  lastRecptnDt: '',
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ realtimeArrivalList: [] satisfies ArrivalEntry[] }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });
    const depsTick2 = makeDeps(seoulTick2, fetchImpl);
    const statsTick2 = createEmptyScheduledStats(NOW + 60_000);

    await runTrainCodeTracking(
      tripTick2!,
      tripTick2!.waypoints[0],
      tripTick2!.boardingLock!,
      makeEnv(kv),
      depsTick2,
      statsTick2,
      NOW + 60_000,
      () => {},
      () => 'pid-2869-t2b',
      ssotTick2,
    );

    // vanish 경로로 진입했다면 consecutiveEtaMissing이 다시 쌓이거나 vanishFallbackFired가
    // 증가한다 — 둘 다 0/변동없음이어야 "swap 재시도 없음"이 성립.
    expect(statsTick2.vanishFallbackFired).toBe(0);
    expect(tripTick2!.boardingLock?.trainCode).toBe('2182');
    expect(stats.vanishFallbackFired).toBe(vanishFiredAfterTick1);

    const stationFiredKey = stationPassedFiredKey(TOKEN, '2182', '신당');
    const alreadyFiredCount = (await kv.get(stationFiredKey)) !== null ? 1 : 0;
    // 신당 역은 tick1에서 최대 1회만 발사 — tick2가 같은 역을 재발사하지 않았는지 간접 확인
    // (stationFiredKey는 tick1에서 stamp됐어야 하며, tick2는 다른 역을 다룬다).
    expect(alreadyFiredCount).toBe(1);
  });
});

describe('#2869 E — vanish estimate-null / swap-fail D1 전이 계측 (중복 기록 없음)', () => {
  const TOKEN_E = 'tok-2869-estimate-null';
  const LINE7 = '7';

  function makeNoCandidateTrip(overrides: Partial<Trip> = {}): Trip {
    return {
      token: TOKEN_E,
      route: { type: 'direct', line: LINE7, stops: 2 },
      destination: '군자',
      waypoints: [
        { stationName: '중곡', line: LINE7, kind: 'intermediate' },
        { stationName: '군자', line: LINE7, kind: 'destination' },
      ],
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW,
      alarmAtEpochMs: NOW + 60_000,
      promptOptIn: true,
      boardingLock: {
        trainCode: '7246',
        line: LINE7,
        subwayId: '1007',
        selectedDepartureTime: NOW,
        segmentStations: ['용마산', '중곡', '군자'],
        expiresAt: NOW + 60 * 60_000,
      },
      consecutiveEtaMissing: VANISH_RE_ATTACH_THRESHOLD - 1,
      ...overrides,
    };
  }

  function makeEmptySeoul(now: () => number): SeoulArrivalClient {
    return new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now,
      fetchImpl: (async (url: string) => {
        if (url.includes('/realtimePosition/')) {
          return new Response(JSON.stringify({ realtimePositionList: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ realtimeArrivalList: [] satisfies ArrivalEntry[] }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });
  }

  it('red 4 — estimate-null + swap-fail 전이가 각 1회만 D1에 기록되고 반복 tick에 중복 기록이 없다', async () => {
    const kv = new InMemoryKV();
    await seedSsot(kv as unknown as KVNamespace, TOKEN_E, '용마산', { expiresAt: NOW + 60 * 60_000 });
    const trip = makeNoCandidateTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    const { db, inserts } = makeFireLogDb();
    const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    const tick = async (now: number, pushId: string) => {
      const currentTrip = (await getTrip(kv as unknown as KVNamespace, TOKEN_E))!;
      const currentSsot = await readSsot(kv as unknown as KVNamespace, TOKEN_E);
      const deps = makeDeps(makeEmptySeoul(() => now), fetchImpl);
      const stats = createEmptyScheduledStats(now);
      await runTrainCodeTracking(
        currentTrip,
        currentTrip.waypoints[0],
        currentTrip.boardingLock!,
        makeEnv(kv, db),
        deps,
        stats,
        now,
        () => {},
        () => pushId,
        currentSsot,
      );
    };

    await tick(NOW, 'pid-e-t1');
    const vanishSwapRowsAfterTick1 = inserts.filter((args) => args.includes('vanish-swap'));
    expect(vanishSwapRowsAfterTick1.length).toBe(2); // estimate-null 1건 + swap-attempt(failed) 1건

    await tick(NOW + 60_000, 'pid-e-t2');
    const vanishSwapRowsAfterTick2 = inserts.filter((args) => args.includes('vanish-swap'));
    // 같은 상태가 반복되는 tick2는 전이가 없으므로 추가 기록이 없어야 한다.
    expect(vanishSwapRowsAfterTick2.length).toBe(2);
  });
});
