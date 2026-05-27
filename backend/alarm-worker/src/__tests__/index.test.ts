import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app, validatePushAck, validateTrip } from '../index';
import { pendingKey } from '../pendingPushes';
import type { AnalyticsEngineWriter, Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

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

const FUTURE = Date.now() + 60 * 60 * 1000;

function base(): Record<string, unknown> {
  return {
    token: 'tok',
    route: { type: 'direct', line: '2', stops: 3 },
    destination: 'dst',
    waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
    expiresAt: FUTURE,
    alarmAtEpochMs: FUTURE - 30 * 60 * 1000,
  };
}

describe('validateTrip', () => {
  it('accepts valid input', () => {
    const trip = validateTrip(base());
    expect(trip?.token).toBe('tok');
  });

  it('rejects non-object', () => {
    expect(validateTrip(null)).toBeNull();
    expect(validateTrip('string')).toBeNull();
  });

  it('rejects missing token', () => {
    const b = base();
    delete b.token;
    expect(validateTrip(b)).toBeNull();
  });

  it('rejects expired trip', () => {
    expect(validateTrip({ ...base(), expiresAt: Date.now() - 1 })).toBeNull();
  });

  it('rejects empty waypoints', () => {
    expect(validateTrip({ ...base(), waypoints: [] })).toBeNull();
  });

  it('rejects invalid waypoint kind', () => {
    expect(
      validateTrip({
        ...base(),
        waypoints: [{ stationName: '강남', line: '2', kind: 'unknown' }],
      }),
    ).toBeNull();
  });

  it('accepts intermediate waypoint kind (#416)', () => {
    const trip = validateTrip({
      ...base(),
      waypoints: [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '강남', line: '2', kind: 'destination' },
      ],
    });
    expect(trip).not.toBeNull();
    expect(trip?.waypoints[0].kind).toBe('intermediate');
  });

  it('rejects malformed waypoint', () => {
    expect(validateTrip({ ...base(), waypoints: [null] })).toBeNull();
    expect(
      validateTrip({ ...base(), waypoints: [{ stationName: 1, line: '2', kind: 'destination' }] }),
    ).toBeNull();
  });

  it('preserves optional lastFiredPhase', () => {
    const trip = validateTrip({ ...base(), lastFiredPhase: 'early', lastEtaSeconds: 120 });
    expect(trip?.lastFiredPhase).toBe('early');
    expect(trip?.lastEtaSeconds).toBe(120);
  });

  it('drops invalid lastFiredPhase', () => {
    const trip = validateTrip({ ...base(), lastFiredPhase: 'bogus' });
    expect(trip?.lastFiredPhase).toBeUndefined();
  });

  it('preserves valid apnsEnv', () => {
    expect(validateTrip({ ...base(), apnsEnv: 'sandbox' })?.apnsEnv).toBe('sandbox');
    expect(validateTrip({ ...base(), apnsEnv: 'production' })?.apnsEnv).toBe('production');
  });

  it('drops invalid apnsEnv', () => {
    expect(validateTrip({ ...base(), apnsEnv: 'bogus' })?.apnsEnv).toBeUndefined();
    expect(validateTrip(base())?.apnsEnv).toBeUndefined();
  });

  it('rejects missing alarmAtEpochMs', () => {
    const b = base();
    delete b.alarmAtEpochMs;
    expect(validateTrip(b)).toBeNull();
  });

  it('rejects missing route', () => {
    const b = base();
    delete b.route;
    expect(validateTrip(b)).toBeNull();
  });
});

