import { beforeEach, describe, expect, it } from 'vitest';
import { deleteTrip, getTrip, listTrips, putTrip, tripKey } from '../trips';
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
});
