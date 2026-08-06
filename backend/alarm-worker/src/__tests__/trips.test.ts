import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCH_FLAG_KV_KEY } from '../archFlag';
import {
  __resetTripRegisterLocksForTest,
  cleanupPendingPushesForToken,
  clearStaleBoardingLock,
  computeRouteSignature,
  deleteTrip,
  getTrip,
  listTrips,
  putTrip,
  resolveTripDeviceToken,
  rotateTripTokenForNewRoute,
  tripKey,
  withTripRegisterLock,
} from '../trips';
import { pendingKey, putPending, type PendingPush } from '../pendingPushes';
import { readTripEndedStatus } from '../tripStatus';
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

  // #2174 (P1-A) — push 발사용 실 deviceToken 단일 해석 지점.
  describe('resolveTripDeviceToken (#2174)', () => {
    it('deviceToken이 유효한 64-hex면 그대로 반환', () => {
      const hex64 = 'a'.repeat(64);
      const trip = makeTrip({ token: 'uuid-after-rotation', deviceToken: hex64 });
      expect(resolveTripDeviceToken(trip)).toBe(hex64);
    });

    it('deviceToken 부재(legacy KV 레코드) + token이 64-hex면 token으로 fallback', () => {
      const hex64 = 'b'.repeat(64);
      const trip = makeTrip({ token: hex64, deviceToken: undefined });
      expect(resolveTripDeviceToken(trip)).toBe(hex64);
    });

    it('deviceToken 부재 + token도 64-hex 아님(로테이션된 UUID legacy 레코드)이면 token을 그대로 반환 (기존 무효 상태 유지, 새 회귀 없음)', () => {
      const trip = makeTrip({ token: 'not-a-hex-token-uuid', deviceToken: undefined });
      expect(resolveTripDeviceToken(trip)).toBe('not-a-hex-token-uuid');
    });

    it('deviceToken이 64-hex 아닌 값이면(손상 데이터) token으로 fallback', () => {
      const hex64 = 'c'.repeat(64);
      const trip = makeTrip({ token: hex64, deviceToken: 'malformed' });
      expect(resolveTripDeviceToken(trip)).toBe(hex64);
    });
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

    describe('rotateTripTokenForNewRoute (flag ON, #2174 P1-A — TOKEN_ROTATION_DISABLED guard 해제로 rotation 재활성)', () => {
      it('deps.rotationDisabled: true 명시 override — emergency 재차단 경로 보존 (coverage)', async () => {
        // #2174가 production 상수(TOKEN_ROTATION_DISABLED)를 false로 되돌렸지만, #2173이
        // 도입한 emergency override 자체는 삭제하지 않는다 — 재발 시 즉시 재차단 가능해야 한다.
        const existing = makeTrip({ token: 'tok-old', destination: 'D-1' });
        await putTrip(kv as unknown as KVNamespace, existing);
        const incoming = makeTrip({ token: 'tok-old', destination: 'D-2' });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          existing,
          { simpleArchEnabled: true, rotationDisabled: true, generateToken: () => 'new-uuid' },
        );
        expect(result).toEqual({ token: 'tok-old', rotated: false });
        expect(await getTrip(kv as unknown as KVNamespace, 'tok-old')).not.toBeNull();
      });

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

      it('#2174 — 다른 destination: rotation 발동 (새 token 발급 + old trip:<token> delete)', async () => {
        // #2173 P0 hotfix가 이 경로를 guard로 단락시켰던 이유(push가 UUID를 APNs deviceToken으로
        // 사용해 400 BadDeviceToken 즉사, Epic #2172)는 #2174가 `Trip.deviceToken` 필드 분리 +
        // 모든 push 발사 사이트의 `resolveTripDeviceToken(trip)` 전환으로 해소했다 — guard 해제.
        const existing = makeTrip({ token: 'tok-old', deviceToken: 'a'.repeat(64), destination: 'D-1' });
        await putTrip(kv as unknown as KVNamespace, existing);
        const incoming = makeTrip({ token: 'tok-old', deviceToken: 'a'.repeat(64), destination: 'D-2' });
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
        expect(await getTrip(kv as unknown as KVNamespace, 'tok-old')).toBeNull();
      });

      it('#2174 — 다른 waypoints (같은 destination): rotation 발동 (rotated=true)', async () => {
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

      it('#2174 — 다른 route: old token 소유 pending push cleanup (다른 token 소유는 보존)', async () => {
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
        expect(await kv.get(pendingKey('p-other'))).not.toBeNull();
      });

      it('#2174 — generateToken 미지정: crypto.randomUUID로 새 token 생성 (default)', async () => {
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
        expect(result.rotated).toBe(true);
        spy.mockRestore();
      });

      it('#2002 — deps.simpleArchEnabled 미지정 + KV `arch:simple-arrival-v1`=on: getArchFlag fallback으로 rotation 발동', async () => {
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
        expect(await getTrip(kv as unknown as KVNamespace, 'tok-old')).toBeNull();
      });

      // #2174 F1 — 로테이션은 등록 시점 한정이 아니라 mid-trip route 변경(환승 waypoint trim
      // 재-POST, 목적지 변경 등) 재-POST에서도 발동한다. 이 red 시나리오는 "실토큰 trip 활성 중
      // route 변경 재-POST → 로테이션 → deviceToken이 여전히 실토큰"을 보장한다.
      it('#2174 F1 — mid-trip route 변경 재-POST 로테이션 시에도 새 trip의 deviceToken은 실토큰 그대로', async () => {
        const realDeviceToken = 'b'.repeat(64);
        const existing = makeTrip({
          token: realDeviceToken,
          deviceToken: realDeviceToken,
          destination: 'D-1',
          waypoints: [{ stationName: 'A', line: '2', kind: 'destination' }],
        });
        await putTrip(kv as unknown as KVNamespace, existing);
        // 환승 후 waypoint trim + 새 목적지로 재-POST — deviceToken은 client가 매번 실 토큰을 보낸다.
        const incoming = makeTrip({
          token: realDeviceToken,
          deviceToken: realDeviceToken,
          destination: 'D-2',
          waypoints: [{ stationName: 'C', line: '7', kind: 'destination' }],
        });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          existing,
          { simpleArchEnabled: true, generateToken: () => 'rotated-uuid' },
        );
        expect(result).toEqual({ token: 'rotated-uuid', rotated: true });
        // 로테이션은 trip.token(신원)만 교체 — incoming.deviceToken은 rotation 결과와 무관하게
        // 실토큰 그대로 보존된다(index.ts가 baseTrip = {...incoming, ...}으로 그대로 carry).
        expect(incoming.deviceToken).toBe(realDeviceToken);
      });

      // #2174 F2 — old trip 삭제가 관측 blind hole이었다. 로테이션 시 old trip에 D1 기록 +
      // tripStatus sentinel(reason='rotated')을 남겨야 한다.
      describe('#2174 F2 — old trip 로테이션 관측 기록 (D1 + tripStatus sentinel)', () => {
        it('rotation 시 old trip token으로 tripStatus sentinel이 reason=rotated로 기록된다', async () => {
          const existing = makeTrip({ token: 'tok-old', destination: 'D-1' });
          await putTrip(kv as unknown as KVNamespace, existing);
          const incoming = makeTrip({ token: 'tok-old', destination: 'D-2' });
          const now = 1_700_000_000_000;
          await rotateTripTokenForNewRoute(
            kv as unknown as KVNamespace,
            incoming,
            existing,
            { simpleArchEnabled: true, generateToken: () => 'new-uuid', now },
          );
          const sentinel = await readTripEndedStatus(kv as unknown as KVNamespace, 'tok-old');
          expect(sentinel).toEqual({ endedAt: now, endReason: 'rotated' });
        });

        it('rotation 시 D1 binding 이 있으면 recordTripMetrics 가 old trip 기준으로 호출된다', async () => {
          const existing = makeTrip({ token: 'tok-old', destination: 'D-1' });
          await putTrip(kv as unknown as KVNamespace, existing);
          const incoming = makeTrip({ token: 'tok-old', destination: 'D-2' });
          const run = vi.fn().mockResolvedValue(undefined);
          const bind = vi.fn().mockReturnValue({ run });
          const prepare = vi.fn().mockReturnValue({ bind });
          const db = { prepare } as unknown as D1Database;
          await rotateTripTokenForNewRoute(
            kv as unknown as KVNamespace,
            incoming,
            existing,
            { simpleArchEnabled: true, generateToken: () => 'new-uuid', db, now: 1_700_000_000_000 },
          );
          expect(prepare).toHaveBeenCalled();
          // end_reason 인자(4번째 bind 인자, 0-based idx 3)가 'rotated' — SQL 컬럼 순서(d1TripMetrics.ts) 참고.
          expect(bind).toHaveBeenCalledOnce();
          expect(bind.mock.calls[0][3]).toBe('rotated');
        });

        it('db 미지정 시 recordTripMetrics no-op이어도 rotation 자체는 정상 완료', async () => {
          const existing = makeTrip({ token: 'tok-old', destination: 'D-1' });
          await putTrip(kv as unknown as KVNamespace, existing);
          const incoming = makeTrip({ token: 'tok-old', destination: 'D-2' });
          const result = await rotateTripTokenForNewRoute(
            kv as unknown as KVNamespace,
            incoming,
            existing,
            { simpleArchEnabled: true, generateToken: () => 'new-uuid' },
          );
          expect(result).toEqual({ token: 'new-uuid', rotated: true });
        });

        it('tripStatus sentinel 기록(KV put) 실패해도 rotation 자체는 정상 완료 (best-effort)', async () => {
          const existing = makeTrip({ token: 'tok-old', destination: 'D-1' });
          await putTrip(kv as unknown as KVNamespace, existing);
          const incoming = makeTrip({ token: 'tok-old', destination: 'D-2' });
          const failingKv = {
            ...kv,
            put: vi.fn(async (key: string, value: string, options?: unknown) => {
              if (key.startsWith('tripStatus:')) throw new Error('KV put failed');
              return kv.put(key, value, options as { expirationTtl?: number } | undefined);
            }),
            get: kv.get.bind(kv),
            delete: kv.delete.bind(kv),
            list: kv.list.bind(kv),
          };
          const result = await rotateTripTokenForNewRoute(
            failingKv as unknown as KVNamespace,
            incoming,
            existing,
            { simpleArchEnabled: true, generateToken: () => 'new-uuid' },
          );
          expect(result).toEqual({ token: 'new-uuid', rotated: true });
          // rotation은 sentinel 기록 실패와 무관하게 old trip을 정상 삭제한다.
          expect(await getTrip(kv as unknown as KVNamespace, 'tok-old')).toBeNull();
        });
      });
    });

    describe('#2174 P1-A — deps.rotationDisabled:false 명시 override (기존 default와 동치, 명시적 coverage 보존)', () => {
      // #2173 스펙 잔재: "로테이션 로직 자체는 삭제하지 않음(#P1-A에서 구조 수리 후 재활성)".
      // #2174가 TOKEN_ROTATION_DISABLED 상수를 false로 되돌려 이 override는 이제 default와
      // 동치이지만, 테스트가 deps DI 경로 자체를 명시적으로 계속 검증하도록 보존한다.
      it('flag OFF (KV 미설정 default) + rotationDisabled:false: flagEnabled=false 분기로 incoming 그대로', async () => {
        // 리뷰 P2 — flagEnabled false 분기(line 235-236)는 guard(TOKEN_ROTATION_DISABLED)가 먼저
        // return하는 기존 '#2173 guard' 스위트에서는 도달 불가. rotationDisabled:false로 guard를
        // 우회해야만 이 분기가 실행된다.
        const existing = makeTrip({ token: 'tok-old', destination: 'D-1' });
        await putTrip(kv as unknown as KVNamespace, existing);
        const incoming = makeTrip({ token: 'tok-old', destination: 'D-2' });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          existing,
          { rotationDisabled: false },
        );
        expect(result).toEqual({ token: 'tok-old', rotated: false });
        expect(await getTrip(kv as unknown as KVNamespace, 'tok-old')).not.toBeNull();
      });

      it('existing 없음 (신규 trip): incoming 그대로 (rotated=false)', async () => {
        const incoming = makeTrip({ token: 'tok-new' });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          null,
          { simpleArchEnabled: true, rotationDisabled: false },
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
          { simpleArchEnabled: true, rotationDisabled: false },
        );
        expect(result).toEqual({ token: 'tok-same', rotated: false });
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
            rotationDisabled: false,
          },
        );
        expect(result).toEqual({ token: 'new-uuid', rotated: true });
        expect(await getTrip(kv as unknown as KVNamespace, 'tok-old')).toBeNull();
      });

      it('deps.simpleArchEnabled 미지정 + KV `arch:simple-arrival-v1`=on: getArchFlag fallback으로 rotation 발동', async () => {
        // 리뷰 P2 — `flagEnabled = deps?.simpleArchEnabled ?? ((await getArchFlag(kv)) === 'on')`의
        // `??` 우변(getArchFlag 실호출)이 기존 스위트에서 전혀 실행되지 않던 gap. 여기서는
        // simpleArchEnabled를 생략해 KV flag 실조회 경로를 태운다.
        await kv.put(ARCH_FLAG_KV_KEY, 'on');
        const existing = makeTrip({ token: 'tok-old', destination: 'D-1' });
        await putTrip(kv as unknown as KVNamespace, existing);
        const incoming = makeTrip({ token: 'tok-old', destination: 'D-2' });
        const result = await rotateTripTokenForNewRoute(
          kv as unknown as KVNamespace,
          incoming,
          existing,
          { generateToken: () => 'new-uuid-from-kv-flag', rotationDisabled: false },
        );
        expect(result).toEqual({ token: 'new-uuid-from-kv-flag', rotated: true });
        expect(await getTrip(kv as unknown as KVNamespace, 'tok-old')).toBeNull();
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
            rotationDisabled: false,
          },
        );
        expect(await kv.get(pendingKey('p-old-1'))).toBeNull();
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
          { simpleArchEnabled: true, rotationDisabled: false },
        );
        expect(spy).toHaveBeenCalledOnce();
        expect(result.token).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        expect(result.rotated).toBe(true);
        spy.mockRestore();
      });
    });
  });
});

