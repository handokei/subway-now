import type { FusionConfidence } from '../shared/types/fusion';
import type { Station } from '../shared/types/station';
import { isStrongFusionConfidence } from '../shared/constants/fusionConfidenceStrength';

export interface ShouldSsotOverrideCustomOriginArgs {
  customOrigin: Station | null;
  ssotStation: Station | null;
  confidence: FusionConfidence | undefined | null;
  inTrip: boolean;
}

/**
 * #2826 — #1541 SSoT-override 판정을 순수 함수로 추출(테스트 seam).
 *
 * TODO(#2826 RED): 현재는 원 #1541 effect의 로직을 그대로 옮긴 상태 — `inTrip`을 무시하고
 * 강 confidence + station mismatch만으로 override한다. 이는 trip 시작 전(planning 단계)에도
 * 사용자가 방금 설정한 customOrigin을 clobber하는 버그다(용마산 stuck 회귀).
 */
export function shouldSsotOverrideCustomOrigin({
  customOrigin,
  ssotStation,
  confidence,
}: ShouldSsotOverrideCustomOriginArgs): boolean {
  if (!customOrigin) return false;
  if (!ssotStation) return false;
  if (!isStrongFusionConfidence(confidence)) return false;
  if (ssotStation.id === customOrigin.id) return false;
  return true;
}
