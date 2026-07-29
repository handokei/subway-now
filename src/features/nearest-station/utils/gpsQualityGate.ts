import {
  GPS_QUALITY_GATE_MAX_ACCURACY_M,
  GPS_QUALITY_GATE_MAX_AGE_MS,
  GPS_QUALITY_DEGRADE_JUMP_M,
  GPS_QUALITY_GATE_ABSENCE_MS,
} from '../../../shared/constants/gpsQualityGate';

export type GpsQualityDropReason = 'accuracy' | 'stale';

/**
 * #2070 — fusion 결정 tier 입력 품질 게이트. horizontalAccuracy < 100m AND fix age < 15s
 * 모두 충족해야 통과. 미달 좌표는 결정 tier(useFusedNearestStation cascade) 입력에서 제외한다.
 *
 * 경계값은 엄격 부등호(<) — accuracy/age가 정확히 임계값이면 미달로 취급한다.
 */
export function isGpsQualityGateAcceptable(
  accuracy: number | null | undefined,
  ageMs: number,
): accuracy is number {
  if (accuracy == null) return false;
  return accuracy < GPS_QUALITY_GATE_MAX_ACCURACY_M && ageMs < GPS_QUALITY_GATE_MAX_AGE_MS;
}

/**
 * #2070 — 게이트 미달 fix의 drop 사유. accuracy 자체가 임계 초과(또는 미측정)면 'accuracy',
 * accuracy는 통과했지만 fix가 오래됐으면 'stale'. 호출 전제: 게이트가 이미 미달 판정된 fix.
 */
export function gpsQualityDropReason(
  accuracy: number | null | undefined,
  ageMs: number,
): GpsQualityDropReason {
  if (accuracy == null || accuracy >= GPS_QUALITY_GATE_MAX_ACCURACY_M) return 'accuracy';
  if (ageMs >= GPS_QUALITY_GATE_MAX_AGE_MS) return 'stale';
  // 전제 위반(사실은 게이트 통과) 방어적 fallback — accuracy는 fine이니 stale로 귀결.
  return 'stale';
}

/**
 * #2070 — 직전 게이트 통과 fix 대비 accuracy가 GPS_QUALITY_DEGRADE_JUMP_M(100m) 초과로
 * 급락했는지. 직전 통과 기록이 없으면(콜드스타트 등) 판단 불가 → false.
 */
export function isGpsQualityJumpDegraded(
  lastPassAccuracyM: number | null,
  currentAccuracyM: number | null | undefined,
): boolean {
  if (lastPassAccuracyM === null || currentAccuracyM == null) return false;
  return currentAccuracyM - lastPassAccuracyM > GPS_QUALITY_DEGRADE_JUMP_M;
}

/**
 * #2070 — 게이트 통과 fix가 GPS_QUALITY_GATE_ABSENCE_MS(30s) 이상 없었는지. 통과 기록이
 * 아예 없으면(콜드스타트) 근거 부족으로 간주해 false — "판단 불가 시 지하로 단정하지 않는다"
 * 원칙(memory/feedback_no_gps_for_decision.md)과 일관.
 */
export function isGpsQualityAbsenceDegraded(
  lastPassAtMs: number | null,
  nowMs: number,
): boolean {
  if (lastPassAtMs === null) return false;
  return nowMs - lastPassAtMs >= GPS_QUALITY_GATE_ABSENCE_MS;
}

/**
 * #2070 — 품질 저하 transition 이벤트. 급락 또는 30s 부재 중 하나라도 해당하면 true.
 * 기존 subsurface/environment 판정 로직(inferEnvironment)에 추가 입력으로 전달되며,
 * 판정 로직 자체를 대체하지 않는다.
 */
export function isGpsQualityDegradedTransition(
  lastPassAccuracyM: number | null,
  lastPassAtMs: number | null,
  currentAccuracyM: number | null | undefined,
  nowMs: number,
): boolean {
  return (
    isGpsQualityJumpDegraded(lastPassAccuracyM, currentAccuracyM) ||
    isGpsQualityAbsenceDegraded(lastPassAtMs, nowMs)
  );
}
