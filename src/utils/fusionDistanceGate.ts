import { MAX_ACCURACY_M } from '../constants/location';
import type { NearestStationResult } from '../types/station';

// #444: fusion 결과(non-gps source)가 사용자 실위치와 동떨어진 station을 채택하지 않도록
// 거리·정확도 sanity 검사. positionTrain/fused/route 우선순위에 공통 적용.
// accuracy가 양호(≤ MAX_ACCURACY_M)할 때만 게이트가 의미 있음 — 지하 fix(±1.5km)는
// 거리 비교 자체를 신뢰할 수 없어 면제(통과).

export interface FusionDistanceGateInput {
  /** fusion이 채택하려는 station + user GPS와의 거리(km). */
  candidate: NearestStationResult;
  userLocation: { lat: number; lng: number } | null;
  accuracyMeters: number | null;
  /** GPS-nearest 후보 — 상대 margin 비교용. 없으면 상대 검사 스킵. */
  gpsNearest: NearestStationResult | undefined;
  maxAbsoluteKm: number;
  maxDeltaKm: number;
}

/**
 * 후보 station이 GPS sanity 검사를 통과하는지.
 * - userLocation 없거나 accuracy null/저조 → 통과(검사 불가)
 * - 절대 거리 > maxAbsoluteKm → 실패
 * - GPS-nearest와 다른 station이고 거리 차이 > maxDeltaKm → 실패
 */
export function passesFusionDistanceGate(input: FusionDistanceGateInput): boolean {
  const { candidate, userLocation, accuracyMeters, gpsNearest, maxAbsoluteKm, maxDeltaKm } = input;
  if (!userLocation) return true;
  if (accuracyMeters == null || accuracyMeters > MAX_ACCURACY_M) return true;
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

