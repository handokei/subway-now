/**
 * 2026-08-04 실탑승 dump + backend KV/D1 교차 분석 replay test (Issue #2145).
 *
 * 목적: 매 이슈 fix 후 실기기 verify 없이 오늘 시나리오 회귀 여부 자동 검증.
 * 기존 `evidence_20260703_replay.test.ts` 컨벤션(별도 fixture 파일 대신, 이번 evidence는
 * 규모가 작아 이 파일 안에 인라인 fixture로 표현) 재사용.
 *
 * 검증 대상 (2026-08-04 실탑승 dump + backend KV/D1 교차 분석):
 *   1. 20:06:21 이중 register race — 같은 token, payload가 다른(waypoints 2개 vs 5개) register
 *      2건 동시 요청 → KV 활성 trip 정확히 1개 (#2132 회귀 가드).
 *   2. geo 부재 무음 skip — promptGeoContext 없는 trip이 cron 1 tick 통과 →
 *      boardingPromptSkippedNoContext 증가 + prompt 미발사 (#2134).
 *   3. 반복 발사 정책 전체 시나리오 — 등록 근접 trip에 15분 창 동안 서로 다른 trainCode
 *      4대가 순차 arvlCd=1(5분 이상 간격) → 정확히 3발 후 4번째 차단, 같은 trainCode
 *      재관측 차단, 5분 미만 간격 차단, 스탬프 227m(자택) 차단, 스탬프 부재(지하) 발사 허용
 *      (#2142).
 *   4. 종료 정리 — trip DELETE 후 같은 token 재등록 시 stale tripStatus 부재.
 *      ※ #2144 PR 미머지 상태 — `it.todo`로 남긴다 (PR 본문에 명시, 충돌 금지).
 *
 * fixture 값 출처: 이슈 #2145 본문에 명시된 2026-08-04 실측 요약(토큰 prefix e25e1158 /
 * 9ff4d660, 시각 20:06:21, waypoint 2개/5개 구성, 스탬프 227m). 원본 raw dump/KV export
 * 자체는 이 replay 작성 시점에 첨부되지 않아 본문 명시 값만 fixture화했다 — 정확한 역명 등
 * dump 세부는 알 수 없어 waypoint "개수"만 evidence와 정합하게 재현한다.
 *
 * 동작 원칙: production 코드는 수정하지 않는다. 각 assertion은 관측 가능한 결과(KV 상태 /
 * counter / push 발사 수)만 검증 — 구현 세부(내부 함수 호출 여부 등)를 거울처럼 assert하지
 * 않는다.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { app } from '../index';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { ARCH_FLAG_KV_KEY } from '../archFlag';
import { putTrip } from '../trips';
import { runScheduled, type ScheduledDeps } from '../scheduled';
import { SeoulArrivalClient, type ArrivalEntry } from '../seoul';
import type { Env, Trip } from '../types';
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

const NOW = 1_785_841_581_000; // 2026-08-04T20:06:21+09:00 (KST) = 2026-08-04T11:06:21.000Z — 이슈 #2145 본문 명시 시각

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

async function post(path: string, body: unknown, env: Env): Promise<Response> {
  return app.fetch(
    new Request(`http://example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );
}

// ---------------------------------------------------------------------------
// Case 1 — 20:06:21 이중 register race (#2132 회귀 가드)
// ---------------------------------------------------------------------------

describe('evidence 2026-08-04 20:06:21 — 이중 register race (#2132)', () => {
  // 이슈 본문: "같은 토큰으로 payload가 다른(waypoint 2개 vs 5개 — 실제 KV에서 관측된
  // 두 형태) register 2건 동시 요청". 실 역명은 dump 미첨부라 count만 정합하게 재현.
  const TOKEN = 'e25e1158-evidence-tok';
  // validateTrip은 real wall clock(Date.now())으로 expiresAt을 검증한다 — evidence 재현용
  // 고정 NOW(2026-08-04 20:06:21)가 아닌 실행 시점 real time 기준으로 미래 시각을 잡는다.
  const FUTURE = Date.now() + 60 * 60 * 1000;

  function tripBodyWithWaypointCount(count: 2 | 5): Record<string, unknown> {
    const waypoints = Array.from({ length: count }, (_, i) => ({
      stationName: `station-${i}`,
      line: '2',
      kind: i === count - 1 ? 'destination' : 'transfer',
    }));
    return {
      token: TOKEN,
      route: { type: 'direct', line: '2', stops: count },
      destination: `dst-${count}`,
      waypoints,
      expiresAt: FUTURE,
      alarmAtEpochMs: FUTURE - 30 * 60 * 1000,
    };
  }

  it('동시 register 2건(같은 token, waypoints 2개 vs 5개) → KV 활성 trip 정확히 1개', async () => {
    const kv = new InMemoryKV();
    const env: Env = {
      TRIPS: kv as unknown as Env['TRIPS'],
      APNS_HOST: 'h',
      APNS_HOST_SANDBOX: 'hs',
      SEOUL_API_HOST: 'h',
      SEOUL_API_KEY: 'k',
      APNS_KEY_ID: 'k',
      APNS_TEAM_ID: 't',
      APNS_PRIVATE_KEY: 'p',
      APNS_BUNDLE_ID: 'b',
    };
    await kv.put(ARCH_FLAG_KV_KEY, 'on');

    const bodyTwoWaypoints = tripBodyWithWaypointCount(2);
    const bodyFiveWaypoints = tripBodyWithWaypointCount(5);

    const [resA, resB] = await Promise.all([
      post('/trips', bodyTwoWaypoints, env),
      post('/trips', bodyFiveWaypoints, env),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const allTripKeys = (await kv.list({ prefix: 'trip:' })).keys;
    // 두 요청 모두 성공 응답을 받아도, per-token 직렬화(withTripRegisterLock) 덕분에
    // KV에는 활성 trip이 정확히 1개만 남는다 — 원본 token 재사용이든 rotation으로 발급된
    // 새 UUID든, 유령 trip 2개 생존은 회귀.
    expect(allTripKeys.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — geo 부재 무음 skip (#2134)
// ---------------------------------------------------------------------------

describe('evidence 2026-08-04 — geo 부재 무음 skip (#2134)', () => {
  function makeNoGeoTrip(overrides: Partial<Trip> = {}): Trip {
    return {
      token: '9ff4d660-evidence-tok',
      route: { type: 'direct', line: '2', stops: 5 },
      destination: 'dst',
      // promptGeoContext / promptDisplay 둘 다 부재 — 이슈 본문 evidence 상태 재현.
      waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW,
      alarmAtEpochMs: NOW + 60_000,
      ...overrides,
    };
  }

  it('promptGeoContext 없는 trip이 cron 1 tick 통과 → boardingPromptSkippedNoContext +1, 발사 0건', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeNoGeoTrip());
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const deps: ScheduledDeps = {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl,
      generatePushId: () => 'evidence-push-1',
      archFlag: 'on',
    };

    const stats = await runScheduled(makeEnv(kv), deps);

    expect(stats.boardingPromptSkippedNoContext).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptEvaluated).toBe(0);
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Case 3 — 반복 발사 정책 전체 시나리오 (#2142)
// ---------------------------------------------------------------------------

describe('evidence 2026-08-04 — boarding-prompt 반복 발사 정책 전체 시나리오 (#2142)', () => {
  const TOKEN = 'repeat-fire-evidence-tok';
  const FIVE_MIN_MS = 5 * 60 * 1000;

  // 등록 근접(스탬프 150m 이내) — originDistanceM=50, originAccuracyM=10 (50-10=40 <= 150).
  function makeNearbyTrip(overrides: Partial<Trip> = {}): Trip {
    return {
      token: TOKEN,
      route: { type: 'direct', line: '2', stops: 5 },
      destination: 'dst',
      waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW,
      alarmAtEpochMs: NOW + 60_000,
      promptGeoContext: {
        origin: { lat: 0, lng: 0 },
        nextStation: { lat: 0, lng: 0.01 },
        direction: 'up',
        originDistanceM: 50,
        originAccuracyM: 10,
      },
      promptDisplay: { originStation: '강남', line: '2' },
      ...overrides,
    };
  }

  function arrivedTrain(trainCode: string): ArrivalEntry {
    return {
      destination: '성수',
      arrivalSeconds: 0,
      trainCode,
      isUp: true,
      subwayNm: '2호선',
      arvlCd: 1,
    };
  }

  function makeDeps(now: number, trainCode: string, pushId: string): ScheduledDeps {
    return {
      seoul: makeSeoul([arrivedTrain(trainCode)]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => now,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      generatePushId: () => pushId,
      archFlag: 'on',
    };
  }

  it('15분 창 내 서로 다른 trainCode 4대 arvlCd=1 (5분 간격) → 정확히 3발 후 4번째 max-fires 차단', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeNearbyTrip());
    const env = makeEnv(kv);

    const trainCodes = ['TR-A', 'TR-B', 'TR-C', 'TR-D'];
    const results: Array<{
      fired: number;
      blocked: number;
      maxFires: number;
    }> = [];

    for (let i = 0; i < trainCodes.length; i++) {
      const now = NOW + i * FIVE_MIN_MS;
      const stats = await runScheduled(env, makeDeps(now, trainCodes[i], `push-${i}`));
      results.push({
        fired: stats.boardingPromptFired,
        blocked: stats.boardingPromptBlocked,
        maxFires: stats.boardingPromptSkippedMaxFires,
      });
    }

    // 1~3번째 열차: 각 5분 간격 + 서로 다른 trainCode → 매번 발사.
    expect(results[0]).toEqual({ fired: 1, blocked: 0, maxFires: 0 });
    expect(results[1]).toEqual({ fired: 1, blocked: 0, maxFires: 0 });
    expect(results[2]).toEqual({ fired: 1, blocked: 0, maxFires: 0 });
    // 4번째: fireCount=3(MAX_FIRE_COUNT) 도달 → hard cap 차단. 15분 신선도 경계는 아직 안 넘음
    // (now - createdAt === 15분, stale 게이트는 "초과"만 차단하므로 여기 도달).
    expect(results[3]).toEqual({ fired: 0, blocked: 1, maxFires: 1 });

    const persisted = JSON.parse((await kv.get(`trip:${TOKEN}`))!);
    expect(persisted.boardingPromptState.fireCount).toBe(3);
    expect(persisted.boardingPromptState.firedTrainCodes).toEqual(['TR-A', 'TR-B', 'TR-C']);
  });

  it('같은 trainCode 재관측 → boardingPromptSkippedTrainDuplicate (반복 발사 대상 아님)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeNearbyTrip());
    const env = makeEnv(kv);

    // 1차 발사.
    await runScheduled(env, makeDeps(NOW, 'TR-SAME', 'push-0'));
    // 2차: 5분 후, 같은 trainCode 재관측.
    const stats = await runScheduled(env, makeDeps(NOW + FIVE_MIN_MS, 'TR-SAME', 'push-1'));

    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptSkippedTrainDuplicate).toBe(1);
  });

  it('5분 미만 간격 재발사 시도 → boardingPromptSkippedMinInterval', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeNearbyTrip());
    const env = makeEnv(kv);

    await runScheduled(env, makeDeps(NOW, 'TR-1', 'push-0'));
    // 2분 후 — 5분 최소 간격 미달. 다른 trainCode라 duplicate 게이트는 통과하지만
    // min-interval 게이트가 먼저 차단.
    const stats = await runScheduled(env, makeDeps(NOW + 2 * 60 * 1000, 'TR-2', 'push-1'));

    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptSkippedMinInterval).toBe(1);
  });

  it('스탬프 227m(자택) 차단 → boardingPromptSkippedTooFar', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeNearbyTrip({
        promptGeoContext: {
          origin: { lat: 0, lng: 0 },
          nextStation: { lat: 0, lng: 0.01 },
          direction: 'up',
          originDistanceM: 227,
          originAccuracyM: 9,
        },
      }),
    );
    const env = makeEnv(kv);

    const stats = await runScheduled(env, makeDeps(NOW, 'TR-HOME', 'push-0'));

    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptSkippedTooFar).toBe(1);
    expect(stats.boardingPromptEvaluated).toBe(0);
  });

  it('스탬프 부재(지하) → 근접 게이트 우회, 발사 허용', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeNearbyTrip({
        promptGeoContext: {
          origin: { lat: 0, lng: 0 },
          nextStation: { lat: 0, lng: 0.01 },
          direction: 'up',
          // originDistanceM/originAccuracyM 미부여 — 지하/구 클라 재현.
        },
      }),
    );
    const env = makeEnv(kv);

    const stats = await runScheduled(env, makeDeps(NOW, 'TR-UNDERGROUND', 'push-0'));

    expect(stats.boardingPromptSkippedTooFar).toBe(0);
    expect(stats.boardingPromptFired).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — 종료 정리: DELETE 후 재등록 시 stale tripStatus 부재 (#2144)
// ---------------------------------------------------------------------------

describe('evidence 2026-08-04 — 종료 정리 stale tripStatus (#2144)', () => {
  // #2144 (PR #2146)가 dev에 머지됨 — it.todo에서 실 assertion으로 전환.
  //
  // #2144 이슈 본문 evidence: 아침 trip 종료 기록 `tripStatus:e25e1158…` = {endedAt: 08:47:11 KST,
  // endReason: expired, TTL 8/11}가 같은 token의 새 trip이 20:06에 활성 등록된 뒤에도 잔존.
  // register handler(index.ts)는 readTripEndedStatus로 read만 하고 성공 등록 후 clear하지
  // 않았다 — 활성 trip과 '종료됨' 기록이 공존하는 상태 불일치가 관측됐다.
  //
  // writeTripEndedStatus는 production에서 cleanupTripWithLa(backend cron 종료 경로)를 통해서만
  // 호출된다 — HTTP DELETE /trips/:token 경로는 tripStatus를 기록하지 않는다(types.ts:402~403
  // 주석). 여기서는 그 종료 마커가 이미 KV에 존재하는 상태(백엔드 cron이 trip을 종료 처리한
  // 직후)를 시드해 재등록 시 정리되는지를 관측 가능한 결과(KV의 tripStatus:<token> 키 존재
  // 여부)로만 검증한다.
  const TOKEN = 'e25e1158-evidence-tok';

  function makeRegisterEnv(kv: InMemoryKV): Env {
    return {
      TRIPS: kv as unknown as Env['TRIPS'],
      APNS_HOST: 'h',
      APNS_HOST_SANDBOX: 'hs',
      SEOUL_API_HOST: 'h',
      SEOUL_API_KEY: 'k',
      APNS_KEY_ID: 'k',
      APNS_TEAM_ID: 't',
      APNS_PRIVATE_KEY: 'p',
      APNS_BUNDLE_ID: 'b',
    };
  }

  function tripBody(): Record<string, unknown> {
    const future = Date.now() + 60 * 60 * 1000;
    return {
      token: TOKEN,
      route: { type: 'direct', line: '2', stops: 5 },
      destination: 'dst',
      waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
      expiresAt: future,
      alarmAtEpochMs: future - 30 * 60 * 1000,
    };
  }

  it('trip 종료(cron 처리) 후 같은 token 재등록 시 tripStatus:<token> 이 register 성공 경로에서 정리된다', async () => {
    const kv = new InMemoryKV();
    const env = makeRegisterEnv(kv);

    // 이슈 evidence 재현: 08:47:11 KST 'expired' 종료 마커 — 새 trip 재등록(20:06) 시점에는
    // #1425 cooldown(1시간) 윈도우를 훌쩍 넘겨 재등록 자체는 허용되는 상태.
    const endedAt = Date.now() - 12 * 60 * 60 * 1000; // 12시간 전 종료 (cooldown 윈도우 밖)
    await kv.put(
      `tripStatus:${TOKEN}`,
      JSON.stringify({ endedAt, endReason: 'expired' }),
      { expirationTtl: 7 * 24 * 60 * 60 },
    );
    expect(await kv.get(`tripStatus:${TOKEN}`)).not.toBeNull();

    const res = await post('/trips', tripBody(), env);

    expect(res.status).toBe(200);
    // register 성공(활성 trip 등록) 후에도 옛 종료 마커가 남아있으면 "활성 trip + 종료됨 기록
    // 공존"이라는 상태 불일치가 재발 — register 성공 경로에서 정리되어야 한다.
    expect(await kv.get(`tripStatus:${TOKEN}`)).toBeNull();
    // 새 trip은 정상 활성화됐어야 한다.
    expect(await kv.get(`trip:${TOKEN}`)).not.toBeNull();
  });
});
