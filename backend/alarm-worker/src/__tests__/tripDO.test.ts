import { describe, expect, it } from 'vitest';
import {
  TripDO,
  getSsotRow,
  getTripRow,
  seedSsotRow,
  seedTripRow,
  type TripDoStorage,
} from '../tripDO';
import type { Trip } from '../types';
import type { TripPositionSSoT } from '../tripPositionSsot';

/**
 * TripDO scaffold acceptance (#2264, Epic #2260, ADR-031 Phase 1).
 *
 * - trip/ssot row CRUD round-trip (pure function level, Map 기반 fake storage)
 * - persist-first: put이 완료된 후에만 이후 get이 값을 반환 (fake storage 자체가 순차 보장)
 * - `TripDO.fetch()` 라우팅: GET/POST /trip, GET/POST /ssot, 404 fallback
 * - fire 로직 없음 — 본 스코프는 state 보관/조회만 (assert로 명시)
 */

const FUTURE = Date.now() + 60 * 60 * 1000;

function makeTrip(overrides?: Partial<Trip>): Trip {
  return {
    token: 'tok-abc',
    route: { type: 'direct', line: '2', stops: 3 },
    destination: 'dst',
    waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
    expiresAt: FUTURE,
    createdAt: Date.now(),
    alarmAtEpochMs: FUTURE - 30 * 60 * 1000,
    ...overrides,
  } as Trip;
}

function makeSsot(overrides?: Partial<TripPositionSSoT>): TripPositionSSoT {
  return {
    tripToken: 'tok-abc',
    currentStationId: '0228',
    motionState: 'unknown',
    motionEvidence: [],
    lastAdvanceAt: 0,
    lastAdvanceEvidence: 'seed-override',
    passedStations: [],
    userIntentDeclared: false,
    seedOverrideCount: 0,
    alarmEvents: [],
    schemaVersion: 1,
    ...overrides,
  };
}

/** Map 기반 fake — `DurableObjectState.storage`의 최소 부분집합 (KV 스타일 API). */
function makeFakeStorage(): TripDoStorage {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
}

describe('tripDO row helpers — pure function CRUD', () => {
  it('getTripRow: 신규 storage는 undefined', async () => {
    const storage = makeFakeStorage();
    expect(await getTripRow(storage)).toBeUndefined();
  });

  it('seedTripRow → getTripRow round-trip', async () => {
    const storage = makeFakeStorage();
    const trip = makeTrip();
    await seedTripRow(storage, trip);
    expect(await getTripRow(storage)).toEqual(trip);
  });

  it('seedTripRow는 두 번째 seed로 덮어쓴다 (idempotent overwrite)', async () => {
    const storage = makeFakeStorage();
    await seedTripRow(storage, makeTrip({ destination: 'a' }));
    await seedTripRow(storage, makeTrip({ destination: 'b' }));
    expect((await getTripRow(storage))?.destination).toBe('b');
  });

  it('getSsotRow: 신규 storage는 undefined', async () => {
    const storage = makeFakeStorage();
    expect(await getSsotRow(storage)).toBeUndefined();
  });

  it('seedSsotRow → getSsotRow round-trip', async () => {
    const storage = makeFakeStorage();
    const ssot = makeSsot();
    await seedSsotRow(storage, ssot);
    expect(await getSsotRow(storage)).toEqual(ssot);
  });

  it('trip row와 ssot row는 독립 — 하나만 seed해도 다른 쪽은 영향 없음', async () => {
    const storage = makeFakeStorage();
    await seedTripRow(storage, makeTrip());
    expect(await getSsotRow(storage)).toBeUndefined();
  });
});

describe('TripDO — fetch() 라우팅', () => {
  function makeDO(): TripDO {
    const state = { storage: makeFakeStorage() } as unknown as DurableObjectState;
    return new TripDO(state);
  }

  it('GET /trip: 신규 인스턴스는 { trip: null }', async () => {
    const doInstance = makeDO();
    const res = await doInstance.fetch(new Request('https://trip-do/trip'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ trip: null });
  });

  it('POST /trip → GET /trip: seed 후 조회 round-trip', async () => {
    const doInstance = makeDO();
    const trip = makeTrip();
    const postRes = await doInstance.fetch(
      new Request('https://trip-do/trip', { method: 'POST', body: JSON.stringify(trip) }),
    );
    expect(postRes.status).toBe(204);

    const getRes = await doInstance.fetch(new Request('https://trip-do/trip'));
    expect(await getRes.json()).toEqual({ trip });
  });

  it('GET /ssot: 신규 인스턴스는 { ssot: null }', async () => {
    const doInstance = makeDO();
    const res = await doInstance.fetch(new Request('https://trip-do/ssot'));
    expect(await res.json()).toEqual({ ssot: null });
  });

  it('POST /ssot → GET /ssot: seed 후 조회 round-trip', async () => {
    const doInstance = makeDO();
    const ssot = makeSsot();
    const postRes = await doInstance.fetch(
      new Request('https://trip-do/ssot', { method: 'POST', body: JSON.stringify(ssot) }),
    );
    expect(postRes.status).toBe(204);

    const getRes = await doInstance.fetch(new Request('https://trip-do/ssot'));
    expect(await getRes.json()).toEqual({ ssot });
  });

  it('알 수 없는 route는 404 — fire/판정 로직 없음(Phase 2 스코프 외)', async () => {
    const doInstance = makeDO();
    const res = await doInstance.fetch(new Request('https://trip-do/alarm', { method: 'POST' }));
    expect(res.status).toBe(404);
  });

  it('trip row와 ssot row가 같은 DO 인스턴스에 독립 공존', async () => {
    const doInstance = makeDO();
    const trip = makeTrip();
    const ssot = makeSsot();
    await doInstance.fetch(
      new Request('https://trip-do/trip', { method: 'POST', body: JSON.stringify(trip) }),
    );
    await doInstance.fetch(
      new Request('https://trip-do/ssot', { method: 'POST', body: JSON.stringify(ssot) }),
    );
    const tripRes = await doInstance.fetch(new Request('https://trip-do/trip'));
    const ssotRes = await doInstance.fetch(new Request('https://trip-do/ssot'));
    expect(await tripRes.json()).toEqual({ trip });
    expect(await ssotRes.json()).toEqual({ ssot });
  });
});
