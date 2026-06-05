/**
 * #925 C2 — destination 자동 하차 감지 (pure 알고리즘).
 *
 * 사용자가 destination 역에 명시적으로 "하차" 액션을 안 눌러도, 다음 4개 신호가 동시에
 * 만족되면 trip을 자동 종료할 수 있다는 판정만 한다(여기서는 부수효과 없음).
 *
 *   1) destinationStation 이 설정돼 있다
 *   2) arvlCdAtDestination 이 "이 역" 신호 — ARRIVED(1) 또는 ENTERING(0)
 *   3) userLocation 이 destinationStation 좌표로부터 NEAR_STATION_RADIUS_M 이내
 *   4) stationaryDurationMs >= STATIONARY_THRESHOLD_MS
 *
 * 실제 wire(useArrivalAutoClear 확장, LA "도착" 명시 액션, destination 재설정 빠른 UI)는
 * 후속 PR. 이 PR은 알고리즘 + 100% 커버리지만 다룬다.
 *
 * confidence:
 *   - 'high'   → 4개 모두 만족 (shouldAutoClear=true)
 *   - 'medium' → arvlCd "이 역" + 거리 게이트 통과, 정지 시간만 부족
 *   - 'low'    → 그 외
 */

import { ARRIVAL_CODE } from '../../../shared/constants/arrivalCodes';
import {
  NEAR_STATION_RADIUS_M,
  STATIONARY_THRESHOLD_MS,
} from '../../../shared/constants/arrivalDetect';
import type { Station } from '../../../shared/types/station';
import { haversine } from '../../../shared/utils/haversine';

export type ArrivalDetectConfidence = 'high' | 'medium' | 'low';

export interface DestinationArrivalDetectInput {
  destinationStation: Station | null | undefined;
  arvlCdAtDestination: number | null | undefined;
  userLocation: { lat: number; lng: number } | null | undefined;
  stationaryDurationMs: number | null | undefined;
}

export interface DestinationArrivalDetectResult {
  shouldAutoClear: boolean;
  confidence: ArrivalDetectConfidence;
}

const KM_TO_M = 1000;

/**
 * arvlCd 가 "사용자가 그 역에 있다"는 의미인지 — ARRIVED(1) / ENTERING(0) 만 통과.
 * PREV_* (4/5) 는 "전역" 신호이므로 destination 도착 판정에 쓰면 안 됨.
 */
function isAtStationCode(code: number | null | undefined): boolean {
  return code === ARRIVAL_CODE.ARRIVED || code === ARRIVAL_CODE.ENTERING;
}

export function detectDestinationArrival(
  input: DestinationArrivalDetectInput,
): DestinationArrivalDetectResult {
  const { destinationStation, arvlCdAtDestination, userLocation, stationaryDurationMs } = input;

  if (destinationStation == null || userLocation == null) {
    return { shouldAutoClear: false, confidence: 'low' };
  }

  const atStation = isAtStationCode(arvlCdAtDestination);
  if (!atStation) {
    return { shouldAutoClear: false, confidence: 'low' };
  }

  const distanceM =
    haversine(
      userLocation.lat,
      userLocation.lng,
      destinationStation.lat,
      destinationStation.lng,
    ) * KM_TO_M;
  const nearStation = distanceM <= NEAR_STATION_RADIUS_M;
  if (!nearStation) {
    return { shouldAutoClear: false, confidence: 'low' };
  }

  const stationaryEnough =
    stationaryDurationMs != null && stationaryDurationMs >= STATIONARY_THRESHOLD_MS;
  if (!stationaryEnough) {
    return { shouldAutoClear: false, confidence: 'medium' };
  }

  return { shouldAutoClear: true, confidence: 'high' };
}
