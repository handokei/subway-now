import { MAX_ACCURACY_M } from '../../../shared/constants/location';
import { LOCK_NEXT_HOP_WINDOW } from '../../../shared/constants/realtime';
import type { NearestStationResult, Station } from '../../../shared/types/station';

// #444: fusion 결과(non-gps source)가 사용자 실위치와 동떨어진 station을 채택하지 않도록
// 거리·정확도 sanity 검사. positionTrain/fused/route 우선순위에 공통 적용.
//
// R13-a (#1612) — 지하 dead zone 누수 strict 가드.
//   기존: accuracyMeters null 또는 lock 비활성 + accuracy>MAX_ACCURACY_M(지하) → 무조건 통과(`return true`).
//         지하 dead zone에서 잘못된 station 후보(어대 → 청담 등 정반대)가 fusion picker를 통과,
//         non-gps source(positionTrain/fused/route)가 채택되어 cross-trip/inter-line 회귀 발생.
//   변경: bad accuracy(null 또는 >200m) + lock 비활성 시 strict reject (`return false`).
//         lock 활성 trip은 보호 — 사용자 명시 의향(C 토글 ON / 직접 탭 / boardingPrompt 응답)으로
//         생성된 lock은 ADR-010 동급 보장 의무 (lock 활성 시 accuracy bad 면제 유지).

export interface FusionDistanceGateInput {
  /** fusion이 채택하려는 station + user GPS와의 거리(km). */
  candidate: NearestStationResult;
  userLocation: { lat: number; lng: number } | null;
  accuracyMeters: number | null;
  /** GPS-nearest 후보 — 상대 margin 비교용. 없으면 상대 검사 스킵. */
  gpsNearest: NearestStationResult | undefined;
  maxAbsoluteKm: number;
  maxDeltaKm: number;
  /**
   * BoardingLock 활성 여부 (#1016 hole b).
   * true이면 accuracy>MAX_ACCURACY_M bypass를 거부 — 지하라도 lock이 있으면 거리 게이트를 엄격히 적용.
   */
  lockActive?: boolean;
}

/**
 * 후보 station이 GPS sanity 검사를 통과하는지.
 * - userLocation 없음 → 통과(거리 검사 자체 불가, 모든 caller에 동일 영향)
 * - R13-a (#1612): accuracy null 또는 lock 비활성 + accuracy>MAX_ACCURACY_M(지하 dead zone) → reject
 * - lockActive=true면 accuracy 저조 bypass 거부 — lock이 있으면 지하라도 엄격 검사
 * - 절대 거리 > maxAbsoluteKm → 실패
 * - GPS-nearest와 다른 station이고 거리 차이 > maxDeltaKm → 실패
 */
/**
 * BoardingLock 활성 시 후보 역이 arc window 내에 있는지 검사 (#1016 hole c).
 * arc 없거나 탑승역이 arc에 없으면 true(기존 동작 유지).
 */
export function isWithinArcWindow(
  arcStations: readonly Station[],
  candidateId: string,
  boardingStationId: string,
): boolean {
  if (arcStations.length === 0) return true;
  const boardingIdx = arcStations.findIndex((s) => s.id === boardingStationId);
  if (boardingIdx === -1) return true;
  const candidateIdx = arcStations.findIndex((s) => s.id === candidateId);
  return candidateIdx !== -1 && candidateIdx <= boardingIdx + LOCK_NEXT_HOP_WINDOW;
}

export function passesFusionDistanceGate(input: FusionDistanceGateInput): boolean {
  const { candidate, userLocation, accuracyMeters, gpsNearest, maxAbsoluteKm, maxDeltaKm, lockActive } = input;
  if (!userLocation) return true;
  // R13-a (#1612): accuracy null strict reject (지하 dead zone 자동 통과 차단).
  // lock 활성 trip은 보호 — lockActive=true면 면제 (사용자 명시 의향 trip 동급 보장).
  if (accuracyMeters == null) return lockActive === true;
  // R13-a (#1612): lock 비활성 + bad accuracy strict reject (지하 dead zone 누수).
  // lock 활성 trip은 strict 거리 검사로 진행 (#1016 hole b 기존 동작 보존).
  if (!lockActive && accuracyMeters > MAX_ACCURACY_M) return false;
  if (candidate.distanceKm > maxAbsoluteKm) return false;
  if (
    gpsNearest &&
    gpsNearest.station.id !== candidate.station.id &&
    candidate.distanceKm > gpsNearest.distanceKm + maxDeltaKm
  ) {
    return false;
  }
  return true;
}

