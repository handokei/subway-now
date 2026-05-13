import type { Trip } from './types';

/**
 * KV CRUD for active trips.
 *
 * Key format: trip:<token>
 * Listing은 prefix scan으로 enumerate한다.
 */

const TRIP_PREFIX = 'trip:';

export function tripKey(token: string): string {
  return `${TRIP_PREFIX}${token}`;
}

export async function putTrip(kv: KVNamespace, trip: Trip): Promise<void> {
  const ttlSec = Math.max(60, Math.floor((trip.expiresAt - Date.now()) / 1000));
  await kv.put(tripKey(trip.token), JSON.stringify(trip), { expirationTtl: ttlSec });
}

export async function getTrip(kv: KVNamespace, token: string): Promise<Trip | null> {
  const raw = await kv.get(tripKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Trip;
  } catch {
    return null;
  }
}

export async function deleteTrip(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(tripKey(token));
}

export async function* listTrips(kv: KVNamespace): AsyncGenerator<Trip> {
  let cursor: string | undefined;
  do {
    const result = await kv.list({ prefix: TRIP_PREFIX, cursor });
    for (const key of result.keys) {
      const raw = await kv.get(key.name);
      if (!raw) continue;
      try {
        yield JSON.parse(raw) as Trip;
      } catch {
        // 손상된 엔트리는 스킵 (TTL로 자동 정리됨)
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
}
