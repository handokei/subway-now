/**
 * 2026-08-07 오전 실탑승(corrId=tmsi34imn) rotation storm replay (Issue #2193,
 * Part of #2192 / ADR-025).
 *
 * TDD 선행 — #A1(신원 안정화 core fix)보다 먼저 이 replay가 "현재 코드에서 실패(red)"함을
 * 증명한다. #A1이 머지되면 아래 `test.fails(...)` 블록을 `test(...)`로 flip해 green
 * 전환을 검증한다 (각 블록에 "flip in #2194" 주석).
 *
 * 재현 메커니즘: `POST /trips` rate-limit 게이트(`index.ts:567`, deviceToken 기준 10회/10분)가
 * route-change rotation(`index.ts:776`, `rotateTripTokenForNewRoute`)보다 먼저 평가된다.
 * 매 route 변경 재-POST가 rotation을 유발해도 rate-limit 키는 항상 원본 deviceToken —
 * 10번째 이후 재-POST는 429로 죽고 새 route trip이 등록되지 않는다.
 *
 * 금지: 이 이슈는 production 코드를 수정하지 않는다 (`src/index.ts` / `src/trips.ts` /
 * `src/tripRegisterRateLimit.ts` 등). Fixture + test만.
 */

import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { app } from '../index';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { ARCH_FLAG_KV_KEY } from '../archFlag';
import { TRIP_REGISTER_MAX_PER_WINDOW } from '../tripRegisterRateLimit';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';
import {
  DEVICE_TOKEN,
  ROTATION_STORM_REQUEST_COUNT,
  buildRotationStormTripBody,
} from './fixtures/replay_20260807_rotation_ratelimit';

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

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
  };
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

/**
 * ROTATION_STORM_REQUEST_COUNT(11)개의 순차 `/trips` POST를 같은 deviceToken, 매번 다른
 * route로 발사한다 — evidence dump의 route 재플랜 재-POST 패턴 재현. 각 요청은 이전 요청
 * 완료를 기다린 뒤 순차 발사한다(실기기 재시도 루프처럼 겹치지 않는 순서, per-token 직렬화
 * lock과 무관하게 rate-limit 카운터 누적 순서를 결정적으로 만든다).
 */
async function runRotationStorm(env: Env): Promise<Response[]> {
  const FUTURE = Date.now() + 60 * 60 * 1000;
  const responses: Response[] = [];
  for (let i = 0; i < ROTATION_STORM_REQUEST_COUNT; i += 1) {
    const body = buildRotationStormTripBody(i, FUTURE);
    // eslint-disable-next-line no-await-in-loop -- 순차 재-POST 순서 고정이 목적
    const res = await post('/trips', body, env);
    responses.push(res);
  }
  return responses;
}