// #2129 — per-token in-flight 직렬화. 2026-08-04 실탑승 evidence: 같은 device token으로
// 거의 동시에 도착한 POST /trips 2건이 getTrip → rotate → putTrip TOCTOU window에서 interleave해
// 유령 trip 2개(원본 token + rotated UUID)가 모두 KV에 생존했다. withTripRegisterLock은 같은
// token의 register 처리를 큐로 직렬화해 두 번째 요청이 첫 번째 요청의 read-rotate-write 사이클이
// 완전히 끝난 뒤에만 시작하도록 보장한다.
describe('withTripRegisterLock (#2129)', () => {
  beforeEach(() => {
    __resetTripRegisterLocksForTest();
  });

  it('같은 token의 두 번째 호출은 첫 번째 fn이 settle된 뒤에만 시작된다', async () => {
    const order: string[] = [];
    let resolveFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const p1 = withTripRegisterLock('tok-race', async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
      return 'A';
    });
    const p2 = withTripRegisterLock('tok-race', async () => {
      order.push('second-start');
      return 'B';
    });

    // microtask 몇 tick을 흘려보내도 first가 아직 안 끝났으면 second는 시작하면 안 된다.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    resolveFirst();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    expect(r1).toBe('A');
    expect(r2).toBe('B');
  });

  it('다른 token은 서로 대기하지 않고 병렬 실행된다', async () => {
    const order: string[] = [];
    const [rA, rB] = await Promise.all([
      withTripRegisterLock('tok-a', async () => {
        order.push('a');
        return 1;
      }),
      withTripRegisterLock('tok-b', async () => {
        order.push('b');
        return 2;
      }),
    ]);
    expect(order.sort()).toEqual(['a', 'b']);
    expect(rA).toBe(1);
    expect(rB).toBe(2);
  });

  it('첫 fn이 reject해도 큐는 끊기지 않고 두 번째 fn이 정상 실행된다', async () => {
    const order: string[] = [];
    const p1 = withTripRegisterLock('tok-reject', async () => {
      order.push('first');
      throw new Error('boom');
    });
    const p2 = withTripRegisterLock('tok-reject', async () => {
      order.push('second');
      return 'ok';
    });
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
    expect(order).toEqual(['first', 'second']);
  });

  it('큐 소진 후 같은 token을 재사용해도 Map 누적 없이 다시 즉시 실행된다', async () => {
    await withTripRegisterLock('tok-cleanup', async () => 'first');
    // 첫 체인이 settle + cleanup(microtask)까지 흘러가도록 tick 확보.
    await Promise.resolve();
    await Promise.resolve();
    const order: string[] = [];
    await withTripRegisterLock('tok-cleanup', async () => {
      order.push('reused');
    });
    expect(order).toEqual(['reused']);
  });
});
