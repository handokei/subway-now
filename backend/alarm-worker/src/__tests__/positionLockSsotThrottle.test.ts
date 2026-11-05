/**
 * #3006 PR-6 — LOCK trip의 W6(`ssot:` motion 쓰기) 스로틀 25s -> 90s.
 *
 * LOCK = `isBoardingLockActive(trip, now)` (§1-0). LOCK=false(lockless / 환승 공백 / lock 만료)는 25s 유지.
 * 실측 fixture(replay_20261020_trip172_position)는 dev·로컬 덤프 어디에도 없어 합성 cadence로
 * 경계만 고정한다(실측 절감 수치 11->4 / 35->13은 이 테스트가 증명하지 않는다 — PR 본문 참고).
 *
 * invariants: "LOCK trip의 motionState는 저밀도(>=90s)다. 새 reader를 붙일 때는 LOCK 우회가 필수다."
 * 아래 'LOCK trip의 evidence 밀도' 테스트가 이를 고정한다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import { putTrip } from '../trips';
import { readSsot, seedSsot } from '../tripPositionSsot';
import {
  SSOT_MOTION_WRITE_MIN_INTERVAL_MS,
  SSOT_MOTION_WRITE_MIN_INTERVAL_LOCK_MS,
} from '../motionState';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { CacheLagKV } from './helpers/cacheLagKv';

const T0 = 1_800_000_000_000;
const TOKEN = 'tok-lock-ssot';
const HOUR_MS = 60 * 60_000;

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as Env['TRIPS'],
    APNS_HOST: 'a',
    APNS_HOST_SANDBOX: 'a',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  };
}

function makeTrip(lockExpiresAt: number | null): Trip {
  const base = {
    token: TOKEN,
    route: { type: 'direct', line: '7', stops: 3 },
    destination: 'dst',
    waypoints: [
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '용마산', line: '7', kind: 'destination' },
    ],
    alarmAtEpochMs: 0,
    infoModeEnabled: true,
    createdAt: T0 - 60_000,
    expiresAt: T0 + 10 * HOUR_MS,
  };
  const lock =
    lockExpiresAt === null
      ? {}
      : {
          boardingLock: {
            trainCode: '7246',
            line: '7',
            subwayId: '1007',
            selectedDepartureTime: T0,
            segmentStations: ['중곡', '용마산'],
            expiresAt: lockExpiresAt,
          },
        };
  return { ...base, ...lock } as unknown as Trip;
}

async function post(env: Env, now: number): Promise<void> {
  vi.setSystemTime(now);
  const res = await app.fetch(
    new Request('http://example.com/position', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: TOKEN,
        lat: 37.5,
        lng: 127.0,
        accuracy: 15,
        ts: now,
        motion: 'automotive',
        appState: 'bg',
      }),
    }),
    env,
  );
  expect(res.status).toBe(200);
}

async function setup(kv: InMemoryKV, lockExpiresAt: number | null): Promise<Env> {
  await putTrip(kv as unknown as KVNamespace, makeTrip(lockExpiresAt));
  await seedSsot(kv as unknown as KVNamespace, TOKEN, '중곡', { expiresAt: T0 + 10 * HOUR_MS });
  return makeEnv(kv);
}

function ssotPuts(spy: { mock: { calls: readonly (readonly unknown[])[] } }): number {
  return spy.mock.calls.filter(([k]) => String(k).startsWith('ssot:')).length;
}

/** `intervalMs` 간격으로 `count`회 업로드하고 ssot put 수를 센다. */
async function run(kv: InMemoryKV, env: Env, intervalMs: number, count: number): Promise<number> {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const spy = vi.spyOn(kv, 'put');
  for (let i = 0; i < count; i++) await post(env, T0 + i * intervalMs);
  return ssotPuts(spy);
}

describe('#3006 PR-6 — LOCK이면 W6 스로틀 90s', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('상수: LOCK 간격은 90s, 기본은 25s', () => {
    expect(SSOT_MOTION_WRITE_MIN_INTERVAL_LOCK_MS).toBe(90_000);
    expect(SSOT_MOTION_WRITE_MIN_INTERVAL_MS).toBe(25_000);
  });

  it('LOCK: 30s 간격 업로드 7회(0~180s) -> 0s, 90s, 180s에서만 write = 3', async () => {
    const kv = new InMemoryKV();
    const env = await setup(kv, T0 + 2 * HOUR_MS);
    expect(await run(kv, env, 30_000, 7)).toBe(3);
  });

  it('LOCK 경계: 89.999s는 skip, 90s는 write', async () => {
    const kv = new InMemoryKV();
    const env = await setup(kv, T0 + 2 * HOUR_MS);
    vi.useFakeTimers();
    const spy = vi.spyOn(kv, 'put');
    await post(env, T0);
    await post(env, T0 + 89_999);
    expect(ssotPuts(spy)).toBe(1);
    await post(env, T0 + 90_000);
    expect(ssotPuts(spy)).toBe(2);
  });

  it('LOCK trip의 evidence 밀도: 5분 업로드 후 SSOT evidence 간격은 모두 >= 90s (새 reader는 LOCK 우회 필수)', async () => {
    const kv = new InMemoryKV();
    const env = await setup(kv, T0 + 2 * HOUR_MS);
    await run(kv, env, 30_000, 11);
    const ssot = await readSsot(kv as unknown as KVNamespace, TOKEN);
    const ts = (ssot?.motionEvidence ?? []).map((e) => e.ts).sort((a, b) => a - b);
    expect(ts.length).toBeGreaterThan(1);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(SSOT_MOTION_WRITE_MIN_INTERVAL_LOCK_MS);
    }
  });

  it('거부: lockless는 25s 유지 — 30s 간격 7회 전부 write = 7', async () => {
    const kv = new InMemoryKV();
    const env = await setup(kv, null);
    expect(await run(kv, env, 30_000, 7)).toBe(7);
  });

  it('거부: 만료된 lock(환승 공백/만료)은 lockless 취급 — 25s 유지', async () => {
    const kv = new InMemoryKV();
    const env = await setup(kv, T0 - 1);
    expect(await run(kv, env, 30_000, 7)).toBe(7);
  });

  it('CacheLagKV(lag 30s, 합성 cadence): LOCK write 수가 lockless(35)보다 적다', async () => {
    const lockKv = new CacheLagKV(30_000);
    const lockEnv = await setup(lockKv, T0 + 2 * HOUR_MS);
    const lockPuts = await run(lockKv, lockEnv, 30_000, 35);
    vi.useRealTimers();
    const plainKv = new CacheLagKV(30_000);
    const plainEnv = await setup(plainKv, null);
    const plainPuts = await run(plainKv, plainEnv, 30_000, 35);
    expect(plainPuts).toBe(35);
    expect(lockPuts).toBeLessThan(plainPuts);
  });
});
