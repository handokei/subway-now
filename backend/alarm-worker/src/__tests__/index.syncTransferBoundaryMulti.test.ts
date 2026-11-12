/**
 * #3350 F3 — 2회 환승 route에서 1차 transfer를 놓친 lockless trip이 2차 transfer를 관측하면, 그 transfer까지 소비하고 anchor를 찍는다.
 * 관측역이 "소비 범위의 첫 gated"일 필요는 없다(범위 안의 어떤 transfer든, 마지막 소비 waypoint가 transfer이면 경계). intermediate가 끝인 관측은 0.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { resetApnsJwtCache } from '../apns';
import { getTrip, putTrip } from '../trips';
import type { Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeTripEventSink } from './helpers/replay20261019';

const NOW = 1_794_471_000_000;
const WAYPOINTS: Waypoint[] = [
  { stationName: '성수', line: '2', kind: 'intermediate' },
  { stationName: '건대입구', line: '2', kind: 'transfer' },
  { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
  { stationName: '군자(능동)', line: '7', kind: 'transfer' },
  { stationName: '아차산', line: '5', kind: 'intermediate' },
  { stationName: '광나루', line: '5', kind: 'destination' },
];
const TOKEN = 'idx-3350-multi';
const NAMES = WAYPOINTS.map((w) => w.stationName);

describe('POST /boarding-lock/sync — lockless 2회 환승, 1차 transfer 미소비 상태의 2차 관측 (#3350 F3)', () => {
  let kv: InMemoryKV;
  let env: Env;
  let apnsPem: string;

  beforeAll(async () => {
    const { privateKey } = await generateKeyPair('ES256');
    apnsPem = await exportPKCS8(privateKey);
  });

  beforeEach(() => {
    resetApnsJwtCache();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    kv = new InMemoryKV();
    env = {
      TRIPS: kv as unknown as KVNamespace,
      DB: makeTripEventSink().db,
      APNS_HOST: 'api.push.apple.com',
      APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
      SEOUL_API_HOST: 'seoul.api',
      SEOUL_API_KEY: 'KEY',
      APNS_KEY_ID: 'K',
      APNS_TEAM_ID: 'T',
      APNS_PRIVATE_KEY: apnsPem,
      APNS_BUNDLE_ID: 'com.example.app',
    } as Env;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function sync(observedStationName: string) {
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    await app.fetch(
      new Request('http://example.com/boarding-lock/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, observedStationName, observedAtMs: NOW, accuracy: 20 }),
      }),
      env,
      ctx,
    );
    await Promise.all(waits);
    return getTrip(kv as unknown as KVNamespace, TOKEN);
  }

  async function seed() {
    await putTrip(kv as unknown as KVNamespace, {
      token: TOKEN,
      route: { type: 'transfer', transferName: '건대입구', fromLine: '2', toLine: '7', stops: 5, stopsToTransfer: 2, stopsFromTransfer: 3 } as unknown as Trip['route'],
      destination: '광나루',
      waypoints: WAYPOINTS.map((w) => ({ ...w })),
      expiresAt: NOW + 3_600_000,
      createdAt: NOW - 600_000,
      alarmAtEpochMs: NOW,
      infoModeEnabled: true,
    } as Trip);
  }

  it('★2차 transfer(군자) 관측 -> 2차 다음 leg로 전진, anchor=군자/5호선', async () => {
    await seed();
    const after = await sync('군자(능동)');
    expect(after?.waypoints.map((w) => w.stationName)).toEqual(['아차산', '광나루']);
    expect(after?.currentLegAnchor).toEqual({ boardingStation: '군자(능동)', line: '5' });
  });

  it('거부: 2차 너머 intermediate(아차산) 관측은 0 — head·anchor 불변', async () => {
    await seed();
    const after = await sync('아차산');
    expect(after?.waypoints.map((w) => w.stationName)).toEqual(NAMES);
    expect(after?.currentLegAnchor).toBeUndefined();
  });

  it('거부: 1차 transfer 전 intermediate(어린이대공원) 관측은 transfer가 끝이 아니므로 0', async () => {
    await seed();
    const after = await sync('어린이대공원(세종대)');
    expect(after?.waypoints.map((w) => w.stationName)).toEqual(NAMES);
  });

  it('거부: destination(광나루) 관측은 소비하지 않는다', async () => {
    await seed();
    const after = await sync('광나루');
    expect(after?.waypoints.map((w) => w.stationName)).toEqual(NAMES);
  });
});
