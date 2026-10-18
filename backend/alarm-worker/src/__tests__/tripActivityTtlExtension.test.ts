/**
 * #3023 요구 1 — 활동성 trip TTL sliding extension.
 *
 * 배경(2026-10-15 실측, `alarmBackend.ts:429-432`): 14:04:17 등록(device 기본 TTL
 * `DEFAULT_TRIP_TTL_MS`=2h, `src/features/alarm/api/alarmBackend.ts:237`) → 16:04 TTL 만료 →
 * 16:25~16:43 재등록 400×30 — 재등록 없이 sync 등 활동이 계속 들어와도 trip.expiresAt이
 * 등록 시점 값으로 고정돼 라이드 중간에 KV TTL이 그대로 만료됐다.
 *
 * 설계(이슈 #3023 "요구 1 착수 스펙" 코멘트): putTrip이 이미 일어나는 활동성 핸들러에서,
 * putTrip 직전 잔여 TTL이 `TRIP_ACTIVITY_MIN_REMAINING_MS` 미만이면 `trip.expiresAt`을
 * `now + TRIP_ACTIVITY_EXTENSION_MS`로 연장한다. 새 KV write는 만들지 않는다(#2450/#3006
 * 쿼터 불변식) — 기존 write의 payload만 바뀐다.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApnsConfig } from '../apns';
import {
  app,
  TRIP_ACTIVITY_EXTENSION_MS,
  TRIP_ACTIVITY_MIN_REMAINING_MS,
} from '../index';
import { runScheduled, type ScheduledDeps } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { InMemoryKV } from './inMemoryKv';
import type { Env } from '../types';

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

function makeKvEnv(overrides: Partial<Env> = {}, kv?: InMemoryKV): Env {
  return {
    TRIPS: (kv ?? new InMemoryKV()) as unknown as Env['TRIPS'],
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
    ...overrides,
  };
}

function tripBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: 'tok-ttl',
    route: { type: 'direct', line: '2', stops: 3 },
    destination: 'dst',
    waypoints: [
      { stationName: '강남', line: '2', kind: 'intermediate' },
      { stationName: '역삼', line: '2', kind: 'destination' },
    ],
    alarmAtEpochMs: 0,
    infoModeEnabled: true,
    ...overrides,
  };
}

function syncBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: 'tok-ttl',
    observedStationName: '강남',
    observedAtMs: Date.now(),
    accuracy: 5,
    ...overrides,
  };
}

/** `scheduled.test.ts`의 `makeFireLogDb`와 동일 패턴 — D1 insert 인자를 그대로 축적. */
function makeFireLogDb(): { db: D1Database; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => {
        inserts.push(args);
        return {
          run: async () => ({ success: true }),
          first: async () => null,
          all: async () => ({ results: [] }),
        };
      },
    }),
  } as unknown as D1Database;
  return { db, inserts };
}

function makeSeoulEmpty(now: number): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => now,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 })) as unknown as typeof fetch,
  });
}

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: pem, bundleId: 'com.example.app' };
});

const T0 = 1_700_000_000_000;
// 임계(TRIP_ACTIVITY_MIN_REMAINING_MS) 미달 — sync 없이는 라이드 중간에 만료.
const SHORT_TTL_MS = TRIP_ACTIVITY_MIN_REMAINING_MS / 3;
const LONG_TTL_MS = 2 * 60 * 60 * 1000; // device DEFAULT_TRIP_TTL_MS와 동일(임계 훨씬 위).

