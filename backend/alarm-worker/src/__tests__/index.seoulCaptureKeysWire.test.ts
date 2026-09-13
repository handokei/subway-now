/**
 * GET /admin/seoul-capture/keys (#2592) 라우트 wire 테스트 — index.ts는
 * seoulCaptureKeys.ts에 위임만 한다. auth/binding 정책 및 위임 자체만 여기서 검증하고,
 * 범위 파싱/스캔 로직 케이스는 seoulCaptureKeys.test.ts(모듈 단위테스트)가 커버한다.
 */
import { describe, expect, it } from 'vitest';
import { app } from '../index';
import { buildSeoulCaptureKey } from '../seoulCapture';
import type { Env } from '../types';
import { makeFakeR2, makeEmptyFakeR2 } from './helpers/r2Fixtures';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    TRIPS: {} as Env['TRIPS'],
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

async function getSeoulCaptureKeys(env: Env, query = '', authHeader?: string): Promise<Response> {
  return app.fetch(
    new Request(`http://example.com/admin/seoul-capture/keys${query}`, {
      method: 'GET',
      headers: authHeader ? { authorization: authHeader } : {},
    }),
    env,
  );
}

describe('GET /admin/seoul-capture/keys (#2592)', () => {
  it.each([
    {
      label: '503 when ADMIN_TOKEN is not configured',
      configureEnv: (env: Env) => {
        env.TELEMETRY_R2 = makeEmptyFakeR2();
      },
      authHeader: 'Bearer some-token',
      expectedStatus: 503,
    },
    {
      label: '401 when no Authorization header',
      configureEnv: (env: Env) => {
        env.ADMIN_TOKEN = 'secret';
        env.TELEMETRY_R2 = makeEmptyFakeR2();
      },
      authHeader: undefined,
      expectedStatus: 401,
    },
    {
      label: '401 when token does not match',
      configureEnv: (env: Env) => {
        env.ADMIN_TOKEN = 'secret';
        env.TELEMETRY_R2 = makeEmptyFakeR2();
      },
      authHeader: 'Bearer wrong-token',
      expectedStatus: 401,
    },
    {
      label: '503 when TELEMETRY_R2 binding unavailable',
      configureEnv: (env: Env) => {
        env.ADMIN_TOKEN = 'secret';
      },
      authHeader: 'Bearer secret',
      expectedStatus: 503,
    },
  ])('returns $expectedStatus — $label', async ({ configureEnv, authHeader, expectedStatus }) => {
    const env = makeEnv();
    configureEnv(env);
    const res = await getSeoulCaptureKeys(env, '', authHeader);
    expect(res.status).toBe(expectedStatus);
  });

  it('returns 200 with { keys, count } shape when authorized (delegates to seoulCaptureKeys.ts)', async () => {
    const key = buildSeoulCaptureKey(1_700_000_000_000);
    const env = makeEnv({
      ADMIN_TOKEN: 'secret',
      TELEMETRY_R2: makeFakeR2([{ key, tripEndedAt: 0, body: '' }]),
    });
    const res = await getSeoulCaptureKeys(env, '', 'Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[]; count: number };
    expect(body).toEqual({ keys: [key], count: 1 });
  });

  it('returns 400 invalid_range when range parsing fails (delegated validation)', async () => {
    const env = makeEnv({ ADMIN_TOKEN: 'secret', TELEMETRY_R2: makeEmptyFakeR2() });
    const res = await getSeoulCaptureKeys(env, '?from=&to=100', 'Bearer secret');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_range');
  });

  it('returns 400 range_too_wide when matched keys exceed the cap (delegated scan)', async () => {
    const base = 1_700_000_000_000;
    const keys = Array.from({ length: 5001 }, (_, i) => buildSeoulCaptureKey(base + i));
    const env = makeEnv({
      ADMIN_TOKEN: 'secret',
      TELEMETRY_R2: makeFakeR2(keys.map((key) => ({ key, tripEndedAt: 0, body: '' }))),
    });
    const res = await getSeoulCaptureKeys(env, '', 'Bearer secret');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('range_too_wide');
  });
});
