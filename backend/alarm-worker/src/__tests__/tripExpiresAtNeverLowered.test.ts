/**
 * PR-0 (plan-2026-10-21 §2.2, U6) — backend trip `expiresAt`은 재등록·sliding으로 **낮아지지 않는다**.
 *
 * 왜 필요한가: device B 최소판(404/410 = "서버에 트립 없음" → 자가 종료)은 하한
 * `TRIP_STARTED_AT + DEFAULT_TRIP_TTL_MS + GRACE` 이전의 404를 "방금 등록/전파 지연"으로 보고 종료하지
 * 않는다. 이 하한은 "서버 expiresAt ≥ 트립 시작 + 2h"일 때만 안전하다. 어느 경로가 expiresAt을
 * 하한 아래로 낮추면 살아있는 트립이 하한 이전에 KV에서 사라질 수 있다.
 *
 * 관련 경로(전부 읽어 확정):
 *  - device 전송값: `alarmBackend.ts:435` `payload.expiresAt ?? Date.now() + DEFAULT_TRIP_TTL_MS`
 *    (호출부 중 `payload.expiresAt`을 채우는 곳 없음 → 항상 전송 시각 + 2h)
 *  - same-session merge(`index.ts` baseTrip): `...incoming`을 base로 두고 expiresAt은 existing에서
 *    보존하지 않는다 → expiresAt = incoming.expiresAt
 *  - `extendTripExpiryOnActivity`(`index.ts:3819`): 잔여 < 30분일 때 `now + 2h`로 **올리기만** 한다
 *
 * 결론이 되는 불변식 둘(테스트로 고정):
 *  (I1) 시간순으로 도착하는 재등록은 expiresAt을 낮추지 않는다
 *  (I2) 어떤 도착 순서·sliding 조합이어도 expiresAt ≥ 최초 전송 시각 + 2h  (= B의 하한)
 * 순서가 뒤집혀 도착한(늦게 도착한 옛 전송) 재등록은 expiresAt을 **전송 시각 차(수 초) 만큼** 낮출 수
 * 있다 — 이는 (I2) 아래로는 내려가지 않으므로 B 하한에 영향이 없다. 그 사실도 별도 케이스로 고정한다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  app,
  extendTripExpiryOnActivity,
  TRIP_ACTIVITY_EXTENSION_MS,
  TRIP_ACTIVITY_MIN_REMAINING_MS,
} from '../index';
import { InMemoryKV } from './inMemoryKv';
import type { Env, Trip } from '../types';

const TOKEN = 'tok-exp-bound';
/** device `DEFAULT_TRIP_TTL_MS`(`alarmBackend.ts:237`)와 같은 값. */
const DEVICE_TTL_MS = 2 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

