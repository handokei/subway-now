/**
 * #3047 — sliding TTL 연장 5곳(index.ts:1380/2338/2664/3489/3921)이 전부 FG 훅/사용자 탭
 * 트리거다. BG-only 라이드(화면 꺼짐)에서 device→backend 유일 호출은
 * `backgroundLocationTask.ts` → `POST /position`이며, 그 경로는 #3023 설계 당시 의도적으로
 * 연장 대상에서 제외됐다(`extendTripExpiryOnActivity` 헤더 주석, 쿼터 증폭 우려). 그 선언이
 * "BG-only 라이드는 여전히 중간 만료된다"는 사실을 적지 않았다(10/18 편측 감사 D1).
 *
 * fix: POST /position 경로에서 **잔여 TTL < TRIP_ACTIVITY_MIN_REMAINING_MS일 때만**
 * `extendTripExpiryOnActivity` + putTrip 1회(`extendTripExpiryViaPosition`). 기존
 * `stampOriginProximityIfNeeded`(근접 전용 조건부 write)와는 독립된 별도 조건부 write다 —
 * 근접 관측이 없는 BG-only 구간(대부분)에는 피기백 기회가 없어 분리된 조건부 write로 간다.
 *
 * 범위 제외(#3047 본문 "함께 처리(부수)" 항목) — 재등록 expiresAt 단축 가드(index.ts:1364
 * 부근, `Math.max(existing.expiresAt, incoming.expiresAt)`)는 이 PR에 포함하지 않는다. 미머지
 * PR #3042가 같은 merge 블록을 수정 중이라 충돌 — #3042 머지 후 후속 이슈로 처리한다. 그래서
 * 이슈 본문의 "거부 ④"(재등록 단축 거부)는 이 테스트 파일에 포함하지 않는다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  app,
  TRIP_ACTIVITY_EXTENSION_MS,
  TRIP_ACTIVITY_MIN_REMAINING_MS,
} from '../index';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

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
    token: 'tok-bg-ttl',
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

/** BG-only 라이드의 유일 채널 — 근접 필드 없음(화면 꺼짐, origin 근접 관측 불가 구간 대부분). */
function bgPositionBody(ts: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: 'tok-bg-ttl',
    lat: 37.5,
    lng: 127.0,
    accuracy: 15,
    ts,
    motion: 'automotive',
    appState: 'bg',
    ...overrides,
  };
}

const T0 = 1_700_000_000_000;
const LONG_TTL_MS = 2 * 60 * 60 * 1000; // device DEFAULT_TRIP_TTL_MS와 동일.

describe('#3047 — BG-only POST /position 라이드의 sliding TTL 연장', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('red ① — BG position만 오는 trip이 원 expiresAt을 지나도 생존한다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const env = makeKvEnv();

    await post('/trips', tripBody({ expiresAt: T0 + LONG_TTL_MS }), env);

    // 만료 5분 전(잔여 5분 < 임계 30분) — BG position만 도착.
    const positionAt = T0 + LONG_TTL_MS - 5 * 60 * 1000;
    vi.setSystemTime(positionAt);
    const res = await post('/position', bgPositionBody(positionAt), env);
    expect(res.status).toBe(200);

    const stored = JSON.parse((await env.TRIPS.get('trip:tok-bg-ttl')) as string);
    // 현재(fix 전) 구현은 /position을 연장 대상에서 제외 → expiresAt이 원래 값에 고정 → red.
    expect(stored.expiresAt).toBe(positionAt + TRIP_ACTIVITY_EXTENSION_MS);
    expect(stored.expiresAt).toBeGreaterThan(T0 + LONG_TTL_MS);

    // 원 expiresAt을 지난 뒤에도 KV 레코드가 살아있다 — 10/15 기전의 BG-only 변형이 해소됐다는 증거.
    vi.setSystemTime(T0 + LONG_TTL_MS + 60 * 1000);
    expect(await env.TRIPS.get('trip:tok-bg-ttl')).not.toBeNull();
  });

  it('거부 ② — 잔여 TTL이 임계 이상이면 /position 경로는 KV write를 추가하지 않는다(쿼터 불변식)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const kv = new InMemoryKV();
    const env = makeKvEnv({}, kv);

    await post('/trips', tripBody({ expiresAt: T0 + LONG_TTL_MS }), env);

    // 등록 직후 — 잔여 TTL(2h)이 임계(30분)보다 훨씬 위.
    const putSpy = vi.spyOn(kv, 'put');
    putSpy.mockClear();

    const res = await post('/position', bgPositionBody(T0), env);
    expect(res.status).toBe(200);

    const tripWrites = putSpy.mock.calls.filter(([key]) => key === 'trip:tok-bg-ttl');
    // 근접 필드 부재(stampOriginProximityIfNeeded no-op) + 잔여 TTL 충분(연장 no-op) → trip write 0.
    expect(tripWrites).toHaveLength(0);

    const stored = JSON.parse((await env.TRIPS.get('trip:tok-bg-ttl')) as string);
    expect(stored.expiresAt).toBe(T0 + LONG_TTL_MS);
    putSpy.mockRestore();
  });

  it('거부 ③ — position 없이 방치된 trip은 기존대로(연장 없이) 그대로 둔다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const env = makeKvEnv();

    await post('/trips', tripBody({ expiresAt: T0 + LONG_TTL_MS }), env);

    // position 호출 없이 만료 시점까지 시간만 흐른다.
    vi.setSystemTime(T0 + LONG_TTL_MS - 1000);

    const stored = JSON.parse((await env.TRIPS.get('trip:tok-bg-ttl')) as string);
    expect(stored.expiresAt).toBe(T0 + LONG_TTL_MS);
  });

  it('쿼터 산술 — 연장 1회당 최소 1.5h 간격, 10초 주기 /position 호출에 증폭되지 않는다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const kv = new InMemoryKV();
    const env = makeKvEnv({}, kv);

    await post('/trips', tripBody({ expiresAt: T0 + LONG_TTL_MS }), env);

    // 등록 후 임계를 넘는 시점까지는(잔여 >= 30분) 10초 주기로 position이 와도 write 0.
    const putSpy = vi.spyOn(kv, 'put');
    putSpy.mockClear();
    for (let t = T0 + 10_000; t <= T0 + LONG_TTL_MS - TRIP_ACTIVITY_MIN_REMAINING_MS; t += 10_000) {
      vi.setSystemTime(t);
      await post('/position', bgPositionBody(t), env);
    }
    const writesBeforeThreshold = putSpy.mock.calls.filter(([key]) => key === 'trip:tok-bg-ttl');
    expect(writesBeforeThreshold).toHaveLength(0);

    // 임계 미달 구간에 들어선 첫 호출에서만 정확히 1회 연장 write.
    const thresholdCrossAt = T0 + LONG_TTL_MS - TRIP_ACTIVITY_MIN_REMAINING_MS + 10_000;
    vi.setSystemTime(thresholdCrossAt);
    await post('/position', bgPositionBody(thresholdCrossAt), env);
    const writesAfterThreshold = putSpy.mock.calls.filter(([key]) => key === 'trip:tok-bg-ttl');
    expect(writesAfterThreshold).toHaveLength(1);

    const stored = JSON.parse((await env.TRIPS.get('trip:tok-bg-ttl')) as string);
    expect(stored.expiresAt).toBe(thresholdCrossAt + TRIP_ACTIVITY_EXTENSION_MS);
    putSpy.mockRestore();
  });
});
