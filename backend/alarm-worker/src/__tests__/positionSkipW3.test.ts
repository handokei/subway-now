/**
 * #3006 PR-5 — /position W3(출발역 근접 stamp `originProximityAt`로 인한 trip put) skip.
 *
 * 스펙(이슈 #3006 코멘트 §4 PR-5): skip 조건 `LOCK || trip.currentLegAnchor !== undefined`.
 * 유일한 reader(scheduled.ts maybeFireOriginBoardingPromptGpsFree)는 leg-2(currentLegAnchor)와
 * lock 보유 trip에서 근접 stamp 읽기 전에 return한다 → 해당 trip의 stamp는 쓰이지 않는 write.
 * trip.expiresAt이 길어 W4(TTL 연장)가 끼지 않으므로 trip put은 곧 W3다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

const NOW = Date.UTC(2026, 9, 23, 3, 0, 0);
const TOKEN = 'tok-w3';
const HOUR = 3_600_000;

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as Env['TRIPS'],
    APNS_HOST: 'h',
    APNS_HOST_SANDBOX: 'h',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  };
}

async function seedTrip(kv: InMemoryKV, extra: Record<string, unknown> = {}) {
  await kv.put(
    `trip:${TOKEN}`,
    JSON.stringify({
      token: TOKEN,
      route: { type: 'direct', line: '2', stops: 3 },
      destination: 'dst',
      waypoints: [
        { stationName: '강남', line: '2', kind: 'intermediate' },
        { stationName: '역삼', line: '2', kind: 'destination' },
      ],
      expiresAt: NOW + 3 * HOUR,
      alarmAtEpochMs: 0,
      ...extra,
    }),
  );
}

/** 출발역 근접(거리-정확도 <= margin) 신호를 실은 /position 호출 후 put key 목록을 돌려준다. */
async function postNear(kv: InMemoryKV): Promise<string[]> {
  const putSpy = vi.spyOn(kv, 'put');
  putSpy.mockClear();
  const res = await app.fetch(
    new Request('http://example.com/position', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: TOKEN,
        lat: 37.5,
        lng: 127.0,
        accuracy: 10,
        ts: NOW - 1000,
        motion: 'walking',
        originDistanceM: 50,
        originAccuracyM: 10,
      }),
    }),
    makeEnv(kv),
  );
  expect(res.status).toBe(200);
  return putSpy.mock.calls.map(([key]) => String(key));
}

const tripPuts = (keys: string[]) => keys.filter((k) => k === `trip:${TOKEN}`);
const posPuts = (keys: string[]) => keys.filter((k) => k.startsWith('pos:'));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('#3006 PR-5 — /position W3 skip', () => {
  const setup = () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    return new InMemoryKV();
  };

  it('red ① LOCK 활성 + 출발역 근접 -> trip put 0, originProximityAt 미기록', async () => {
    const kv = setup();
    await seedTrip(kv, { boardingLock: { expiresAt: NOW + HOUR } });
    const keys = await postNear(kv);
    expect(tripPuts(keys)).toHaveLength(0);
    const stored = JSON.parse((await kv.get(`trip:${TOKEN}`)) as string);
    expect(stored.originProximityAt).toBeUndefined();
  });

  it('red ② leg-2 lockless(currentLegAnchor) + 근접 -> trip put 0', async () => {
    const kv = setup();
    await seedTrip(kv, { currentLegAnchor: { boardingStation: '강남', line: '2' } });
    const keys = await postNear(kv);
    expect(tripPuts(keys)).toHaveLength(0);
  });

  it('거부 ① leg-1 lockless + 근접 -> trip put 1, originProximityAt=now (현재와 동일)', async () => {
    const kv = setup();
    await seedTrip(kv);
    const keys = await postNear(kv);
    expect(tripPuts(keys)).toHaveLength(1);
    const stored = JSON.parse((await kv.get(`trip:${TOKEN}`)) as string);
    expect(stored.originProximityAt).toBe(NOW);
  });

  it('거부 ② lock 만료(L6) + 근접 -> trip put 1', async () => {
    const kv = setup();
    await seedTrip(kv, { boardingLock: { expiresAt: NOW - 1 } });
    const keys = await postNear(kv);
    expect(tripPuts(keys)).toHaveLength(1);
  });

  it('거부 ③ W1(pos 시리즈) put 수는 skip 여부와 무관하게 동일(D-4=A)', async () => {
    const lockKv = setup();
    await seedTrip(lockKv, { boardingLock: { expiresAt: NOW + HOUR } });
    const lockKeys = await postNear(lockKv);
    const locklessKv = new InMemoryKV();
    await seedTrip(locklessKv);
    const locklessKeys = await postNear(locklessKv);
    expect(posPuts(lockKeys)).toHaveLength(1);
    expect(posPuts(lockKeys)).toEqual(posPuts(locklessKeys));
  });

  it('거부 ④ skip 대상이어도 W4(TTL 연장)는 유지 -> trip put 1, expiresAt 연장, 근접 stamp 없음', async () => {
    const kv = setup();
    await seedTrip(kv, { boardingLock: { expiresAt: NOW + HOUR }, expiresAt: NOW + 5 * 60_000 });
    const keys = await postNear(kv);
    expect(tripPuts(keys)).toHaveLength(1);
    const stored = JSON.parse((await kv.get(`trip:${TOKEN}`)) as string);
    expect(stored.expiresAt).toBeGreaterThan(NOW + 5 * 60_000);
    expect(stored.originProximityAt).toBeUndefined();
  });
});
