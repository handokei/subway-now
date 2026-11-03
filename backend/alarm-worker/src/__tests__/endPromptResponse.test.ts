/**
 * #3007 PR-2 — `POST /trips/:token/end-prompt-response {action:'continue'}`.
 * 종료 질문의 [계속] 응답을 backend가 알 수 있게 한다(그 전까지 [계속]은 네트워크 0이라 PR-3 자동 종료가 [계속]을 무시했을 것).
 */
import { describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

const TOKEN = 'tok-ep';
const SHOWN_AT = 1_800_000_000_000;

function makeEnv(db?: Env['DB']): Env {
  return {
    TRIPS: new InMemoryKV() as unknown as Env['TRIPS'],
    ...(db ? { DB: db } : {}),
    APNS_HOST: 'a',
    APNS_HOST_SANDBOX: 'a',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  } as Env;
}

function makeDb() {
  const inserts: unknown[][] = [];
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: (...args: unknown[]) => {
      if (sql.includes('INSERT INTO trip_events')) inserts.push(args);
      return { run: vi.fn().mockResolvedValue({ success: true }), first: vi.fn().mockResolvedValue(null) };
    },
  }));
  return { db: { prepare } as unknown as Env['DB'], inserts };
}

function req(token: string, body: unknown, env: Env) {
  return app.fetch(
    new Request(`http://example.com/trips/${token}/end-prompt-response`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );
}

async function seedTrip(env: Env, overrides: Record<string, unknown> = {}): Promise<void> {
  const trip = {
    token: TOKEN,
    route: { type: 'direct', line: '7', stops: 3 },
    destination: '중곡',
    waypoints: [{ stationName: '중곡', line: '7', kind: 'destination' }],
    expiresAt: Date.now() + 60 * 60_000,
    alarmAtEpochMs: Date.now() + 30 * 60_000,
    createdAt: Date.now() - 60_000,
    ...overrides,
  };
  await env.TRIPS.put(`trip:${TOKEN}`, JSON.stringify(trip));
}

async function readTrip(env: Env): Promise<Record<string, unknown>> {
  return JSON.parse((await env.TRIPS.get(`trip:${TOKEN}`)) as string);
}

describe('POST /trips/:token/end-prompt-response', () => {
  it('continue -> endPromptContinuedAt = now 기록 + 200', async () => {
    const env = makeEnv();
    await seedTrip(env, { endPromptShownAt: SHOWN_AT });
    const before = Date.now();
    const res = await req(TOKEN, { action: 'continue' }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const stored = await readTrip(env);
    expect(stored.endPromptContinuedAt as number).toBeGreaterThanOrEqual(before);
    expect(stored.endPromptShownAt).toBe(SHOWN_AT); // 질문 기록은 건드리지 않는다
  });

  it('D1 trip_events kind=end-prompt-continue 1행 (meta에 shownAt)', async () => {
    const { db, inserts } = makeDb();
    const env = makeEnv(db);
    await seedTrip(env, { endPromptShownAt: SHOWN_AT });
    await req(TOKEN, { action: 'continue' }, env);
    const rows = inserts.filter((a) => a[2] === 'end-prompt-continue');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0][5] as string)).toMatchObject({ shownAt: SHOWN_AT });
  });

  it('질문 기록이 없어도(경합) 기록하고 meta.shownAt은 null', async () => {
    const { db, inserts } = makeDb();
    const env = makeEnv(db);
    await seedTrip(env);
    const res = await req(TOKEN, { action: 'continue' }, env);
    expect(res.status).toBe(200);
    expect((await readTrip(env)).endPromptContinuedAt).toBeTypeOf('number');
    const rows = inserts.filter((a) => a[2] === 'end-prompt-continue');
    expect(JSON.parse(rows[0][5] as string)).toEqual({ shownAt: null });
  });

  it('trip 부재 -> 404 trip_not_found, D1 행 없음', async () => {
    const { db, inserts } = makeDb();
    const env = makeEnv(db);
    const res = await req('nope', { action: 'continue' }, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'trip_not_found' });
    expect(inserts.filter((a) => a[2] === 'end-prompt-continue')).toHaveLength(0);
  });

  it('깨진 JSON -> 400 invalid_json', async () => {
    const env = makeEnv();
    await seedTrip(env);
    const res = await req(TOKEN, '{', env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it.each([[{}], [{ action: 'end' }], [{ action: 1 }], [null], ['"x"']])(
    '허용되지 않은 payload %j -> 400 invalid_payload, 기록 없음',
    async (body) => {
      const env = makeEnv();
      await seedTrip(env);
      const res = await req(TOKEN, body, env);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_payload' });
      expect((await readTrip(env)).endPromptContinuedAt).toBeUndefined();
    },
  );
});
