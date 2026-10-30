import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { cleanupTripWithLa, fireLiveActivityDismissal, fireLiveActivityUpdate, type LiveActivityDeps } from '../liveActivity';
import type { Env, Trip } from '../types';
import { makeFakeLaPushDb } from './fakeLaPushDb';
import { InMemoryKV } from './inMemoryKv';

/** #2747 PR-2 — fireLiveActivityUpdate / Dismissal이 la-push를 D1로 관측하는 배선. */
let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
});
beforeEach(() => resetApnsJwtCache());

const NOW = 1_700_000_000_000;
const HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };
const stats = () => ({ laPushSent: 0, laPushFailed: 0, laTokenCleared: 0 });
const CS = { stationName: '군자(능동)', lineName: '5호선', stopsRemaining: 5, etaMinutes: 15 };

function makeTrip(): Trip {
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
  };
}
const ok = () => vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
const fail = () => vi.fn(async () => new Response(JSON.stringify({ reason: 'InternalServerError' }), { status: 500 })) as unknown as typeof fetch;

describe('fireLiveActivityUpdate -> la-push', () => {
  it('path 지정 + 2xx -> 기록, 같은 digest 재push -> 중복 없음', async () => {
    const { db, laPushRows } = makeFakeLaPushDb();
    const deps: LiveActivityDeps = { apnsConfig, apnsHosts: HOSTS, fetchImpl: ok(), db };
    await fireLiveActivityUpdate(makeTrip(), CS, deps, stats(), NOW, () => {}, undefined, undefined, 'update');
    await fireLiveActivityUpdate(makeTrip(), CS, deps, stats(), NOW + 40_000, () => {}, undefined, undefined, 'update');
    expect(laPushRows()).toHaveLength(1);
  });

  it('path 미지정 -> 기록 없음 (기존 호출부 불변)', async () => {
    const { db, rows } = makeFakeLaPushDb();
    await fireLiveActivityUpdate(makeTrip(), CS, { apnsConfig, apnsHosts: HOSTS, fetchImpl: ok(), db }, stats(), NOW, () => {});
    expect(rows).toHaveLength(0);
  });

  it('APNs 실패 -> 기록 없음 (수락된 push만 관측)', async () => {
    const { db, rows } = makeFakeLaPushDb();
    await fireLiveActivityUpdate(makeTrip(), CS, { apnsConfig, apnsHosts: HOSTS, fetchImpl: fail(), db }, stats(), NOW, () => {}, undefined, undefined, 'update');
    expect(rows).toHaveLength(0);
  });

  it('db 미전달 -> 에러 없이 통과', async () => {
    const r = await fireLiveActivityUpdate(makeTrip(), CS, { apnsConfig, apnsHosts: HOSTS, fetchImpl: ok() }, stats(), NOW, () => {}, undefined, undefined, 'update');
    expect(r.sent).toBe(true);
  });
});

describe('fireLiveActivityDismissal / cleanupTripWithLa -> la-push end', () => {
  it('dismissal 2xx -> path=end 1행', async () => {
    const { db, laPushRows } = makeFakeLaPushDb();
    await fireLiveActivityDismissal(makeTrip(), { apnsConfig, apnsHosts: HOSTS, fetchImpl: ok(), db }, stats(), NOW, () => {});
    expect(laPushRows().map((r) => JSON.parse(r.meta as string).path)).toEqual(['end']);
  });

  it('dismissal 실패 -> 기록 없음', async () => {
    const { db, rows } = makeFakeLaPushDb();
    await fireLiveActivityDismissal(makeTrip(), { apnsConfig, apnsHosts: HOSTS, fetchImpl: fail(), db }, stats(), NOW, () => {});
    expect(rows).toHaveLength(0);
  });

  it('cleanupTripWithLa: deps.db 없으면 env.DB로 폴백해 end 기록', async () => {
    const { db, laPushRows } = makeFakeLaPushDb();
    const env = { TRIPS: new InMemoryKV() as unknown as KVNamespace, DB: db } as unknown as Env;
    await cleanupTripWithLa(makeTrip(), env, { apnsConfig, apnsHosts: HOSTS, fetchImpl: ok() }, stats(), NOW, () => {});
    expect(laPushRows()).toHaveLength(1);
  });

  it('cleanupTripWithLa: deps.db가 있으면 그것을 쓴다', async () => {
    const { db, laPushRows } = makeFakeLaPushDb();
    const env = { TRIPS: new InMemoryKV() as unknown as KVNamespace } as Env;
    await cleanupTripWithLa(makeTrip(), env, { apnsConfig, apnsHosts: HOSTS, fetchImpl: ok(), db }, stats(), NOW, () => {});
    expect(laPushRows()).toHaveLength(1);
  });
});
