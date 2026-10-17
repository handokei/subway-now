/**
 * #1172 / Epic #1008 Epic C 단기 — Phase A pull retry/backoff 상수.
 *
 * BFF progress 호출이 N회 연속 실패하면 backend down으로 판정하고, exponential backoff로
 * 재호출 시도를 미룬다. down 상태에서는 fetch가 즉시 null을 반환해 Stage 1-3 estimator로
 * 자연 fallback (R-2 / R-9 / B5 회피, 즉 backend 장애 시 알람 over-fire 방지).
 *
 * 회복 즉시 down 모드를 해제하기 위해 backoff 만료 시점에는 다시 시도한다.
 */

/** 연속 실패 임계치. 이 횟수만큼 실패하면 down 모드 진입. */
export const FAILURE_THRESHOLD = 3;

/** down 모드 진입 직후 첫 재시도까지 대기 시간 (ms). */
export const BACKOFF_BASE_MS = 5_000;

/** backoff 상한 (ms). 지수 증가가 이 값을 넘지 않도록 클램프. */
export const BACKOFF_MAX_MS = 60_000;

/** backoff 지수. delay = min(BACKOFF_BASE_MS * FACTOR^attempt, BACKOFF_MAX_MS). */
export const BACKOFF_FACTOR = 2;
