/**
 * #3006 PR-1 — POST /position의 SSOT write가 trip 수명과 분리돼 있던 결함.
 *
 * `updateSsotMotion`이 trip 존재를 확인하지 않고 `writeSsot`를 **TTL 없이** 호출했다.
 * trip 키가 TTL로 소멸해도 SSOT가 남아 있으면 /position이 매 호출 TTL 없는 키를 되살린다
 * (영구 키 + 쓰기 쿼터 소모). 스펙: trip이 없으면 SSOT/trip/motion write 모두 skip, 있으면
 * SSOT TTL을 (연장 이후) trip.expiresAt에 맞춘다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app, TRIP_ACTIVITY_EXTENSION_MS } from '../index';
import { putTrip } from '../trips';
import { readSsot, seedSsot, ssotKey } from '../tripPositionSsot';
import { applyLegConsensusTick } from '../advanceTripPosition';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { CacheLagKV } from './helpers/cacheLagKv';

const T0 = 1_800_000_000_000;
const TOKEN = 'tok-ssot-ttl';
const TWO_HOURS_SEC = 2 * 60 * 60;

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as Env['TRIPS'],
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  };
}

function makeTrip(expiresAt: number): Trip {
  return {
    token: TOKEN,
    route: { type: 'direct', line: '2', stops: 3 },
    destination: 'dst',
    waypoints: [
      { stationName: '강남', line: '2', kind: 'intermediate' },
      { stationName: '역삼', line: '2', kind: 'destination' },
    ],
    alarmAtEpochMs: 0,
    infoModeEnabled: true,
    createdAt: T0 - 60_000,
    expiresAt,
  } as unknown as Trip;
}

function positionBody(now: number): Record<string, unknown> {
  return {
    token: TOKEN,
    lat: 37.5,
    lng: 127.0,
    accuracy: 15,
    ts: now,
    motion: 'automotive',
    appState: 'bg',
  };
}

async function postPosition(
  env: Env,
  now: number,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return app.fetch(
    new Request('http://example.com/position', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...positionBody(now), ...extra }),
    }),
    env,
  );
}

function putsTo(spy: { mock: { calls: readonly (readonly unknown[])[] } }, prefix: string): unknown[][] {
  return spy.mock.calls.filter(([key]) => String(key).startsWith(prefix)).map((c) => [...c]);
}

describe('#3006 PR-1 — /position SSOT write TTL', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('R1 — trip 키가 소멸했는데 SSOT만 남아 있으면 ssot를 쓰지 않는다 (영구 키 부활 금지)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const kv = new InMemoryKV();
    await seedSsot(kv as unknown as KVNamespace, TOKEN, '0228');
    const putSpy = vi.spyOn(kv, 'put');

    const res = await postPosition(makeEnv(kv), T0);

    expect(res.status).toBe(200);
    expect(putsTo(putSpy, 'ssot:')).toHaveLength(0);
    expect(putsTo(putSpy, 'trip:')).toHaveLength(0);
    // 응답 계약 불변: pos 시리즈 append(W1)는 trip과 무관하게 계속된다.
    expect(putsTo(putSpy, 'pos:')).toHaveLength(1);
  });

  it('R2 — trip이 있으면 ssot put에 trip.expiresAt 기반 expirationTtl이 실린다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip(T0 + TWO_HOURS_SEC * 1000));
    await seedSsot(kv as unknown as KVNamespace, TOKEN, '0228');
    const putSpy = vi.spyOn(kv, 'put');

    await postPosition(makeEnv(kv), T0);

    const ssotPuts = putsTo(putSpy, 'ssot:');
    expect(ssotPuts).toHaveLength(1);
    expect((ssotPuts[0][2] as { expirationTtl?: number }).expirationTtl).toBe(TWO_HOURS_SEC);
  });

  it('R3 — 잔여 5분 trip: trip put 1회(+2h 연장) + ssot TTL도 연장 이후 값(약 2h)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip(T0 + 5 * 60 * 1000));
    await seedSsot(kv as unknown as KVNamespace, TOKEN, '0228');
    const putSpy = vi.spyOn(kv, 'put');
    putSpy.mockClear();

    await postPosition(makeEnv(kv), T0);

    const tripPuts = putsTo(putSpy, 'trip:');
    expect(tripPuts).toHaveLength(1);
    const storedTrip = JSON.parse(String(tripPuts[0][1])) as Trip;
    expect(storedTrip.expiresAt).toBe(T0 + TRIP_ACTIVITY_EXTENSION_MS);

    const ssotPuts = putsTo(putSpy, 'ssot:');
    expect(ssotPuts).toHaveLength(1);
    const ttl = (ssotPuts[0][2] as { expirationTtl?: number }).expirationTtl;
    expect(ttl).toBe(Math.floor(TRIP_ACTIVITY_EXTENSION_MS / 1000));
  });

  it('R3b — 근접 stamp와 TTL 연장이 동시에 해당돼도 trip put은 1회, 두 변경이 모두 저장된다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip(T0 + 5 * 60 * 1000));
    const putSpy = vi.spyOn(kv, 'put');
    putSpy.mockClear();

    await postPosition(makeEnv(kv), T0, { originDistanceM: 50, originAccuracyM: 10 });

    const tripPuts = putsTo(putSpy, 'trip:');
    expect(tripPuts).toHaveLength(1);
    const stored = JSON.parse(String(tripPuts[0][1])) as Trip;
    expect(stored.expiresAt).toBe(T0 + TRIP_ACTIVITY_EXTENSION_MS);
    expect(stored.originProximityAt).toBe(T0);
  });

  it('R4 — 종료 직후 캐시 lag 창(20s)의 /position: stale trip이 보여도 ssot TTL은 옛 trip.expiresAt 이하', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const kv = new CacheLagKV(30_000);
    const expiresAt = T0 + TWO_HOURS_SEC * 1000;
    await putTrip(kv as unknown as KVNamespace, makeTrip(expiresAt));
    await seedSsot(kv as unknown as KVNamespace, TOKEN, '0228');
    // 정상 종료(삭제) — 60s 시점.
    vi.setSystemTime(T0 + 60_000);
    await kv.delete(`trip:${TOKEN}`);
    await kv.delete(ssotKey(TOKEN));
    // 종료 20s 뒤 -> 캐시는 아직 삭제 전 버전(trip+ssot)을 보여준다.
    vi.setSystemTime(T0 + 80_000);
    const putSpy = vi.spyOn(kv, 'put');

    await postPosition(makeEnv(kv), T0 + 80_000);

    const ssotPuts = putsTo(putSpy, 'ssot:');
    expect(ssotPuts.length).toBeGreaterThan(0);
    for (const call of ssotPuts) {
      const ttl = (call[2] as { expirationTtl?: number } | undefined)?.expirationTtl;
      expect(ttl).toBeDefined();
      expect(ttl as number).toBeLessThanOrEqual(Math.ceil((expiresAt - (T0 + 80_000)) / 1000));
    }
  });

  it('R5 — applyLegConsensusTick: trip이 없으면 ssot를 쓰지 않는다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const kv = new InMemoryKV();
    await seedSsot(kv as unknown as KVNamespace, TOKEN, '0228');
    const putSpy = vi.spyOn(kv, 'put');

    await applyLegConsensusTick(kv as unknown as KVNamespace, undefined, TOKEN, {
      init: {
        t0EpochMs: T0,
        transferTimeSec: 278,
        headwaySec: 210,
        observedDepartures: [{ trainCode: '7246', departureEpochMs: T0 + 278_000 }],
      },
      tick: { now: T0, observations: [{ trainCode: '7246', deltaSec: 0 }] },
    });

    expect(putsTo(putSpy, 'ssot:')).toHaveLength(0);
    const after = await readSsot(kv as unknown as KVNamespace, TOKEN);
    expect(after?.legConsensus).toBeUndefined();
  });

  it('거부 — getTrip이 throw하면 200 + degraded, pos만 쓰고 ssot/trip은 쓰지 않는다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip(T0 + TWO_HOURS_SEC * 1000));
    await seedSsot(kv as unknown as KVNamespace, TOKEN, '0228');
    const realGet = kv.get.bind(kv);
    vi.spyOn(kv, 'get').mockImplementation(async (key: string, opts?: { cacheTtl?: number }) => {
      if (key.startsWith('trip:')) throw new Error('KV GET failed: 503');
      return realGet(key, opts);
    });
    const putSpy = vi.spyOn(kv, 'put');

    const res = await postPosition(makeEnv(kv), T0);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, degraded: true });
    expect(putsTo(putSpy, 'pos:')).toHaveLength(1);
    expect(putsTo(putSpy, 'ssot:')).toHaveLength(0);
    expect(putsTo(putSpy, 'trip:')).toHaveLength(0);
  });

  it('거부 — trip 없음 + lag 0: 수정 전후 모두 ssot/trip put 0 (분기 A 정상 종료 직후)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const kv = new InMemoryKV();
    const putSpy = vi.spyOn(kv, 'put');

    const res = await postPosition(makeEnv(kv), T0);

    expect(res.status).toBe(200);
    expect(putsTo(putSpy, 'ssot:')).toHaveLength(0);
    expect(putsTo(putSpy, 'trip:')).toHaveLength(0);
  });
});