describe('POST /telemetry/silent-push', () => {
  const validBody = {
    token: 'aabbccdd11223344',
    since: 0,
    until: 1000,
    received: 3,
    fired: 2,
    skipped: 1,
    skipReasons: { 'gate-out-of-range': 1 },
  };

  it('returns 400 on invalid JSON', async () => {
    const env = makeEnv();
    const res = await post('/telemetry/silent-push', 'not-json{', env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 on invalid payload', async () => {
    const env = makeEnv();
    const res = await post('/telemetry/silent-push', { token: '' }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
  });

  it('writes to TELEMETRY binding when present', async () => {
    const writer: AnalyticsEngineWriter = { writeDataPoint: vi.fn() };
    const env = makeEnv({ TELEMETRY: writer });
    const res = await post('/telemetry/silent-push', validBody, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(writer.writeDataPoint).toHaveBeenCalled();
  });

  it('still returns ok when TELEMETRY binding absent (graceful)', async () => {
    const env = makeEnv();
    const res = await post('/telemetry/silent-push', validBody, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('validatePushAck (#566 P2a)', () => {
  it('accepts valid fired ack', () => {
    expect(validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'fired' })).toEqual({
      pushId: 'p1',
      token: 'tok',
      outcome: 'fired',
    });
  });

  it('accepts valid skipped ack with reason', () => {
    expect(
      validatePushAck({
        pushId: 'p1',
        token: 'tok',
        outcome: 'skipped',
        reason: 'gate-out-of-range',
      }),
    ).toEqual({
      pushId: 'p1',
      token: 'tok',
      outcome: 'skipped',
      reason: 'gate-out-of-range',
    });
  });

  it('rejects non-object', () => {
    expect(validatePushAck(null)).toBeNull();
    expect(validatePushAck('string')).toBeNull();
  });

  it('rejects missing pushId', () => {
    expect(validatePushAck({ token: 'tok', outcome: 'fired' })).toBeNull();
  });

  it('rejects empty pushId', () => {
    expect(validatePushAck({ pushId: '', token: 'tok', outcome: 'fired' })).toBeNull();
  });

  it('rejects missing token', () => {
    expect(validatePushAck({ pushId: 'p1', outcome: 'fired' })).toBeNull();
  });

  it('rejects empty token', () => {
    expect(validatePushAck({ pushId: 'p1', token: '', outcome: 'fired' })).toBeNull();
  });

  it('rejects invalid outcome', () => {
    expect(validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'bogus' })).toBeNull();
  });

  it('ignores non-string reason', () => {
    const ack = validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'skipped', reason: 123 });
    expect(ack).toEqual({ pushId: 'p1', token: 'tok', outcome: 'skipped' });
  });
});

describe('POST /push/ack (#566 P2a)', () => {
  let kv: InMemoryKV;
  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it('returns 400 on invalid JSON', async () => {
    const env = makeEnv({ PENDING_PUSHES: kv as unknown as KVNamespace });
    const res = await post('/push/ack', 'not-json{', env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 on invalid payload (missing token)', async () => {
    const env = makeEnv({ PENDING_PUSHES: kv as unknown as KVNamespace });
    const res = await post('/push/ack', { pushId: 'p1', outcome: 'fired' }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
  });

  it('token 매칭 시 deleted=true로 entry 삭제', async () => {
    await kv.put(pendingKey('p1'), JSON.stringify({ pushId: 'p1', token: 'real-token' }));
    const env = makeEnv({ PENDING_PUSHES: kv as unknown as KVNamespace });
    const res = await post(
      '/push/ack',
      { pushId: 'p1', token: 'real-token', outcome: 'fired' },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: true });
    expect(kv.store.has(pendingKey('p1'))).toBe(false);
  });

  it('token 불일치 시 reason=token-mismatch로 삭제 안 함 (인증 차단)', async () => {
    await kv.put(pendingKey('p1'), JSON.stringify({ pushId: 'p1', token: 'real-token' }));
    const env = makeEnv({ PENDING_PUSHES: kv as unknown as KVNamespace });
    const res = await post(
      '/push/ack',
      { pushId: 'p1', token: 'attacker', outcome: 'fired' },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: false, reason: 'token-mismatch' });
    expect(kv.store.has(pendingKey('p1'))).toBe(true);
  });

  it('entry 만료/미존재 시 reason=not-found (idempotent)', async () => {
    const env = makeEnv({ PENDING_PUSHES: kv as unknown as KVNamespace });
    const res = await post(
      '/push/ack',
      { pushId: 'missing', token: 'tok', outcome: 'skipped' },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: false, reason: 'not-found' });
  });

  it('PENDING_PUSHES 미바인딩 시 reason=not-found (graceful)', async () => {
    const env = makeEnv();
    const res = await post('/push/ack', { pushId: 'p1', token: 'tok', outcome: 'fired' }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: false, reason: 'not-found' });
  });
});
