import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import {
  LA_STALE_DURATION_SEC,
  buildLiveActivityContentState,
  cleanupTripWithLa,
  fireLiveActivityDismissal,
  fireLiveActivityUpdate,
  type LiveActivityDeps,
  type LiveActivityStats,
} from '../liveActivity';
import type { ApnsEnv, Env, Trip, Waypoint } from '../types';
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

const NOW = 1_700_000_000_000;
const APNS_HOSTS: Record<ApnsEnv, string> = {
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com',
};

function makeStats(): LiveActivityStats {
  return { laPushSent: 0, laPushFailed: 0, laTokenCleared: 0 };
}

function makeDeps(fetchImpl: typeof fetch): LiveActivityDeps {
  return { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'devtoken',
    route: { type: 'direct', line: '2', stops: 3 },
    destination: 'dst',
    waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
    expiresAt: NOW + 3_600_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW + 60_000,
    activityPushToken: 'la-token',
    activityState: 'live',
    apnsEnv: 'sandbox',
    ...overrides,
  };
}

const WAYPOINT: Waypoint = { stationName: '강남', line: '2', kind: 'destination' };

describe('buildLiveActivityContentState', () => {
  it('includes numeric/enum fields only (no text)', () => {
    const cs = buildLiveActivityContentState(WAYPOINT, 90, 'early', 3, NOW);
    expect(cs).toEqual({
      etaSeconds: 90,
      phase: 'early',
      kind: 'destination',
      stopsRemaining: 3,
      arrivalAtSec: Math.floor(NOW / 1000) + 90,
    });
  });
});

describe('fireLiveActivityUpdate', () => {
  it('no-ops when activityPushToken is missing', async () => {
    const fetchImpl = vi.fn();
    const stats = makeStats();
    const trip = makeTrip({ activityPushToken: undefined });
    const r = await fireLiveActivityUpdate(
      trip,
      { etaSeconds: 1 },
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(r.dirty).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stats.laPushSent).toBe(0);
  });

  it('no-ops when activityState is not live (ended)', async () => {
    const fetchImpl = vi.fn();
    const stats = makeStats();
    const trip = makeTrip({ activityState: 'ended' });
    const r = await fireLiveActivityUpdate(
      trip,
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(r.dirty).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts to LA endpoint with staleDate = now/1000 + 90 and increments laPushSent on success', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = makeStats();
    const trip = makeTrip();
    await fireLiveActivityUpdate(
      trip,
      { etaSeconds: 30 },
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${APNS_HOSTS.sandbox}/3/device/la-token`);
    const body = JSON.parse(init.body as string);
    expect(body.aps.event).toBe('update');
    expect(body.aps['stale-date']).toBe(Math.floor(NOW / 1000) + LA_STALE_DURATION_SEC);
    expect(stats.laPushSent).toBe(1);
    expect(stats.laPushFailed).toBe(0);
  });

  it('uses production host when apnsEnv=production', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const trip = makeTrip({ apnsEnv: 'production' });
    await fireLiveActivityUpdate(
      trip,
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
    );
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${APNS_HOSTS.production}/3/device/la-token`);
  });

  it('clears token + sets ended on 410 (dirty=true)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 410 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    const r = await fireLiveActivityUpdate(
      trip,
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(r.dirty).toBe(true);
    expect(trip.activityPushToken).toBeUndefined();
    expect(trip.activityState).toBe('ended');
    expect(stats.laPushFailed).toBe(1);
    expect(stats.laTokenCleared).toBe(1);
  });

  it('does not clear on non-410 failure (dirty=false)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'InternalServerError' }), { status: 500 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    const r = await fireLiveActivityUpdate(
      trip,
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(r.dirty).toBe(false);
    expect(trip.activityPushToken).toBe('la-token');
    expect(stats.laPushFailed).toBe(1);
    expect(stats.laTokenCleared).toBe(0);
  });
});

describe('fireLiveActivityDismissal', () => {
  it('no-ops when no token', async () => {
    const fetchImpl = vi.fn();
    const trip = makeTrip({ activityPushToken: undefined });
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no-ops when state is already ended', async () => {
    const fetchImpl = vi.fn();
    const trip = makeTrip({ activityState: 'ended' });
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends end event with dismissalDate=now/1000 and transitions trip to ended on success', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = makeStats();
    const trip = makeTrip();
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.aps.event).toBe('end');
    expect(body.aps['dismissal-date']).toBe(Math.floor(NOW / 1000));
    expect(trip.activityPushToken).toBeUndefined();
    expect(trip.activityState).toBe('ended');
    expect(stats.laPushSent).toBe(1);
  });

  it('still transitions to ended even when push fails (best-effort)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 410 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(trip.activityPushToken).toBeUndefined();
    expect(trip.activityState).toBe('ended');
    expect(stats.laPushFailed).toBe(1);
    expect(stats.laTokenCleared).toBe(1);
  });

  it('increments laPushFailed but not laTokenCleared on non-410 failure', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'ServerUnavailable' }), { status: 503 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(stats.laPushFailed).toBe(1);
    expect(stats.laTokenCleared).toBe(0);
  });
});

describe('cleanupTripWithLa', () => {
  it('fires dismissal then deletes trip from KV', async () => {
    const kv = new InMemoryKV();
    await kv.put('trip:devtoken', JSON.stringify(makeTrip()));
    const env = { TRIPS: kv as unknown as KVNamespace } as Env;
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = makeStats();
    await cleanupTripWithLa(
      makeTrip(),
      env,
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(stats.laPushSent).toBe(1);
    expect(await kv.get('trip:devtoken')).toBeNull();
  });

  it('still deletes trip when no LA token (no push fired)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({ activityPushToken: undefined });
    await kv.put('trip:devtoken', JSON.stringify(trip));
    const env = { TRIPS: kv as unknown as KVNamespace } as Env;
    const fetchImpl = vi.fn();
    await cleanupTripWithLa(
      trip,
      env,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await kv.get('trip:devtoken')).toBeNull();
  });
});