async function post(path: string, body: unknown, env: Env): Promise<Response> {
  return app.fetch(
    new Request(`http://example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

function makeKvEnv(): Env {
  return {
    TRIPS: new InMemoryKV() as unknown as Env['TRIPS'],
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  };
}

/** device가 보내는 바디와 같은 모양 — `createdAt`은 세션 신원이라 재등록 간 고정(#2998). */
function deviceRegisterBody(sendAt: number): Record<string, unknown> {
  return {
    token: TOKEN,
    route: { type: 'direct', line: '2', stops: 3 },
    destination: 'dst',
    waypoints: [
      { stationName: '강남', line: '2', kind: 'intermediate' },
      { stationName: '역삼', line: '2', kind: 'destination' },
    ],
    createdAt: T0,
    expiresAt: sendAt + DEVICE_TTL_MS,
    alarmAtEpochMs: 0,
    infoModeEnabled: true,
  };
}

async function storedExpiresAt(env: Env): Promise<number> {
  const raw = (await env.TRIPS.get(`trip:${TOKEN}`)) as string;
  return (JSON.parse(raw) as { expiresAt: number }).expiresAt;
}

async function registerAt(env: Env, sendAt: number): Promise<void> {
  vi.setSystemTime(sendAt);
  const res = await post('/trips', deviceRegisterBody(sendAt), env);
  expect(res.status).toBe(200);
}

describe('PR-0 — backend trip expiresAt 하한(시작 + 2h) 불변식 (U6)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(I1) same-session 재등록 — 시간순 전송이면 expiresAt이 단조 비감소이고 최초 등록값 이상이다', async () => {
    vi.useFakeTimers();
    const env = makeKvEnv();
    // 10초 간격 → 1분 → 30분 → 1시간 59분 (임계 30분 미달 구간 포함) 순 재등록.
    const sendTimes = [0, 10_000, 70_000, 30 * 60_000, 119 * 60_000].map((d) => T0 + d);

    let prev = -Infinity;
    for (const sendAt of sendTimes) {
      await registerAt(env, sendAt);
      const exp = await storedExpiresAt(env);
      expect(exp).toBeGreaterThanOrEqual(prev);
      expect(exp).toBeGreaterThanOrEqual(T0 + DEVICE_TTL_MS);
      prev = exp;
    }
    // 마지막 재등록은 전송 시각 + 2h로 올라가 있어야 한다(= 세션이 길수록 수명 연장).
    expect(prev).toBe(T0 + 119 * 60_000 + DEVICE_TTL_MS);
  });

  it('(I1) 재등록 사이에 sliding 연장이 끼어도 다음 재등록이 expiresAt을 낮추지 않는다', async () => {
    vi.useFakeTimers();
    const env = makeKvEnv();
    await registerAt(env, T0);

    // 만료 5분 전 sync(활동성 핸들러) → sliding으로 now + 2h.
    const syncAt = T0 + DEVICE_TTL_MS - 5 * 60_000;
    vi.setSystemTime(syncAt);
    const sync = await post(
      '/boarding-lock/sync',
      { token: TOKEN, observedStationName: '강남', observedAtMs: syncAt, accuracy: 5 },
      env,
    );
    expect(sync.status).toBe(200);
    const slid = await storedExpiresAt(env);
    expect(slid).toBe(syncAt + TRIP_ACTIVITY_EXTENSION_MS);

    // sync 직후 device 재등록(전송 시각 + 2h) — sliding 값보다 낮아지면 안 된다.
    await registerAt(env, syncAt + 1_000);
    expect(await storedExpiresAt(env)).toBeGreaterThanOrEqual(slid);
  });

  it('(I2) 순서가 뒤집혀 늦게 도착한 옛 전송은 expiresAt을 전송 시각 차만큼 낮출 수 있으나 시작 + 2h 아래로는 내려가지 않는다', async () => {
    vi.useFakeTimers();
    const env = makeKvEnv();
    await registerAt(env, T0);

    // 전송 시각 T0+60s 짜리 바디를 만들어 두고, T0+120s 에 전송한 최신 바디가 먼저 도착한 뒤 늦게 도착.
    const staleBody = deviceRegisterBody(T0 + 60_000);
    const freshSendAt = T0 + 120_000;
    await registerAt(env, freshSendAt);
    const freshExp = await storedExpiresAt(env);
    expect(freshExp).toBe(freshSendAt + DEVICE_TTL_MS);

    vi.setSystemTime(freshSendAt + 1_000);
    const res = await post('/trips', staleBody, env);
    expect(res.status).toBe(200);

    const after = await storedExpiresAt(env);
    // 현재 동작의 사실: merge가 expiresAt을 existing에서 보존하지 않으므로 옛 전송값이 채택된다.
    expect(after).toBe(T0 + 60_000 + DEVICE_TTL_MS);
    expect(after).toBeLessThan(freshExp);
    // 그러나 B 하한에는 영향이 없다 — 가장 옛 전송이어도 시작 시각 + 2h 이상.
    expect(after).toBeGreaterThanOrEqual(T0 + DEVICE_TTL_MS);
  });

  describe('extendTripExpiryOnActivity — 올리기만 한다', () => {
    const NOW = T0 + 90 * 60_000;
    const trip = (expiresAt: number): Trip => ({ expiresAt }) as Trip;

    it.each([
      ['잔여 임계 미만 → 올림', NOW + TRIP_ACTIVITY_MIN_REMAINING_MS - 1, NOW + TRIP_ACTIVITY_EXTENSION_MS],
      ['이미 만료(음수 잔여) → 올림', NOW - 60_000, NOW + TRIP_ACTIVITY_EXTENSION_MS],
      ['잔여 임계 이상 → 그대로', NOW + TRIP_ACTIVITY_MIN_REMAINING_MS, NOW + TRIP_ACTIVITY_MIN_REMAINING_MS],
      ['잔여가 연장 길이보다 큼 → 그대로(낮추지 않음)', NOW + 3 * 60 * 60_000, NOW + 3 * 60 * 60_000],
    ])('%s', (_label, before, expected) => {
      const result = extendTripExpiryOnActivity(trip(before), NOW);
      expect(result.expiresAt).toBe(expected);
      expect(result.expiresAt).toBeGreaterThanOrEqual(before);
    });
  });
});
