import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCH_FLAG_KV_KEY } from '../archFlag';
import {
  cleanupPendingPushesForToken,
  clearStaleBoardingLock,
  computeRouteSignature,
  deleteTrip,
  getTrip,
  listTrips,
  putTrip,
  rotateTripTokenForNewRoute,
  tripKey,
} from '../trips';
import { pendingKey, putPending, type PendingPush } from '../pendingPushes';
import type { Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'tok-1',
    route: { type: 'direct', line: '2', stops: 5 },
    destination: '0228',
    waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
    expiresAt: Date.now() + 60 * 60 * 1000,
    createdAt: Date.now(),
    alarmAtEpochMs: Date.now() + 30 * 60 * 1000,
    ...overrides,
  };
}

describe('trips KV CRUD', () => {
  let kv: InMemoryKV;
  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it('tripKey builds prefix', () => {
    expect(tripKey('abc')).toBe('trip:abc');
  });

  it('put + get round-trip', async () => {
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    const loaded = await getTrip(kv as unknown as KVNamespace, 'tok-1');
    expect(loaded?.token).toBe('tok-1');
    expect(loaded?.waypoints[0].stationName).toBe('강남');
  });

  it('get returns null for unknown key', async () => {
    expect(await getTrip(kv as unknown as KVNamespace, 'missing')).toBeNull();
  });

  it('get returns null on malformed json', async () => {
    await kv.put('trip:bad', 'not-json');
    expect(await getTrip(kv as unknown as KVNamespace, 'bad')).toBeNull();
  });

  it('delete removes entry', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    await deleteTrip(kv as unknown as KVNamespace, 'tok-1');
    expect(await getTrip(kv as unknown as KVNamespace, 'tok-1')).toBeNull();
  });

  it('listTrips enumerates with prefix', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip({ token: 'a' }));
    await putTrip(kv as unknown as KVNamespace, makeTrip({ token: 'b' }));
    // unrelated key should not be returned
    await kv.put('other:c', 'x');
    const tokens: string[] = [];
    for await (const t of listTrips(kv as unknown as KVNamespace)) {
      tokens.push(t.token);
    }
    expect(tokens.sort((a, b) => a.localeCompare(b))).toEqual(['a', 'b']);
  });

  it('listTrips skips malformed entries', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip({ token: 'good' }));
    await kv.put('trip:bad', 'not-json');
    const tokens: string[] = [];
    for await (const t of listTrips(kv as unknown as KVNamespace)) {
      tokens.push(t.token);
    }
    expect(tokens).toEqual(['good']);
  });

  // #766/#770/#1381 — cron read는 KV 최소 제약(30s)을 지키면서 첫 사이클 stale window를 차단.
  it('listTrips passes cacheTtl=30 to kv.get (#1381 KV 최소 제약 준수)', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip({ token: 'a' }));
    const spy = vi.spyOn(kv, 'get');
    for await (const _t of listTrips(kv as unknown as KVNamespace)) {
      // consume
    }
    const tripGetCall = spy.mock.calls.find(([key]) => key === 'trip:a');
    expect(tripGetCall?.[1]).toEqual({ cacheTtl: 30 });
  });

  // #1381 회귀 가드 — Cloudflare KV runtime은 cacheTtl<30 요청을 throw한다.
  // production runtime을 mimic하는 InMemoryKV wrapping으로 listTrips가 throw 없이
  // 완주하는지 확인 (CRON_READ_CACHE_TTL_SEC=0 회귀 시 즉시 fail).
  it('listTrips does not violate Cloudflare KV cacheTtl>=30 constraint (#1381 회귀 가드)', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip({ token: 'a' }));
    const guardedKv = {
      ...kv,
      get: vi.fn(async (key: string, options?: { cacheTtl?: number }) => {
        if (options?.cacheTtl !== undefined && options.cacheTtl < 30) {
          throw new Error(
            `KV GET failed: 400 Invalid cache_ttl of ${options.cacheTtl}. Cache TTL must be at least 30.`,
          );
        }
        return kv.get(key, options);
      }),
      list: kv.list.bind(kv),
    };
    const tokens: string[] = [];
    for await (const t of listTrips(guardedKv as unknown as KVNamespace)) {
      tokens.push(t.token);
    }
    expect(tokens).toEqual(['a']);
  });

  // #1364 — getTrip은 caller가 cacheTtl 지정 가능. read-after-write verification 경로.
  // #1423 — caller가 명시한 cacheTtl은 `assertKvCacheTtl`이 KV 런타임 floor 검증 후 forward.
  it('getTrip forwards cacheTtl=30 option to kv.get when provided (#1364/#1423)', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const spy = vi.spyOn(kv, 'get');
    await getTrip(kv as unknown as KVNamespace, 'tok-1', { cacheTtl: 30 });
    expect(spy).toHaveBeenCalledWith('trip:tok-1', { cacheTtl: 30 });
  });

  it('getTrip omits options arg when cacheTtl not specified (default KV cache)', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const spy = vi.spyOn(kv, 'get');
    await getTrip(kv as unknown as KVNamespace, 'tok-1');
    expect(spy).toHaveBeenCalledWith('trip:tok-1');
  });

  // #1423 — getTrip은 caller가 cacheTtl<30을 넘기면 caller 단계에서 RangeError throw.
  // production CF KV가 `Invalid cache_ttl` 400 throw하는 시점보다 한 단계 앞서 root cause를
  // 분명히 한다. `verifyBoardingLockPersisted`가 cacheTtl=0으로 호출해 sync handler 전체를
  // 실패시킨 회귀를 caller 단계에서 차단.
  it.each([
    ['0 (#1423 evidence)', 0],
    ['15 (잘못된 cron 시도값)', 15],
    ['29 (boundary)', 29],
  ])('getTrip throws RangeError when cacheTtl=%s (< 30)', async (_label, ttl) => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    await expect(getTrip(kv as unknown as KVNamespace, 'tok-1', { cacheTtl: ttl })).rejects.toThrow(
      /cacheTtl >= 30s/,
    );
  });

  it('getTrip allows cacheTtl=30 (boundary, KV 최소값)', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    await expect(
      getTrip(kv as unknown as KVNamespace, 'tok-1', { cacheTtl: 30 }),
    ).resolves.not.toBeNull();
  });

  // #1364 Layer 4 — stale lock auto-clear (line mismatch).
  describe('clearStaleBoardingLock (#1364 Layer 4)', () => {
    function lockedTrip(lockLine: string, headLine: string): Trip {
      return makeTrip({
        waypoints: [{ stationName: '강남', line: headLine, kind: 'destination' }],
        boardingLock: {
          trainCode: 'T-1',
          line: lockLine,
          subwayId: '1002',
          selectedDepartureTime: 1,
          segmentStations: ['강남'],
          expiresAt: Date.now() + 60_000,
        },
      });
    }

    it('lock.line === waypoints[0].line → 그대로 유지', () => {
      const trip = lockedTrip('2', '2');
      expect(clearStaleBoardingLock(trip).boardingLock).toBeDefined();
    });

    it('lock.line !== waypoints[0].line → boardingLock 제거', () => {
      const trip = lockedTrip('2', '7');
      expect(clearStaleBoardingLock(trip).boardingLock).toBeUndefined();
    });

    it('lock 없는 trip → no-op', () => {
      const trip = makeTrip();
      expect(clearStaleBoardingLock(trip)).toBe(trip);
    });

    it('waypoints 비어 있으면 no-op (정리 책임은 cleanup path)', () => {
      const trip = lockedTrip('2', '2');
      const empty = { ...trip, waypoints: [] };
      expect(clearStaleBoardingLock(empty).boardingLock).toBeDefined();
    });
  });

  // #1364 — cron read 경로(listTrips)는 stale lock을 자동 정리.
  it('listTrips auto-clears stale boardingLock on line mismatch (#1364)', async () => {
    const trip: Trip = {
      token: 'tok-stale',
      route: { type: 'direct', line: '2', stops: 5 },
      destination: '0228',
      waypoints: [{ stationName: '강남', line: '7', kind: 'destination' }],
      expiresAt: Date.now() + 60 * 60 * 1000,
      createdAt: Date.now(),
      alarmAtEpochMs: Date.now() + 30 * 60 * 1000,
      boardingLock: {
        trainCode: 'T-1',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: 1,
        segmentStations: ['강남'],
        expiresAt: Date.now() + 60_000,
      },
    };
    await putTrip(kv as unknown as KVNamespace, trip);
    const yielded: Trip[] = [];
    for await (const t of listTrips(kv as unknown as KVNamespace)) {
      yielded.push(t);
    }
    expect(yielded).toHaveLength(1);
    expect(yielded[0].boardingLock).toBeUndefined();
  });

  // ADR-022 B4 — 새 route = 새 token 강제 (#1986).
  describe('ADR-022 B4 — trip token rotation (#1986)', () => {
    function makePending(overrides: Partial<PendingPush> = {}): PendingPush {
      return {
        pushId: 'push-1',
        token: 'tok-A',
        alarmKey: 'early:강남',
        sentAt: Date.now(),
        stationName: '강남',
        kind: 'destination',
        phase: 'early',
        etaSeconds: 300,
        apnsEnv: 'sandbox',
        ...overrides,
      };
    }

    describe('arch flag default (Phase 1-3, #2002 real helper wire)', () => {
      it('KV 미설정 → default OFF: `rotateTripTokenForNewRoute` 기존 동작 유지', async () => {
        // KV 에 arch flag 미설정 → getArchFlag 는 default 'off' 반환 → rotation 없음.
        const existing = makeTrip({ token: 'tok-old', destination: 'D-1' });
        await putTrip(kv as unknown as KVNamespace, existing);
        const incoming = makeTrip({ token: 'tok-old', destination: 'D-2' });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          existing,
        );
        expect(result).toEqual({ token: 'tok-old', rotated: false });
      });
    });

    describe('computeRouteSignature', () => {
      it('destination + waypoints 시퀀스로 시그니처 생성', () => {
        const trip = makeTrip({
          destination: 'D-1',
          waypoints: [
            { stationName: 'A', line: '2', kind: 'intermediate', occurrenceIdx: 0 },
            { stationName: 'B', line: '2', kind: 'destination', occurrenceIdx: 1 },
          ],
        });
        expect(computeRouteSignature(trip)).toBe(
          'D-1::A|2|intermediate|0/B|2|destination|1',
        );
      });

      it('occurrenceIdx 부재는 0으로 fallback (backward compat)', () => {
        const trip = makeTrip({
          destination: 'D-2',
          waypoints: [{ stationName: 'A', line: '1', kind: 'destination' }],
        });
        expect(computeRouteSignature(trip)).toBe('D-2::A|1|destination|0');
      });

      it('같은 destination + waypoints → 시그니처 동일', () => {
        const a = makeTrip({
          destination: 'D',
          waypoints: [{ stationName: 'S', line: '2', kind: 'destination' }],
        });
        const b = makeTrip({
          token: 'other-token',
          destination: 'D',
          waypoints: [{ stationName: 'S', line: '2', kind: 'destination' }],
        });
        expect(computeRouteSignature(a)).toBe(computeRouteSignature(b));
      });

      it('다른 destination → 다른 시그니처', () => {
        const a = makeTrip({ destination: 'D-1' });
        const b = makeTrip({ destination: 'D-2' });
        expect(computeRouteSignature(a)).not.toBe(computeRouteSignature(b));
      });

      it('waypoints 순서 다름 → 다른 시그니처', () => {
        const a = makeTrip({
          waypoints: [
            { stationName: 'A', line: '2', kind: 'intermediate' },
            { stationName: 'B', line: '2', kind: 'destination' },
          ],
        });
        const b = makeTrip({
          waypoints: [
            { stationName: 'B', line: '2', kind: 'intermediate' },
            { stationName: 'A', line: '2', kind: 'destination' },
          ],
        });
        expect(computeRouteSignature(a)).not.toBe(computeRouteSignature(b));
      });
    });

    describe('cleanupPendingPushesForToken', () => {
      it('oldToken 소유의 pending entry만 delete + removed count 반환', async () => {
        await putPending(
          kv as unknown as KVNamespace,
          makePending({ pushId: 'p1', token: 'tok-old' }),
        );
        await putPending(
          kv as unknown as KVNamespace,
          makePending({ pushId: 'p2', token: 'tok-old' }),
        );
        await putPending(
          kv as unknown as KVNamespace,
          makePending({ pushId: 'p3', token: 'tok-other' }),
        );
        const removed = await cleanupPendingPushesForToken(
          kv as unknown as KVNamespace,
          'tok-old',
        );
        expect(removed).toBe(2);
        expect(await kv.get(pendingKey('p1'))).toBeNull();
        expect(await kv.get(pendingKey('p2'))).toBeNull();
        // 다른 device 소유는 보존
        expect(await kv.get(pendingKey('p3'))).not.toBeNull();
      });

      it('매칭 entry 없음 → 0 반환', async () => {
        await putPending(
          kv as unknown as KVNamespace,
          makePending({ pushId: 'p1', token: 'tok-other' }),
        );
        const removed = await cleanupPendingPushesForToken(
          kv as unknown as KVNamespace,
          'tok-none',
        );
        expect(removed).toBe(0);
        expect(await kv.get(pendingKey('p1'))).not.toBeNull();
      });
    });

    describe('rotateTripTokenForNewRoute (flag OFF)', () => {
      it('flag OFF (KV 미설정 default): 항상 incoming token 그대로 반환 + KV 변경 없음', async () => {
        const existing = makeTrip({ token: 'tok-old', destination: 'D-1' });
        await putTrip(kv as unknown as KVNamespace, existing);
        const incoming = makeTrip({ token: 'tok-old', destination: 'D-2' });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          existing,
        );
        expect(result).toEqual({ token: 'tok-old', rotated: false });
        // KV cleanup 없음
        expect(await getTrip(kv as unknown as KVNamespace, 'tok-old')).not.toBeNull();
      });

      it('flag OFF: existing null이어도 동일 (incoming 그대로)', async () => {
        const incoming = makeTrip({ token: 'tok-new' });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          null,
        );
        expect(result).toEqual({ token: 'tok-new', rotated: false });
      });

      it('flag OFF: deps.simpleArchEnabled=false 명시도 동일 (DI 우선)', async () => {
        // #2002 — KV 에 flag=on 있어도 deps 명시가 우선 → OFF 동작.
        await kv.put(ARCH_FLAG_KV_KEY, 'on');
        const existing = makeTrip({ token: 'tok-A', destination: 'D-1' });
        const incoming = makeTrip({ token: 'tok-A', destination: 'D-2' });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          existing,
          { simpleArchEnabled: false },
        );
        expect(result).toEqual({ token: 'tok-A', rotated: false });
      });

      it('flag OFF: KV value 오타 (default fallback)도 OFF 동작', async () => {
        // #2002 — getArchFlag 는 'on' | 'off' 외 값을 default 'off' 로 정규화 → rotation 없음.
        await kv.put(ARCH_FLAG_KV_KEY, 'invalid-value');
        const existing = makeTrip({ token: 'tok-old', destination: 'D-1' });
        await putTrip(kv as unknown as KVNamespace, existing);
        const incoming = makeTrip({ token: 'tok-old', destination: 'D-2' });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          existing,
        );
        expect(result).toEqual({ token: 'tok-old', rotated: false });
      });
    });

    describe('rotateTripTokenForNewRoute (flag ON)', () => {
      it('existing 없음 (신규 trip): incoming 그대로 (rotated=false)', async () => {
        const incoming = makeTrip({ token: 'tok-new' });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          null,
          { simpleArchEnabled: true },
        );
        expect(result).toEqual({ token: 'tok-new', rotated: false });
      });

      it('같은 route (시그니처 일치): incoming token 유지 (rotated=false)', async () => {
        const existing = makeTrip({
          token: 'tok-same',
          destination: 'D-1',
          waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
        });
        await putTrip(kv as unknown as KVNamespace, existing);
        const incoming = makeTrip({
          token: 'tok-same',
          destination: 'D-1',
          waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
        });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          existing,
          { simpleArchEnabled: true },
        );
        expect(result).toEqual({ token: 'tok-same', rotated: false });
        // 같은 route → cleanup 없음
        expect(await getTrip(kv as unknown as KVNamespace, 'tok-same')).not.toBeNull();
      });

      it('다른 destination: 새 token 발급 + old trip:<token> delete + rotated=true', async () => {
        const existing = makeTrip({ token: 'tok-old', destination: 'D-1' });
        await putTrip(kv as unknown as KVNamespace, existing);
        const incoming = makeTrip({ token: 'tok-old', destination: 'D-2' });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          existing,
          {
            simpleArchEnabled: true,
            generateToken: () => 'new-uuid',
          },
        );
        expect(result).toEqual({ token: 'new-uuid', rotated: true });
        // Old KV entry 삭제됨
        expect(await getTrip(kv as unknown as KVNamespace, 'tok-old')).toBeNull();
      });

      it('다른 waypoints (같은 destination): 새 token + rotated=true', async () => {
        const existing = makeTrip({
          token: 'tok-old',
          destination: 'D-1',
          waypoints: [{ stationName: 'A', line: '2', kind: 'destination' }],
        });
        await putTrip(kv as unknown as KVNamespace, existing);
        const incoming = makeTrip({
          token: 'tok-old',
          destination: 'D-1',
          waypoints: [
            { stationName: 'B', line: '2', kind: 'intermediate' },
            { stationName: 'A', line: '2', kind: 'destination' },
          ],
        });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          existing,
          {
            simpleArchEnabled: true,
            generateToken: () => 'new-token-xyz',
          },
        );
        expect(result.rotated).toBe(true);
        expect(result.token).toBe('new-token-xyz');
      });

      it('다른 route: old token 소유 pending push cleanup (다른 token 보존)', async () => {
        const existing = makeTrip({ token: 'tok-old', destination: 'D-1' });
        await putTrip(kv as unknown as KVNamespace, existing);
        await putPending(
          kv as unknown as KVNamespace,
          makePending({ pushId: 'p-old-1', token: 'tok-old' }),
        );
        await putPending(
          kv as unknown as KVNamespace,
          makePending({ pushId: 'p-old-2', token: 'tok-old' }),
        );
        await putPending(
          kv as unknown as KVNamespace,
          makePending({ pushId: 'p-other', token: 'tok-different-device' }),
        );

        const incoming = makeTrip({ token: 'tok-old', destination: 'D-2' });
        await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          existing,
          {
            simpleArchEnabled: true,
            generateToken: () => 'new-token',
          },
        );

        expect(await kv.get(pendingKey('p-old-1'))).toBeNull();
        expect(await kv.get(pendingKey('p-old-2'))).toBeNull();
        // 다른 device 소유는 보존
        expect(await kv.get(pendingKey('p-other'))).not.toBeNull();
      });

      it('generateToken 미지정: crypto.randomUUID로 생성 (default)', async () => {
        const existing = makeTrip({ token: 'tok-old', destination: 'D-1' });
        await putTrip(kv as unknown as KVNamespace, existing);
        const incoming = makeTrip({ token: 'tok-old', destination: 'D-2' });
        const spy = vi.spyOn(crypto, 'randomUUID');
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          existing,
          { simpleArchEnabled: true },
        );
        expect(spy).toHaveBeenCalledOnce();
        // UUID 포맷 (8-4-4-4-12)
        expect(result.token).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        expect(result.rotated).toBe(true);
        spy.mockRestore();
      });

      it('#2002 — deps 미지정 + KV `arch:simple-arrival-v1`=on: 실제 helper 로 flag ON 동작', async () => {
        // #2002 — real helper `getArchFlag(kv)` wire 검증. deps 미명시하면 KV 값으로 결정.
        await kv.put(ARCH_FLAG_KV_KEY, 'on');
        const existing = makeTrip({ token: 'tok-old', destination: 'D-1' });
        await putTrip(kv as unknown as KVNamespace, existing);
        const incoming = makeTrip({ token: 'tok-old', destination: 'D-2' });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          existing,
          { generateToken: () => 'new-token-from-kv-flag' },
        );
        expect(result).toEqual({ token: 'new-token-from-kv-flag', rotated: true });
        // Old KV entry 삭제됨
        expect(await getTrip(kv as unknown as KVNamespace, 'tok-old')).toBeNull();
      });
    });
  });
});
