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
 * 재현한다: lock 열차(3174)가 피드에서 소실 → vanish swap이 새 열차로 swap하지만
 * `trip.boardingLock`을 in-memory에만 반영 → 직후 fire/advance 평가가 KV를 재독해 stale lock을
 * 보고 blocked(env-consensus-fail) → blocked 분기는 putTrip 없이 return → swap 자체가 매 tick
 * 소실된다.
 *
 * fixture 데이터는 실측 — 통과시키기 위해 조정하지 않는다.
 *
 * #2879 (판정 교정, 메인 세션 코멘트 "판정 교정" 2026-10-06) — 원래 이 fixture는 #2871(2호선
 * 방향 역전 수정) 이전에 "2182 오선택 버그"만 특성화하려고 **반대방향 후보 1대(2182, 내선)만**
 * 넣은 합성 최소본이었다. #2871 머지 후 `inferLegDirection('2','신당','을지로입구')`가 정답인
 * 외선('down')을 반환하게 되자, 반대방향 후보뿐인 이 최소본은 swap 후보가 0건이 되어
 * `attachTrainCodeForLeg`가 null을 반환 — swap 자체가 실패하고 #2869가 고친 "신당 고착"이
 * 재발하는 것처럼 보였다(구현 에이전트 1차 보고). 그러나 13:33:24 R2 원본 캡처에는 외선 정답
 * 후보가 실존한다: arrivals@신당 `3203 updnLine=외선 arvlCd=5(전역도착)` + position
 * `3203@상왕십리 trainSttus=1(도착) updnLine='1'(외선)` — 두 신호가 "3203이 신당 한 정거장
 * 전인 상왕십리에 막 도착"이라는 동일 사실을 가리켜 상호 정합. 처분(개선, 기대값 교정 아닌
 * **보강**):
 *   1. 기존 2182 rows는 그대로 유지하고 실캡처의 3203 rows를 **추가**한다(삭제·수정 아님) —
 *      swap이 3203으로 성공하는 것으로 기존 메커니즘 assert(영속·bypass 통과·재swap 없음·
 *      재발사 0)를 trainCode=3203 기준으로 재확인한다(아래 메인 describe).
 *   2. 2182만 있는 원래 최소본(반대방향 단일 후보)은 **별도 부정 케이스**로 보존한다 —
 *      swap=null(역방향 후보 거부) + wrong-direction lock 불생성 + swap-fail D1 전이 기록을
 *      assert해 #2871의 방향 봉쇄 보장이 회귀하지 않는지 가드한다(아래 "#2869 부정 케이스").
 *
 * 1번 fixture로 실측 재생 시 `estimate.arrived`가 즉시 true가 되지 않는다 — 3203은 아직 신당이
 * 아니라 상왕십리에 있으므로, 이번 tick은 swap만 성공하고(persist) 실제 waypoint advance(신당
 * 통과)는 다음 tick(열차가 신당에 도달한 시점)에서 일어난다. 이는 원래 합성 최소본(2182가
 * 신당에 "이미" 도착한 것으로 둔)과 다른 물리적 전제이므로, advance 관련 assert는 그 시점
 * 차이를 반영해 재구성했다 — swap 자체의 영속/bypass/재시도 없음 불변은 무변경.
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

/**
 * 신당 vanish swap Seoul mock.
 *
 * 항상 포함: `2182@신당(내선, trainSttus=1)` — #2869 원 합성 최소본의 반대방향 후보. 역방향
 * 거부 메커니즘(#2871)을 증명하려면 이 후보만으로는 swap이 성립하지 않아야 한다.
 *
 * `includeOuterCandidate=true`(기본, 메인 describe)면 13:33:24 R2 캡처의 외선 정답 후보를
 * **추가**한다(2182 rows 삭제·수정 아님) — arrivals@신당 `3203 updnLine=외선 arvlCd=5(전역도착)`
 * + position `3203@상왕십리 trainSttus=1(도착) updnLine='1'(외선)`. `inferLegDirection`이
 * '신당'→'을지로입구'를 외선('down')으로 판정하므로 3203만 방향 필터를 통과한다.
 *
 * `includeOuterCandidate=false`(부정 케이스)면 2182만 남아 #2871 이전의 "반대방향 단일 후보"
 * 합성 최소본과 동일 — swap이 null로 귀결되는지(역방향 거부) 검증한다.
 */
