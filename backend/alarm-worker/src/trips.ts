import type { Trip } from './types';

/**
 * KV CRUD for active trips.
 *
 * Key format: trip:<token>
 * Listing은 prefix scan으로 enumerate한다.
 */

const TRIP_PREFIX = 'trip:';

/**
 * cron read의 KV cacheTtl (#766/#770 → #1364 → #1381).
 *
 * #765 evidence: sync handler `putTrip` 직후 다음 cron(43~60s 후)의 `kv.get`이 옛 캐시를
 * 읽어 `boardingLock.expiresAt`이 갱신 전 값으로 노출 → `isBoardingLockActive` false-negative
 * → "lock missing or expired" 회귀.
 *
 * #1364 propagation 회피 의도: cron read를 origin 강제 조회하려 `cacheTtl=0`을 시도했으나
 * Cloudflare KV runtime은 `cacheTtl < 30` 요청을 거절한다 — 매 cron 사이클 `Invalid
 * cache_ttl of 0. Cache TTL must be at least 30.` throw로 `listTrips`가 첫 trip iterate
 * 시점에 abort되어 silent push 발사 0건 회귀(#1381 evidence).
 *
 * Resolution: cron path는 KV 최소 제약(30s)을 준수하고, region propagation 정합성은
 * sync handler가 책임진다 — `index.ts:/boarding-lock/sync`의 `verifyBoardingLockPersisted`
 * 는 단일 키 read-after-write 검증이라 cacheTtl 제약 사이드를 다르게 다룬다.
 * 본 상수는 `pendingPushes.ts:CRON_READ_CACHE_TTL_SEC(30)` /
 * `progress.ts`(10/cron, 60/POST handler)와 일관한 cron-read 정책으로 정렬한다.
 */
const CRON_READ_CACHE_TTL_SEC = 30;

export function tripKey(token: string): string {
  return `${TRIP_PREFIX}${token}`;
}

export async function putTrip(kv: KVNamespace, trip: Trip): Promise<void> {
  const ttlSec = Math.max(60, Math.floor((trip.expiresAt - Date.now()) / 1000));
  await kv.put(tripKey(trip.token), JSON.stringify(trip), { expirationTtl: ttlSec });
}

/**
 * #1364 — getTrip은 caller가 cacheTtl을 지정해 stale read window를 명시 제어한다.
 *
 * 기본(미지정): 기본 KV cacheTtl(60s) 사용. read 경로 일반.
 * `cacheTtl: 0`: read-after-write verification 경로 — sync handler가 putTrip 직후
 *   propagation 확인 시 사용. origin 조회 강제로 stale snapshot 차단.
 */
export async function getTrip(
  kv: KVNamespace,
  token: string,
  options?: { cacheTtl?: number },
): Promise<Trip | null> {
  const raw =
    options?.cacheTtl !== undefined
      ? await kv.get(tripKey(token), { cacheTtl: options.cacheTtl })
      : await kv.get(tripKey(token));
  if (!raw) return null;
  try {
    // 주의: stale lock auto-clear는 `listTrips` (cron) 경로에만 적용한다.
    // sync handler는 payload trainCode로 lock을 swap해 line mismatch를 해소하므로
    // 여기서 미리 제거하면 swap 기회가 사라진다.
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
      // #766/#770/#1381 — cron read cacheTtl 30s. Cloudflare KV 최소 제약(<30 throw)을 지키면서
      // 동시에 putTrip 직후 첫 cron 사이클의 옛 캐시 window를 차단한다. region propagation
      // 정합성은 sync handler의 verifyBoardingLockPersisted가 read-after-write 검증으로 책임.
      const raw = await kv.get(key.name, { cacheTtl: CRON_READ_CACHE_TTL_SEC });
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Trip;
        yield clearStaleBoardingLock(parsed);
      } catch {
        // 손상된 엔트리는 스킵 (TTL로 자동 정리됨)
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
}

/**
 * #1364 Layer 4 — stale lock auto-clear.
 *
 * `boardingLock.line`이 현재 첫 waypoint의 line과 다르면 환승 시점에 끊긴 옛 leg의 lock이
 * KV에 남아 있는 상황 (trainCode swap이 누락됐거나 환승 직후 sync 실패). cron이 이 lock을
 * 활성으로 오인하면 잘못된 line의 trainCode를 추적하는 loop가 발생한다 (08:33-35 evidence,
 * `trainCode 7056 not found 3 cycle`).
 *
 * Read 시점에 line mismatch면 lock을 제거해 다음 cron 사이클에 lockless 경로(또는
 * boarding-prompt evaluation)로 복귀시킨다.
 */
export function clearStaleBoardingLock(trip: Trip): Trip {
  if (!trip.boardingLock) return trip;
  const head = trip.waypoints[0];
  if (!head) return trip;
  if (trip.boardingLock.line === head.line) return trip;
  return { ...trip, boardingLock: undefined };
}
