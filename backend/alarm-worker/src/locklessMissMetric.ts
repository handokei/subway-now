/**
 * Lockless miss metric — trip 종료 시 fire 0건 분기 카운터 (#1972, #1503 잔여 3/3).
 *
 * 배경
 * ====
 * 기존 `observabilityMetrics.locklessMissRatio`는 alarmLog reason='lockless-forward-only-block'
 * 비율(event-level)을 추적한다. 하지만 *trip 단위*에서 lockless trip이 종료될 때 fire 알람이
 * 한 건도 없었는지(진짜 miss)와 사용자가 informational mode를 끈 상태(paradigm intent)인지를
 * 구분하지 못한다.
 *
 * 본 모듈은 device가 trip 종료 시 적재한 `source='lockless-trip-end'` stamp(`alarmLog.ts`의
 * `logLocklessTripEnd`)의 outcome 분기를 데이터 주도로 매핑하는 helper만 export한다.
 * 실제 누적은 `alarmLogStats.ts`의 `locklessTripCounts`가, ratio 산출은
 * `observabilityMetrics.ts`의 `locklessTripMissRatio`가 담당한다.
 *
 * outcome 분기 (device side `logLocklessTripEnd` 가 결정)
 * ========================================================
 *   outcome='fired'      → fired         (정상 동작 — fire ≥ 1)
 *   outcome='suppressed' → miss          (진짜 miss — fire 0 + userIntent ON)
 *   outcome='received'   → paradigmIntent (paradigm — fire 0 + userIntent OFF)
 *
 * Ratio
 * =====
 * locklessTripMissRatio = miss / (miss + fired)
 *   - paradigmIntent 는 분모/분자 모두 제외 ([[lesson_silent_push_zero_is_paradigm_intent]]).
 *   - division-by-zero 방어 — (miss + fired) === 0 이면 ratio=0.
 *
 * 데이터 주도 분류
 * ===============
 * `LOCKLESS_TRIP_END_OUTCOME_TO_BUCKET` Record 가 SSoT. 새 outcome 추가 시 한 줄만 더한다.
 */

import type { AlarmLogStatsResponse } from './alarmLogStats';

/** `source='lockless-trip-end'` entry 의 outcome → counter bucket 매핑. */
export const LOCKLESS_TRIP_END_SOURCE = 'lockless-trip-end';

export type LocklessTripBucket = 'miss' | 'fired' | 'paradigmIntent';

/**
 * outcome → bucket 데이터 주도 매핑.
 *
 *   'fired'      → fired         (사용자에게 노출된 알람이 1건 이상)
 *   'suppressed' → miss          (lockless + userIntent ON + fire 0건 — 진짜 miss)
 *   'received'   → paradigmIntent (lockless + userIntent OFF + fire 0건 — paradigm intent)
 *
 * schema 진화 방어 — 위 3 outcome 외에는 silent drop (`null`).
 */
export const LOCKLESS_TRIP_END_OUTCOME_TO_BUCKET: Readonly<
  Record<string, LocklessTripBucket | null>
> = {
  fired: 'fired',
  suppressed: 'miss',
  received: 'paradigmIntent',
};

/**
 * locklessTripMissRatio 산출 — miss / (miss + fired). paradigmIntent 는 제외.
 *
 * - (miss + fired) === 0 → ratio=0 (division-by-zero 방어, dashboard "no data" 대신 0%).
 * - paradigmIntent 는 분모에서 제외해 [[lesson_silent_push_zero_is_paradigm_intent]] 정합.
 *
 * @returns { miss, fired, paradigmIntent, ratio } — 4 값을 한 번에 노출해 caller 가 raw count 도 보존.
 */
export function buildLocklessTripMissBucket(
  counts: AlarmLogStatsResponse['locklessTripCounts'],
): { miss: number; fired: number; paradigmIntent: number; ratio: number } {
  const denominator = counts.miss + counts.fired;
  const ratio = denominator === 0 ? 0 : counts.miss / denominator;
  return {
    miss: counts.miss,
    fired: counts.fired,
    paradigmIntent: counts.paradigmIntent,
    ratio,
  };
}
