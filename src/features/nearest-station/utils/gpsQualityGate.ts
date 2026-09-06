import {
  GPS_QUALITY_GATE_MAX_ACCURACY_M,
  GPS_QUALITY_GATE_MAX_AGE_MS,
  GPS_QUALITY_DEGRADE_JUMP_M,
  GPS_QUALITY_GATE_ABSENCE_MS,
  GPS_QUALITY_GATE_HYSTERESIS_PASS_COUNT,
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
 *
 * #2076 결함2 — 급락 단독은 더 이상 gpsQualityDegraded(underground hint)를 발동시키지 않는다.
 * 지상 urban canyon(고층빌딩 사이 multipath)에서 accuracy가 1회성으로 급락해도 지하로
 * 오분류되던 결함 차단. 이 함수의 결과는 진단 로그(gps-drop dropReason)에만 쓰이고, 게이트
 * 미달 fix는 어차피 lastPassAt을 갱신하지 않으므로 absence 판정에 별도로 관여하지 않는다.
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
 * #2076 — degraded 해제(hysteresis) 판정. 연속 게이트 통과 fix 수가
 * GPS_QUALITY_GATE_HYSTERESIS_PASS_COUNT(2) 이상이어야 해제로 인정한다. 통과 fix 1회만으로
 * 해제하면 지하상가 틈에서 잠깐 잡힌 단발 fix에도 매번 플랩(degraded↔정상)해 FG watch
 * 재시작 churn(#2076 개선3)을 유발한다.
 */
export function isGpsQualityHysteresisReleased(consecutivePassCount: number): boolean {
  return consecutivePassCount >= GPS_QUALITY_GATE_HYSTERESIS_PASS_COUNT;
}