describe('#3023 요구 1 — 활동성 trip TTL sliding extension', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('red ① — sync(putTrip 경로) 활동 시 잔여 TTL<임계면 expiresAt을 연장한다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const env = makeKvEnv();

    // 등록은 device 기본 TTL(2h, 임계 30분보다 훨씬 위) — register-time 연장이 끼지 않게
    // 분리해, 이 테스트가 오직 sync의 연장 효과만 isolate해서 검증한다.
    await post('/trips', tripBody({ expiresAt: T0 + LONG_TTL_MS }), env);

    // 만료 5분 전 sync 수신 — 잔여 5분 < TRIP_ACTIVITY_MIN_REMAINING_MS(30분).
    const syncAt = T0 + LONG_TTL_MS - 5 * 60 * 1000;
    vi.setSystemTime(syncAt);
    const res = await post('/boarding-lock/sync', syncBody({ observedAtMs: syncAt }), env);
    expect(res.status).toBe(200);

    const stored = JSON.parse((await env.TRIPS.get('trip:tok-ttl')) as string);
    // 현재 구현은 연장 로직이 없어 expiresAt이 원래 등록 값(T0+2h)에 고정 → red.
    expect(stored.expiresAt).toBe(syncAt + TRIP_ACTIVITY_EXTENSION_MS);
    expect(stored.expiresAt).toBeGreaterThan(T0 + LONG_TTL_MS);
  });

  it('red ② — 연장 후 cron tick에서 trip-end reason=expired D1 이벤트가 발생하지 않는다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    // 물리 KV 소멸(진짜 사고)과 cron의 논리 판정(trip.expiresAt<=now)을 분리하기 위해
    // InMemoryKV 내부 시계를 고정한다 — 그래야 "KV에는 아직 있는데 cron이 논리적으로
    // 만료 판정하는" 실제 cron 분기(scheduled.ts `trip.expiresAt <= now`)를 직접 검증한다.
    const kv = new InMemoryKV(() => T0);
    const { db, inserts } = makeFireLogDb();
    const env = makeKvEnv({ DB: db }, kv);

    await post('/trips', tripBody({ expiresAt: T0 + SHORT_TTL_MS }), env);
    const syncAt = T0 + 5 * 60 * 1000;
    vi.setSystemTime(syncAt);
    await post('/boarding-lock/sync', syncBody({ observedAtMs: syncAt }), env);

    const cronNow = T0 + SHORT_TTL_MS + 60 * 1000; // 원래 expiresAt을 지난 시각.
    vi.setSystemTime(cronNow);

    const deps: ScheduledDeps = {
      seoul: makeSeoulEmpty(cronNow),
      apnsConfig,
      apnsHosts: { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' },
      now: () => cronNow,
    };
    await runScheduled(env, deps);

    const expiredTripEndEvents = inserts.filter(
      (args) =>
        args[2] === 'trip-end' &&
        typeof args[5] === 'string' &&
        (args[5] as string).includes('"reason":"expired"'),
    );
    // 현재 구현은 연장이 없어 cron이 trip.expiresAt<=now로 force-expire → 1건 발생 → red.
    expect(expiredTripEndEvents).toHaveLength(0);
  });

  it('거부 ③(#3047로 대체) — POST /position은 근접 stamp + TTL 연장 각 1회, 그 외 추가 write는 없다', async () => {
    // 이 테스트는 원래(#3023) "POST /position은 활동성 연장 대상에서 제외"를 거부 케이스로
    // 검증했다. #3047(10/18 편측 감사 D1)이 그 제외가 BG-only 라이드를 미보호 상태로 남긴다는
    // 걸 발견해 /position 전용 조건부 연장 경로(`extendTripExpiryViaPosition`)를 추가했다 —
    // 그래서 이 케이스의 불변식은 "/position write 0"이 아니라 "write가 조건부 1회씩, 증폭
    // 없음"으로 바뀐다. BG-only 전용 회귀 케이스는 `positionTtlExtension.test.ts`(#3047)로 분리.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const kv = new InMemoryKV();
    const env = makeKvEnv({}, kv);

    // 등록은 임계(30분) 위 TTL(2h) — register-time 연장이 끼지 않게 분리.
    await post('/trips', tripBody({ expiresAt: T0 + LONG_TTL_MS }), env);

    // 만료 5분 전(잔여 5분 < 임계)까지 시간을 보내 — 이 시점에 /position만 온다.
    const positionAt = T0 + LONG_TTL_MS - 5 * 60 * 1000;
    vi.setSystemTime(positionAt);

    const putSpy = vi.spyOn(kv, 'put');
    putSpy.mockClear();

    // 근접 신호 O → stampOriginProximityIfNeeded 1회 + extendTripExpiryViaPosition 1회
    // (#3047, 잔여 TTL<임계) = 총 2회. 서로 다른 조건의 독립 조건부 write — 증폭 아님.
    const res = await post(
      '/position',
      {
        token: 'tok-ttl',
        lat: 1,
        lng: 2,
        accuracy: 10,
        ts: positionAt,
        motion: 'walking',
        originDistanceM: 50,
        originAccuracyM: 10,
      },
      env,
    );
    expect(res.status).toBe(200);

    const tripWrites = putSpy.mock.calls.filter(([key]) => key === 'trip:tok-ttl');
    expect(tripWrites).toHaveLength(2);

    const stored = JSON.parse((await env.TRIPS.get('trip:tok-ttl')) as string);
    // #3047 fix — /position도 이제 TTL 연장 대상. 근접 stamp와 함께 expiresAt이 연장된다.
    expect(stored.expiresAt).toBe(positionAt + TRIP_ACTIVITY_EXTENSION_MS);
    expect(stored.originProximityAt).toBe(positionAt);
    putSpy.mockRestore();
  });

  it('거부 ④ — 잔여 TTL이 임계 이상이면 expiresAt을 변경하지 않는다(불필요 연장 금지)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const env = makeKvEnv();

    await post('/trips', tripBody({ expiresAt: T0 + LONG_TTL_MS }), env);
    await post('/boarding-lock/sync', syncBody({ observedAtMs: T0 }), env);

    const stored = JSON.parse((await env.TRIPS.get('trip:tok-ttl')) as string);
    expect(stored.expiresAt).toBe(T0 + LONG_TTL_MS);
  });

  it('10/15 기전 재현 — 등록 → sync → 원 expiresAt 통과 → cron tick → 트립 생존 + reason=expired 0건', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const kv = new InMemoryKV(() => T0); // 물리 소멸과 cron 논리 판정 분리(위 red② 설명과 동일).
    const { db, inserts } = makeFireLogDb();
    const env = makeKvEnv({ DB: db }, kv);

    await post('/trips', tripBody({ expiresAt: T0 + SHORT_TTL_MS }), env);

    const syncAt = T0 + 5 * 60 * 1000;
    vi.setSystemTime(syncAt);
    await post('/boarding-lock/sync', syncBody({ observedAtMs: syncAt }), env);

    const cronNow = T0 + SHORT_TTL_MS + 60 * 1000;
    vi.setSystemTime(cronNow);
    const deps: ScheduledDeps = {
      seoul: makeSeoulEmpty(cronNow),
      apnsConfig,
      apnsHosts: { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' },
      now: () => cronNow,
    };
    const stats = await runScheduled(env, deps);

    // 트립이 cron에 의해 force-expire되지 않고 scanned 대상에 그대로 남아있다.
    expect(stats.scanned).toBeGreaterThanOrEqual(1);
    expect(stats.lifecycleForceEnded).toBe(0);

    const stillAlive = await kv.get('trip:tok-ttl');
    expect(stillAlive).not.toBeNull();

    const expiredTripEndEvents = inserts.filter(
      (args) =>
        args[2] === 'trip-end' &&
        typeof args[5] === 'string' &&
        (args[5] as string).includes('"reason":"expired"'),
    );
    expect(expiredTripEndEvents).toHaveLength(0);
  });
});
