/**
 * #3055 — 재시드가 같은 register burst에서 셀 상태(LA 토큰 / lock / 진행)를 지우는 잠재 경합.
 *
 * 재현 입력(불변 실측): 11/05 05:36:27 trip_metrics 2212/2213/2214(token_hash b00dd879) —
 *   2212 trip-register(existedAtRequestStart:false) -> 2213 la-token-register -> 2214 trip-register(같은 초, existedAtRequestStart:false).
 * 두 번째 register가 KV를 60s 캐시로 낡게(null) 읽으면 `existing===null` 분기가 `seedCells`로 셀을 재시드한다. createdAt이 더 크면
 * `needsSeed`가 참이 되어 LA/lock/진행 셀이 빈 스냅샷으로 덮인다 — 같은 초 안에 셀에 쓰인 최신 상태가 소실된다.
 * (이 trip에서는 실현되지 않았다. 경로가 코드에 존재.)
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import app from '../index';
import { createEmptyScheduledStats, maybeFireLiveActivityUpdate, type ScheduledDeps } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { progressHeadKey } from '../progressOps';
import { fetchCells, resetCellStageCache, runLaOp, runLockOp, runProgressOp } from '../tripDoCells';
import { setTripDoFlag } from '../tripDoFlag';
import { getTrip } from '../trips';
import type { BoardingLockMeta, Env } from '../types';
import { CacheLagKV } from './helpers/cacheLagKv';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';

const TOKEN = 'reseed-3055-tok';
const kstMs = (iso: string): number => Date.parse(`${iso}+09:00`);
const HOUR_MS = 60 * 60_000;
/** 05:36:27 같은 초 이중 register — createdAt은 두 번째가 더 크다(device가 register마다 새로 찍는다). */
const CREATED_1 = kstMs('2026-11-05T05:36:27');
const BURST_DRIFT_MS = 800;
const NEW_TRIP_DRIFT_MS = 30_000;
const LA_TOKEN = 'la-token-b00dd879';
const USER_LOCK: BoardingLockMeta = {
  trainCode: '3334',
  line: '2',
  subwayId: '1002',
  selectedDepartureTime: CREATED_1,
  segmentStations: ['뚝섬', '성수'],
  expiresAt: CREATED_1 + HOUR_MS,
};
const FLAGS = ['lock@1', 'progress@1'] as const;

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
});
beforeEach(() => {
  resetApnsJwtCache();
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function makeEnv(flag: string): Promise<Env> {
  const kv = new CacheLagKV(0, { byCacheTtl: { defaultTtlSec: 60, laggedPrefixes: ['trip:'] } });
  const env = {
    TRIPS: kv as unknown as KVNamespace,
    TRIP_DO: makeFakeTripDoNamespace().ns,
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  } as Env;
  await setTripDoFlag(env.TRIPS, flag);
  resetCellStageCache(kv);
  return env;
}

const registerBody = (createdAt: number): Record<string, unknown> => ({
  token: TOKEN,
  route: { type: 'direct', line: '2', stops: 2 },
  destination: '건대입구',
  waypoints: [
    { stationName: '성수', line: '2', kind: 'intermediate' },
    { stationName: '건대입구', line: '2', kind: 'destination' },
  ],
  expiresAt: createdAt + 3 * HOUR_MS,
  alarmAtEpochMs: createdAt + 30 * 60_000,
  createdAt,
  infoModeEnabled: false,
  promptDisplay: { originStation: '뚝섬', line: '2' },
});

const post = (path: string, body: unknown, env: Env): Promise<Response> =>
  app.fetch(
    new Request(`http://example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );

/** 05:36:27 register(2212) -> la-register(2213) -> 같은 초 register(2214, KV는 낡게 null을 읽는다). */
async function registerBurst(env: Env, secondCreatedAt: number, between?: () => Promise<void>): Promise<void> {
  vi.setSystemTime(CREATED_1);
  expect((await post('/trips', registerBody(CREATED_1), env)).status).toBe(200);
  // la-register는 다른 엣지에서 fresh 시야로 처리돼 셀에 토큰을 쓴다(핸들러가 하는 op와 동일) — 같은 colo의 낡은 KV 시야와 독립.
  const la = await runLaOp(env, TOKEN, { type: 'registerLaToken', source: 'la-register', token: LA_TOKEN }, CREATED_1 + 100);
  expect(la.outcome).toBe('applied');
  if (between) await between();
  vi.setSystemTime(CREATED_1 + BURST_DRIFT_MS);
  expect((await post('/trips', registerBody(secondCreatedAt), env)).status).toBe(200);
}

describe.each(FLAGS)('#3055 — 같은 초 이중 register가 셀을 지우지 않는다 (%s)', (flag) => {
  it('LA 토큰: register -> la-register -> 낡은 시야의 register(createdAt 더 큼) 뒤에도 토큰이 산다 + cron la-push가 그 토큰으로 발사', async () => {
    const env = await makeEnv(flag);
    await registerBurst(env, CREATED_1 + BURST_DRIFT_MS);
    const seen = await getTrip(env, TOKEN);
    expect(seen?.activityPushToken).toBe(LA_TOKEN);
    expect(seen?.activityState).toBe('live');

    // cron 시야(overlay trip)로 la-push — 게이트(token && live)를 통과해 그 토큰의 APNs URL로 나간다.
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const deps = {
      apnsConfig,
      apnsHosts: { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      seoul: new SeoulArrivalClient({ host: 'h', apiKey: 'K', fetchImpl: fetchImpl as unknown as typeof fetch }),
    } as ScheduledDeps;
    const now = CREATED_1 + 18_000;
    const fired = await maybeFireLiveActivityUpdate(
      seen!,
      seen!.waypoints[0],
      now + 120_000,
      deps,
      createEmptyScheduledStats(now),
      now,
      () => {},
      null,
    );
    expect(fired).toBe(true);
    const urls = (fetchImpl.mock.calls as unknown as [string][]).map(([url]) => url);
    expect(urls.some((url) => url.endsWith(`/3/device/${LA_TOKEN}`))).toBe(true);
  });

  it('lock: 사이에 탑승 확정으로 생긴 lock이 낡은 register 뒤에도 산다', async () => {
    const env = await makeEnv(flag);
    await registerBurst(env, CREATED_1 + BURST_DRIFT_MS, async () => {
      // 사용자 탑승 확정(LA 탑승 버튼 / 알림 응답 = 명시 의향)이 만든 lock — 핸들러가 쓰는 attachIfNone(user)과 동일 op.
      const attached = await runLockOp(
        env,
        TOKEN,
        { type: 'attachIfNone', source: 'confirm', authority: 'user', expectedRev: 0, lock: USER_LOCK },
        CREATED_1 + 300,
      );
      expect(attached.outcome).toBe('applied');
    });
    const { lock } = await fetchCells(env, TOKEN);
    expect(lock?.lock?.trainCode).toBe('3334');
  });

  it('거부 케이스: 같은 token이어도 createdAt이 세션 창(5s)을 넘게 새 trip이면 LA 토큰이 초기화된다', async () => {
    const env = await makeEnv(flag);
    await registerBurst(env, CREATED_1 + NEW_TRIP_DRIFT_MS);
    const seen = await getTrip(env, TOKEN);
    expect(seen?.activityPushToken).toBeUndefined();
  });
});

describe('#3055 — progress@1: 진행 셀도 낡은 register가 되감지 않는다', () => {
  it('advanceHead로 전진한 진행이 같은 초 낡은 register 뒤에도 유지된다', async () => {
    const env = await makeEnv('progress@1');
    await registerBurst(env, CREATED_1 + BURST_DRIFT_MS, async () => {
      const { progress } = await fetchCells(env, TOKEN);
      const headKey = progressHeadKey(progress!);
      const res = await runProgressOp(
        env,
        TOKEN,
        { type: 'advanceHead', source: 'test', expectedHeadKey: headKey!, count: 1 },
        CREATED_1 + 300,
      );
      expect(res.outcome).toBe('applied');
    });
    const { progress } = await fetchCells(env, TOKEN);
    expect(progress?.waypoints.map((w) => w.stationName)).toEqual(['건대입구']);
  });
});