describe('evidence 2026-08-07 tmsi34imn — rotation storm red replay (#2193)', () => {
  test('현재 코드: rotation storm 재-POST가 rate-limit(429)에 걸려 최신 route가 등록되지 않는다 (red 증명)', async () => {
    const kv = new InMemoryKV();
    await kv.put(ARCH_FLAG_KV_KEY, 'on');
    const env = makeEnv(kv);

    const responses = await runRotationStorm(env);
    const statuses = responses.map((r) => r.status);

    // evidence: 07:37:35 / 07:37:42 / 07:37:54 / 07:38:55(x2) 다중 429 관측.
    // ROTATION_STORM_REQUEST_COUNT(11) = TRIP_REGISTER_MAX_PER_WINDOW(10) + 1이므로
    // 마지막 요청은 현재 코드에서 반드시 429로 죽는다.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses[ROTATION_STORM_REQUEST_COUNT - 1]).toBe(429);

    // 429로 막힌 마지막 route(index=10, "evidence-dst-10")는 어떤 trip에도 반영되지 않는다 —
    // KV에 남은 활성 trip 전체 중 그 destination을 가진 것이 하나도 없어야 "새 route 등록
    // 실패" chain-death가 증명된다.
    const allTrips = await kv.list({ prefix: 'trip:' });
    const rawValues = await Promise.all(
      allTrips.keys.map((k) => kv.get(k.name)),
    );
    const destinations = rawValues
      .filter((v): v is string => v !== null)
      .map((v) => (JSON.parse(v) as { destination: string }).destination);
    expect(destinations).not.toContain('evidence-dst-10');
  });

  test('현재 코드: rotation storm이 rate-limit 예산을 소진해 10회 초과 시 429 발생 (red 증명, cap SSOT 사용)', async () => {
    const kv = new InMemoryKV();
    await kv.put(ARCH_FLAG_KV_KEY, 'on');
    const env = makeEnv(kv);

    // TRIP_REGISTER_MAX_PER_WINDOW + 1개 요청을 fixture 상수와 SSOT 상수가 정합함을 보장.
    expect(ROTATION_STORM_REQUEST_COUNT).toBe(TRIP_REGISTER_MAX_PER_WINDOW + 1);

    const responses = await runRotationStorm(env);
    const last = responses[responses.length - 1];
    const body = (await last.json()) as { error?: string; retryAfterSeconds?: number };
    expect(last.status).toBe(429);
    expect(body.error).toBe('rate_limited');
  });

  // -------------------------------------------------------------------------
  // 아래 3개는 "수리 후 기대치" — ADR-025(#2192) #A1 신원 안정화 적용 후 green이 되어야
  // 한다. 지금은 버그가 존재하므로 assert가 실패해야 정상 — `test.fails`로 감싸 CI green을
  // 유지한다(#2194에서 `test.fails` → `test`로 flip).
  // -------------------------------------------------------------------------

  // flip in #2194
  test.fails(
    '수리 후 기대치: route 변경 재-POST에서 rotated 발생 0 (신규 UUID trip 키 생성 없음)',
    async () => {
      const kv = new InMemoryKV();
      await kv.put(ARCH_FLAG_KV_KEY, 'on');
      const env = makeEnv(kv);

      await runRotationStorm(env);

      const allTrips = await kv.list({ prefix: 'trip:' });
      const uuidLikeKeys = allTrips.keys.filter(
        (k) => k.name !== `trip:${DEVICE_TOKEN}`,
      );
      // 수리 후: route 변경은 rotation(새 UUID 키) 없이 같은 신원(deviceToken 키) update로
      // 처리되어야 한다 — 지금은 매 route 변경마다 새 UUID 키가 생성되어 실패한다.
      expect(uuidLikeKeys.length).toBe(0);
    },
  );

  // flip in #2194
  test.fails(
    '수리 후 기대치: rotation storm 재-POST가 create budget을 소진하지 않아 429 = 0',
    async () => {
      const kv = new InMemoryKV();
      await kv.put(ARCH_FLAG_KV_KEY, 'on');
      const env = makeEnv(kv);

      const responses = await runRotationStorm(env);
      const statuses = responses.map((r) => r.status);
      // 수리 후: route 변경 재-POST는 update로 흡수되어 rate-limit budget을 소진하지 않는다 —
      // 지금은 매 route 변경이 rotation(=신규 등록 취급)으로 카운터를 소진해 429가 발생한다.
      expect(statuses.filter((s) => s === 429).length).toBe(0);
    },
  );

  // flip in #2194
  test.fails(
    '수리 후 기대치: 트립 1건이 동일 신원(deviceToken 키)으로 지속 등록된다 (route 변경 = update)',
    async () => {
      const kv = new InMemoryKV();
      await kv.put(ARCH_FLAG_KV_KEY, 'on');
      const env = makeEnv(kv);

      await runRotationStorm(env);

      const allTrips = await kv.list({ prefix: 'trip:' });
      // 수리 후: 활성 trip은 정확히 1개, 그리고 그 키는 항상 원본 deviceToken이어야 한다 —
      // 지금은 rotation이 매번 새 UUID 키로 옮겨가 이 조건을 만족하지 못한다.
      expect(allTrips.keys.length).toBe(1);
      expect(allTrips.keys[0]?.name).toBe(`trip:${DEVICE_TOKEN}`);
    },
  );
});