function makeSindangSeoul(includeOuterCandidate: boolean = true): SeoulArrivalClient {
  const positions: Array<Partial<PositionEntry> & { trainCode: string }> = [
    { trainCode: '2182', stationName: '신당', trainSttus: 1, isUp: true },
    ...(includeOuterCandidate
      ? [{ trainCode: '3203', stationName: '상왕십리', trainSttus: 1, isUp: false }]
      : []),
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
      // arrivals — 2182는 피드 소실 그대로(빈 배열). includeOuterCandidate면 3203(13:33:24
      // 실캡처 외선 정답 후보, 전역도착)을 추가한다. 아래는 parse 전 raw Seoul API payload
      // 모양(btrainNo/updnLine 등)이라 ArrivalEntry(parse 후 타입)로 satisfies하지 않는다.
      return new Response(
        JSON.stringify({
          realtimeArrivalList: includeOuterCandidate
            ? [
                {
                  btrainNo: '3203',
                  updnLine: '외선',
                  arvlCd: 5,
                  barvlDt: '90',
                  subwayNm: '지하철2호선',
                },
              ]
            : [],
        }),
        { status: 200 },
      );
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

  it('red 1 — tick 1 직후 KV trip.boardingLock.trainCode가 swap된 값(3203, 외선 정답)으로 영속된다', async () => {
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
    expect(stored?.boardingLock?.trainCode).toBe('3203');
  });

  it('red 2 — tick 1의 swap이 env-consensus-fail로 blocked되지 않는다 (evidence.trainCode===lock.trainCode bypass)', async () => {
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

    // blocked됐다면 boardingLockWaypointAdvanceBlocked가 증가한다 — 이번 tick은 swap된 새
    // lock(3203)으로 즉시 재평가되므로 stale-lock env-consensus-fail 분기 자체를 타지 않는다
    // (#2869 C 수정 그대로 유지).
    expect(stats.boardingLockWaypointAdvanceBlocked).toBe(0);
    // 3203은 실캡처상 아직 신당이 아니라 한 정거장 전 상왕십리에 있다(arrivals arvlCd=5
    // 전역도착 + position@상왕십리 상호 정합) — 이번 tick은 swap만 성공하고 SSoT는 아직
    // 전진하지 않는다. 다음 tick(열차가 신당에 도달)에서 advance가 일어난다(아래 red 3).
    const ssotAfter = await readSsot(kv as unknown as KVNamespace, TOKEN);
    expect(ssotAfter?.currentStationId).toBe('상왕십리');
  });

  it('red 3 — tick 2(열차가 신당에 도달)에서 swap 재시도 없이 advance + 매역 발사가 1회 일어난다', async () => {
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

    // tick 2 — trip/ssot를 KV에서 재조회(실 cron 재진입과 동일).
    const tripTick2 = await getTrip(kv as unknown as KVNamespace, TOKEN);
    expect(tripTick2).not.toBeNull();
    // 사전 조건(tick1 결과물) — swap은 영속됐지만 아직 신당 advance 전(red 2와 동일 근거).
    expect(tripTick2!.boardingLock?.trainCode).toBe('3203');
    expect(tripTick2!.waypoints[0]?.stationName).toBe('신당');
    const ssotTick2 = await readSsot(kv as unknown as KVNamespace, TOKEN);
    // 60초 후(실측 hop 기준) 3203이 신당에 도착(ARRIVED) — 다음 cron 관측.
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
                  trainNo: '3203',
                  statnNm: '신당',
                  trainSttus: 1,
                  updnLine: '1',
                  lastRecptnDt: '',
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            realtimeArrivalList: [
              { btrainNo: '3203', updnLine: '외선', arvlCd: 1, barvlDt: '0', subwayNm: '지하철2호선' },
            ],
          }),
          { status: 200 },
        );
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

    // vanish 경로로 재진입했다면 vanishFallbackFired가 증가한다 — swap 재시도 없음 확인.
    expect(statsTick2.vanishFallbackFired).toBe(0);
    expect(stats.vanishFallbackFired).toBe(vanishFiredAfterTick1);
    // lock은 재swap 없이 3203 그대로, waypoint는 신당을 통과해 다음 역으로 전진.
    expect(tripTick2!.boardingLock?.trainCode).toBe('3203');
    expect(tripTick2!.waypoints[0]?.stationName).toBe('동대문역사문화공원');
    const ssotAfterTick2 = await readSsot(kv as unknown as KVNamespace, TOKEN);
    expect(ssotAfterTick2?.currentStationId).toBe('신당');

    const stationFiredKey = stationPassedFiredKey(TOKEN, '3203', '신당');
    const alreadyFiredCount = (await kv.get(stationFiredKey)) !== null ? 1 : 0;
    // 신당 역은 tick2에서 정확히 1회 발사.
    expect(alreadyFiredCount).toBe(1);
  });
});

describe('#2869 부정 케이스 — 반대방향 단일 후보(2182)만 있으면 swap이 거부된다 (#2871 방향 봉쇄 회귀 가드)', () => {
  let kv: InMemoryKV;

  beforeEach(async () => {
    kv = new InMemoryKV();
    await seedSsot(kv as unknown as KVNamespace, TOKEN, '상왕십리', { expiresAt: NOW + 60 * 60_000 });
    await seedSelfPoll(kv, NOW);
  });

  it('swap=null — wrong-direction(2182, 내선) 단일 후보는 lock으로 채택되지 않고 기존 lock(3174)이 유지된다', async () => {
    const trip = makeSindangTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    const deps = makeDeps(
      makeSindangSeoul(false),
      (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    );
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
      () => 'pid-2869-neg',
      await readSsot(kv as unknown as KVNamespace, TOKEN),
    );

    const stored = await getTrip(kv as unknown as KVNamespace, TOKEN);
    // wrong-direction lock이 절대 생기지 않는다 — 원래(소실된) lock이 그대로 유지.
    expect(stored?.boardingLock?.trainCode).toBe('3174');
  });

  it('swap-fail D1 전이 — estimate-null + swap-attempt(failed=true)가 trip_events에 기록된다', async () => {
    const trip = makeSindangTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    const { db, inserts } = makeFireLogDb();
    const deps = makeDeps(
      makeSindangSeoul(false),
      (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    );
    const stats = createEmptyScheduledStats(NOW);

    await runTrainCodeTracking(
      trip,
      trip.waypoints[0],
      trip.boardingLock!,
      makeEnv(kv, db),
      deps,
      stats,
      NOW,
      () => {},
      () => 'pid-2869-neg-d1',
      await readSsot(kv as unknown as KVNamespace, TOKEN),
    );

    const vanishSwapRows = inserts.filter((args) => args.includes('vanish-swap'));
    const phases = vanishSwapRows.map((args) => JSON.parse(String(args[5])).phase as string);
    expect(phases.sort()).toEqual(['estimate-null', 'swap-attempt']);
    const swapAttemptRow = vanishSwapRows.find(
      (args) => JSON.parse(String(args[5])).phase === 'swap-attempt',
    );
    expect(JSON.parse(String(swapAttemptRow?.[5])).failed).toBe(true);
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
