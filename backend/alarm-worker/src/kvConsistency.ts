/**
 * KV read consistency floor (#1402, refactor of #765/#766/#770/#1364/#1381).
 *
 * Cloudflare KV는 read 시 `cacheTtl`이 `30` 미만이면 런타임에서 `Invalid cache_ttl of X.
 * Cache TTL must be at least 30.` 오류를 던진다. 과거 회귀(#1364 cacheTtl=0, #1381 후속)는
 * "cron 사이클에서 stale snapshot을 막으려" 0/10s를 시도하다가 listTrips/listPending이 첫
 * iterate 시점에 abort → 모든 silent push 발사가 멈추는 사고로 이어졌다.
 *
 * 본 모듈은 단일 상수(`CRON_READ_CACHE_TTL_SEC`)와 런타임 가드(`assertCronCacheTtl`)를
 * 제공해 신규 callsite가 같은 회귀를 다시 만들지 못하도록 강제한다. #1399 시간기반 floor
 * 전진과 #1400 cache-key 변경이 새 stale-read race를 도입하지 않는 안전벨트.
 *
 * 사용처: `trips.ts:listTrips`, `pendingPushes.ts:listPending`, `scheduled.ts` progress read,
 * 그 외 cron 경로의 KV read는 모두 이 상수를 import해야 한다.
 *
 * NOTE: read-after-write 검증 경로(예: `index.ts:/boarding-lock/sync`의
 * `verifyBoardingLockPersisted`)는 단일 키 origin 강제 조회로 별도 정책이라 본 가드를 거치지
 * 않는다 — `getTrip(..., { cacheTtl: 0 })` 같은 명시 호출은 read-after-write 한정으로 허용.
 */

/**
 * Cloudflare KV의 cron read에 사용하는 최소 cacheTtl. 30s 미만은 KV가 런타임에서 throw.
 * 같은 cron 사이클의 stale snapshot 차단 + 런타임 제약 둘 다 만족하는 floor 값.
 */
export const CRON_READ_CACHE_TTL_SEC = 30;

/**
 * Cloudflare KV 런타임 최소 cacheTtl. 이 값보다 작으면 KV가 `Invalid cache_ttl` throw.
 * 신규 callsite가 0/10 같은 값을 silently 사용하지 못하도록 가드 함수에서 검증.
 */
export const KV_MIN_CACHE_TTL_SEC = 30;

/**
 * cron 경로의 KV read cacheTtl이 KV 최소 제약을 만족하는지 검증.
 *
 * @throws RangeError — `ttlSec < KV_MIN_CACHE_TTL_SEC`. KV runtime이 던지는 메시지와 의미
 *   동일하지만, KV가 abort되기 전에(즉, listTrips iterate 시점이 아니라 caller 단계에서)
 *   잡혀 root cause를 분명히 한다.
 */
export function assertCronCacheTtl(ttlSec: number): void {
  if (!Number.isFinite(ttlSec) || ttlSec < KV_MIN_CACHE_TTL_SEC) {
    throw new RangeError(
      `Invalid cron cacheTtl ${ttlSec}. Cloudflare KV requires cacheTtl >= ${KV_MIN_CACHE_TTL_SEC}s for cron reads. See kvConsistency.ts.`,
    );
  }
}
