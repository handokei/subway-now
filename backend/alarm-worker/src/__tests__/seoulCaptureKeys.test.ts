/**
 * GET /admin/seoul-capture/keys (#2592, Epic #2239 P1 후속) — R2 seoul-capture 목록 조회.
 *
 * fixtureFromTrip(#2586/PR#2588)이 aws CLI + R2 S3 토큰 없이 목록을 얻을 수 있도록,
 * worker 자신의 TELEMETRY_R2 바인딩으로 key만 반환하는 endpoint. 객체 본문은 절대
 * 반환하지 않는다(다운로드는 wrangler get --remote 그대로).
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

  it('returns empty keys/count 0 when R2 has no objects and no range given', async () => {
    const env = makeEnv({ ADMIN_TOKEN: 'secret', TELEMETRY_R2: makeEmptyFakeR2() });
    const res = await getSeoulCaptureKeys(env, '', 'Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[]; count: number };
    expect(body.keys).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('returns all keys when from/to not given (full prefix scan)', async () => {
    const k1 = buildSeoulCaptureKey(1_700_000_000_000);
    const k2 = buildSeoulCaptureKey(1_700_000_100_000);
    const env = makeEnv({
      ADMIN_TOKEN: 'secret',
      TELEMETRY_R2: makeFakeR2([
        { key: k1, tripEndedAt: 0, body: '' },
        { key: k2, tripEndedAt: 0, body: '' },
      ]),
    });
    const res = await getSeoulCaptureKeys(env, '', 'Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[]; count: number };
    expect(body.count).toBe(2);
    expect(body.keys.sort()).toEqual([k1, k2].sort());
  });

  it('filters by from<=cycleStartMs<=to across date-partitioned prefixes', async () => {
    // 2026-09-01 ~ 2026-09-03에 걸친 3개 cycle. from/to로 가운데 것만 매칭.
    const day1 = Date.UTC(2026, 8, 1, 12, 0, 0);
    const day2 = Date.UTC(2026, 8, 2, 12, 0, 0);
    const day3 = Date.UTC(2026, 8, 3, 12, 0, 0);
    const k1 = buildSeoulCaptureKey(day1);
    const k2 = buildSeoulCaptureKey(day2);
    const k3 = buildSeoulCaptureKey(day3);
    const env = makeEnv({
      ADMIN_TOKEN: 'secret',
      TELEMETRY_R2: makeFakeR2([
        { key: k1, tripEndedAt: 0, body: '' },
        { key: k2, tripEndedAt: 0, body: '' },
        { key: k3, tripEndedAt: 0, body: '' },
      ]),
    });
    const res = await getSeoulCaptureKeys(
      env,
      `?from=${day2 - 1000}&to=${day2 + 1000}`,
      'Bearer secret',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[]; count: number };
    expect(body.keys).toEqual([k2]);
    expect(body.count).toBe(1);
  });

  it('paginates truncated R2 list() results (pageSize forced small)', async () => {
    const keys = Array.from({ length: 5 }, (_, i) => buildSeoulCaptureKey(1_700_000_000_000 + i * 1000));
    const env = makeEnv({
      ADMIN_TOKEN: 'secret',
      TELEMETRY_R2: makeFakeR2(
        keys.map((key) => ({ key, tripEndedAt: 0, body: '' })),
        2, // pageSize=2 → 최소 3 page 순회 필요
      ),
    });
    const res = await getSeoulCaptureKeys(env, '', 'Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[]; count: number };
    expect(body.count).toBe(5);
    expect(body.keys.sort()).toEqual([...keys].sort());
  });

  it('ignores keys that do not match the {cycleStartMs}.json basename format', async () => {
    const validKey = buildSeoulCaptureKey(1_700_000_000_000);
    const env = makeEnv({
      ADMIN_TOKEN: 'secret',
      TELEMETRY_R2: makeFakeR2([
        { key: validKey, tripEndedAt: 0, body: '' },
        { key: 'seoul-capture/2026-09-01/not-a-number.json', tripEndedAt: 0, body: '' },
      ]),
    });
    const res = await getSeoulCaptureKeys(env, '', 'Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[]; count: number };
    expect(body.keys).toEqual([validKey]);
  });

  it.each([
    { label: 'non-numeric from', query: '?from=abc&to=100' },
    { label: 'non-numeric to', query: '?from=100&to=xyz' },
    { label: 'from > to', query: '?from=200&to=100' },
  ])('returns 400 invalid_range — $label', async ({ query }) => {
    const env = makeEnv({ ADMIN_TOKEN: 'secret', TELEMETRY_R2: makeEmptyFakeR2() });
    const res = await getSeoulCaptureKeys(env, query, 'Bearer secret');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_range');
  });

  it('returns 400 range_too_wide when matched keys exceed 5000', async () => {
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
