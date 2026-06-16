import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearStaleBoardingLock, deleteTrip, getTrip, listTrips, putTrip, tripKey } from '../trips';
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

  // #1364 — cron read는 cacheTtl=0으로 origin 조회를 강제해 propagation 지연 회피.
  it('listTrips passes cacheTtl=0 to kv.get (#1364 stale read 방어)', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip({ token: 'a' }));
    const spy = vi.spyOn(kv, 'get');
    for await (const _t of listTrips(kv as unknown as KVNamespace)) {
      // consume
    }
    const tripGetCall = spy.mock.calls.find(([key]) => key === 'trip:a');
    expect(tripGetCall?.[1]).toEqual({ cacheTtl: 0 });
  });

  // #1364 — getTrip은 caller가 cacheTtl 지정 가능. read-after-write verification 경로.
  it('getTrip forwards cacheTtl option to kv.get when provided (#1364)', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const spy = vi.spyOn(kv, 'get');
    await getTrip(kv as unknown as KVNamespace, 'tok-1', { cacheTtl: 0 });
    expect(spy).toHaveBeenCalledWith('trip:tok-1', { cacheTtl: 0 });
  });

  it('getTrip omits options arg when cacheTtl not specified (default KV cache)', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const spy = vi.spyOn(kv, 'get');
    await getTrip(kv as unknown as KVNamespace, 'tok-1');
    expect(spy).toHaveBeenCalledWith('trip:tok-1');
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
});
