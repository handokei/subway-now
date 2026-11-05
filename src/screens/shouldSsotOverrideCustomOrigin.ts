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
 * 원 #1541 의도는 "trip 진행 중" stuck 차단이지, planning 단계(trip 시작 전)에 사용자가
 * 방금 설정한 customOrigin을 clobber하는 것이 아니었다. `inTrip=false`(trip 시작 전 —
 * cold-start pick 포함)면 fusion이 강 confidence로 다른 역을 가리켜도 override하지 않는다.
 *
 * HomeScreen.tsx 자체는 expo-task-manager/expo-notifications 등 네이티브 모듈을 다수
 * transitively import해 단독 unit 테스트가 불가능하므로(jest-expo 환경에서 native module
 * mock이 전무), 이 predicate를 co-located 별도 파일로 분리해 HomeScreen 렌더 하니스 없이
 * red/green 검증 가능하게 한다.
 */
export function shouldSsotOverrideCustomOrigin({
  customOrigin,
  ssotStation,
  confidence,
  inTrip,
}: ShouldSsotOverrideCustomOriginArgs): boolean {
  if (!customOrigin) return false;
  if (!ssotStation) return false;
  if (!isStrongFusionConfidence(confidence)) return false;
  if (ssotStation.id === customOrigin.id) return false;
  if (!inTrip) return false;
  return true;
}
