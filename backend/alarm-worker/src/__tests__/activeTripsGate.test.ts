import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_TRIPS_MARKER_KEY,
  markTripRegistered,
  readActiveTripsMarker,
  refreshActiveTripsMarker,
} from '../activeTripsGate';
import { CRON_READ_CACHE_TTL_SEC } from '../kvConsistency';
import { InMemoryKV } from './inMemoryKv';
import type { Trip } from '../types';

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'tok-1',
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 60 * 60 * 1000,
    waypoints: [],
    ...overrides,
  } as Trip;
}

describe('activeTripsGate (#2452 — cron listTrips list-quota idle gate)', () => {
  let kv: InMemoryKV;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    kv = new InMemoryKV();
  });

  describe('readActiveTripsMarker', () => {
    it('returns false when no marker was ever stamped (진짜 idle → listTrips skip 대상)', async () => {
      expect((await readActiveTripsMarker(kv as unknown as KVNamespace)).mayHaveActiveTrips).toBe(false);
    });

    it('returns true right after markTripRegistered', async () => {
      await markTripRegistered(kv as unknown as KVNamespace, NOW + 60_000, NOW);
      expect((await readActiveTripsMarker(kv as unknown as KVNamespace)).mayHaveActiveTrips).toBe(true);
    });

    it('returns false when kv is undefined', async () => {
      expect((await readActiveTripsMarker(undefined)).mayHaveActiveTrips).toBe(false);
    });

    it('returns true (보수적 — listTrips 강행, 실 라이더 miss 불허) when kv.get throws', async () => {
      const throwingKv = {
        get: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      expect((await readActiveTripsMarker(throwingKv)).mayHaveActiveTrips).toBe(true);
    });

    it('read 실패 시 활성 + 저장 만료 미상(재기록 대상)', async () => {
      const throwingKv = {
        get: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      expect(await readActiveTripsMarker(throwingKv)).toEqual({
        mayHaveActiveTrips: true,
        storedExpiresAt: null,
      });
    });

    it.each([
      ['legacy "1"', '1'],
      ['파싱 불가', 'abc'],
    ])('%s 값은 활성이되 만료 미상(null)', async (_label, raw) => {
      await kv.put(ACTIVE_TRIPS_MARKER_KEY, raw);
      expect(await readActiveTripsMarker(kv as unknown as KVNamespace)).toEqual({
        mayHaveActiveTrips: true,
        storedExpiresAt: null,
      });
    });

    it('만료 epoch 값은 그대로 파싱', async () => {
      await kv.put(ACTIVE_TRIPS_MARKER_KEY, String(NOW + 5));
      expect(await readActiveTripsMarker(kv as unknown as KVNamespace)).toEqual({
        mayHaveActiveTrips: true,
        storedExpiresAt: NOW + 5,
      });
    });

    it('reads with explicit cacheTtl (kvConsistency 컨벤션)', async () => {
      const spy = vi.spyOn(kv, 'get');
      await readActiveTripsMarker(kv as unknown as KVNamespace);
      expect(spy).toHaveBeenCalledWith(ACTIVE_TRIPS_MARKER_KEY, { cacheTtl: CRON_READ_CACHE_TTL_SEC });
    });
  });

  describe('markTripRegistered', () => {
    it('stamps marker with TTL aligned to trip.expiresAt (no fixed constant)', async () => {
      const expiresAt = NOW + 90 * 60 * 1000; // 90분 뒤
      await markTripRegistered(kv as unknown as KVNamespace, expiresAt, NOW);
      const entry = kv.store.get(ACTIVE_TRIPS_MARKER_KEY);
      expect(entry).toBeDefined();
      expect(entry?.expiresAt).toBeGreaterThan(Date.now());
      // 90분 TTL 근방(계산 오차 허용) — 최소 60s 하한보다 훨씬 큼.
      expect(entry?.expiresAt).toBeGreaterThan(Date.now() + 89 * 60 * 1000);
    });

    it('TTL floors at 60s even if expiresAt is already past/near', async () => {
      await markTripRegistered(kv as unknown as KVNamespace, NOW + 1_000, NOW);
      const entry = kv.store.get(ACTIVE_TRIPS_MARKER_KEY);
      expect(entry?.expiresAt).toBeGreaterThanOrEqual(Date.now() + 59_000);
    });

    it('기존 마커 get이 실패해도 새 만료로 write', async () => {
      const put = vi.fn(async () => undefined);
      const flakyKv = {
        get: async () => {
          throw new Error('kv down');
        },
        put,
      } as unknown as KVNamespace;
      await markTripRegistered(flakyKv, NOW + 60_000, NOW);
      expect(put).toHaveBeenCalledWith(ACTIVE_TRIPS_MARKER_KEY, String(NOW + 60_000), expect.anything());
    });

    it('propagates kv.put failure (자가치유 지점이 아니므로 호출부가 로깅하도록 rethrow)', async () => {
      const throwingKv = {
        put: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      await expect(markTripRegistered(throwingKv, NOW + 60_000, NOW)).rejects.toThrow('kv down');
    });
  });

  describe('refreshActiveTripsMarker', () => {
    it('trips 존재 → marker를 최대 expiresAt 기준으로 재stamp', async () => {
      const trips = [
        makeTrip({ token: 'a', expiresAt: NOW + 10 * 60 * 1000 }),
        makeTrip({ token: 'b', expiresAt: NOW + 40 * 60 * 1000 }),
      ];
      await refreshActiveTripsMarker(kv as unknown as KVNamespace, trips, NOW, null);
      const entry = kv.store.get(ACTIVE_TRIPS_MARKER_KEY);
      expect(entry).toBeDefined();
      expect(entry?.expiresAt).toBeGreaterThan(Date.now() + 39 * 60 * 1000);
    });

    it('저장 만료 이하면 put 0회, 초과하면 새 만료로 put', async () => {
      const put = vi.fn(async () => undefined);
      const spyKv = { put } as unknown as KVNamespace;
      const trips = [makeTrip({ expiresAt: NOW + 60_000 })];
      await refreshActiveTripsMarker(spyKv, trips, NOW, NOW + 60_000);
      await refreshActiveTripsMarker(spyKv, trips, NOW, NOW + 90_000);
      expect(put).not.toHaveBeenCalled();
      await refreshActiveTripsMarker(spyKv, trips, NOW, NOW + 59_999);
      expect(put).toHaveBeenCalledWith(ACTIVE_TRIPS_MARKER_KEY, String(NOW + 60_000), expect.anything());
    });

    it('trips 비어있음(stale marker) → marker delete, 이후 idle tick skip 재개', async () => {
      await markTripRegistered(kv as unknown as KVNamespace, NOW + 60_000, NOW);
      expect((await readActiveTripsMarker(kv as unknown as KVNamespace)).mayHaveActiveTrips).toBe(true);

      await refreshActiveTripsMarker(kv as unknown as KVNamespace, [], NOW, null);
      expect((await readActiveTripsMarker(kv as unknown as KVNamespace)).mayHaveActiveTrips).toBe(false);
    });

    it('graceful when kv.delete throws', async () => {
      const throwingKv = {
        delete: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      await expect(refreshActiveTripsMarker(throwingKv, [], NOW, null)).resolves.toBeUndefined();
    });

    it('graceful when kv.put throws', async () => {
      const throwingKv = {
        put: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      await expect(
        refreshActiveTripsMarker(throwingKv, [makeTrip()], NOW, null),
      ).resolves.toBeUndefined();
    });
  });
});
