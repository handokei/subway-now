/**
 * KV read consistency floor (#1402, refactor of #765/#766/#770/#1364/#1381 + #1423).
 *
 * Cloudflare KV는 read 시 `cacheTtl`이 `30` 미만이면 런타임에서 `Invalid cache_ttl of X.
 * Cache TTL must be at least 30.` 오류를 던진다. 과거 회귀(#1364 cacheTtl=0, #1381 후속)는
 * "cron 사이클에서 stale snapshot을 막으려" 0/10s를 시도하다가 listTrips/listPending이 첫
 * iterate 시점에 abort → 모든 silent push 발사가 멈추는 사고로 이어졌다.
 *
 * #1423: 같은 함정이 sync handler `verifyBoardingLockPersisted`에서 재발 — 본 모듈이
 * "read-after-write 검증 경로는 cacheTtl=0 허용"이라 잘못 명시했고, 그 결과 `index.ts:1052`가
 * `getTrip(..., { cacheTtl: 0 })` 호출 → 모든 `/boarding-lock/sync` POST가 400 throw로 실패.
 * Cloudflare KV runtime은 cron이든 read-after-write든 **모든** read 경로에서 동일하게
 * cacheTtl < 30을 거절한다. "예외 허용" 영역은 존재하지 않는다.
 *
 * 본 모듈은 단일 상수(`KV_MIN_CACHE_TTL_SEC`)와 런타임 가드(`assertKvCacheTtl`,
 * `assertCronCacheTtl`)를 제공해 신규 callsite가 같은 회귀를 다시 만들지 못하도록 강제한다.
 * 추가로 `enforceCacheTtlFloor(ttl)`는 안전한 default 값으로 clamp해 caller가 직접 floor를
 * 의식할 필요 없이 안전한 값을 얻을 수 있게 한다.
 *
 * 사용처:
 *   - cron read: `trips.ts:listTrips`, `pendingPushes.ts:listPending`, `scheduled.ts` progress
 *     read → `CRON_READ_CACHE_TTL_SEC` 상수 + `assertCronCacheTtl` 가드
 *   - 일반 KV read (POST handler, sync handler 등): caller가 직접 cacheTtl 옵션을 넘기는
 *     경우 `assertKvCacheTtl`로 검증 (또는 `enforceCacheTtlFloor`로 clamp).
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

/**
 * 일반 KV read의 cacheTtl이 Cloudflare 런타임 최소 제약을 만족하는지 검증 (#1423).
 *
 * `assertCronCacheTtl`은 "cron read는 30s가 정책"이라는 의미가 더 강하고, 본 함수는 단순히
 * "Cloudflare KV runtime이 받아들이는 cacheTtl인지" 확인하는 범용 가드다. POST handler /
 * sync handler / verification 경로 등에서 caller가 cacheTtl을 명시 전달할 때 사용한다.
 *
 * `undefined` (= 옵션 미전달, 기본 60s)는 통과. caller가 명시적으로 숫자를 넣을 때만 검증.
 *
 * @throws RangeError — `ttlSec`가 숫자인데 `KV_MIN_CACHE_TTL_SEC` 미만.
 */
export function assertKvCacheTtl(ttlSec: number | undefined): void {
  if (ttlSec === undefined) return;
  if (!Number.isFinite(ttlSec) || ttlSec < KV_MIN_CACHE_TTL_SEC) {
    throw new RangeError(
      `Invalid KV cacheTtl ${ttlSec}. Cloudflare KV requires cacheTtl >= ${KV_MIN_CACHE_TTL_SEC}s. See kvConsistency.ts.`,
    );
  }
}

/**
 * cacheTtl을 KV 런타임 최소 제약 위로 clamp (#1423).
 *
 * 0이나 음수, 작은 값을 caller가 "origin 조회 의도"로 전달하더라도, Cloudflare KV는 어떤
 * 시나리오에서도 cacheTtl < 30을 받지 않는다. `assertKvCacheTtl`이 "잘못된 값 차단"이라면
 * 본 함수는 "안전한 값으로 정정". sync handler처럼 propagation race를 줄이고 싶은 caller가
 * "가장 작은 안전한 cacheTtl"을 명시적으로 얻을 때 사용한다.
 *
 * @param ttlSec — caller 의도. NaN/음수/0/30 미만은 floor로 clamp. 30 이상은 그대로.
 * @returns `max(ttlSec, KV_MIN_CACHE_TTL_SEC)`. NaN/undefined도 floor 반환.
 */
export function enforceCacheTtlFloor(ttlSec: number | undefined): number {
  if (ttlSec === undefined || !Number.isFinite(ttlSec)) {
    return KV_MIN_CACHE_TTL_SEC;
  }
  return Math.max(ttlSec, KV_MIN_CACHE_TTL_SEC);
}
