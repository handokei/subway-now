import type { Trip } from './types';

/**
 * KV CRUD for active trips.
 *
 * Key format: trip:<token>
 * Listing은 prefix scan으로 enumerate한다.
 */

const TRIP_PREFIX = 'trip:';

/**
 * cron read의 KV cacheTtl (#766/#770). Workers KV의 기본 cacheTtl=60s에 의해 PUT 직후 옛 캐시가
 * 60s까지 유지되는 stale read가 cron의 boardingLock 누락 회귀 root cause였다 (#765 진단 로그).
 * Cloudflare Workers KV의 cacheTtl 최소값은 30s — 그보다 작으면 런타임에서 `Invalid cache_ttl` 던짐(#770).
 * cron 주기 자체가 60s이므로 30s 단축으로도 첫 cron 사이클의 stale window가 사라진다.
 */
const CRON_READ_CACHE_TTL_SEC = 30;

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
      // #766 — cacheTtl=10s로 PUT 직후 옛 캐시 read 차단. 기본 60s는 cron이 boardingLock 갱신을
      // 다음 사이클까지 못 보는 회귀(#765 evidence)를 유발했다.
      const raw = await kv.get(key.name, { cacheTtl: CRON_READ_CACHE_TTL_SEC });
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
