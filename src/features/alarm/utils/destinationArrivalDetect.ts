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
  DESTINATION_NEARBY_RADIUS_M,
  NEAR_STATION_RADIUS_M,
  STATIONARY_THRESHOLD_MS,
  STATIONARY_TRIP_END_THRESHOLD_MS,
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

/**
 * #1647 — Seoul Arrival API-independent auto-end gate.
 *
 * 기존 `detectDestinationArrival`은 arvlCd(ARRIVED/ENTERING)를 1단 게이트로 요구해 Seoul API
 * outage / 지하 dead zone에서 fire 0건(6/22 13:36 trip + 10.5h 좀비 evidence). 본 detector는
 * arvlCd 의존 없이 device-self-contained로 동일 책임(도착 자동 종료)을 수행한다.
 *
 * 3-of-3 합의:
 *   1) destinationStation ≠ null
 *   2) userLocation → destinationStation 거리 ≤ DESTINATION_NEARBY_RADIUS_M (100m)
 *   3) stationaryDurationMs ≥ STATIONARY_TRIP_END_THRESHOLD_MS (5min)
 *   4) lockActive === true (사용자 명시 의향 trip만)
 *
 * 4번 lockActive 추가 이유:
 *   - lockless trip은 정보용 — 사용자가 명시 의향을 표명하지 않은 trip을 자동 종료 X.
 *   - ADR-014 "사용자 명시 의향 = lock 동급 보호" 원칙. lock 있으면 동급 정확도 의무.
 *
 * 본 detector는 기존 detector와 OR 결합돼 둘 중 하나라도 true면 자동 종료된다(useDestinationAutoClear).
 *
 * confidence:
 *   - 'high'   → 4개 모두 만족 (shouldAutoClear=true)
 *   - 'medium' → destination/lock/distance 통과, 정지 시간만 부족
 *   - 'low'    → 그 외
 */
export interface StationaryTripEndDetectInput {
  destinationStation: Station | null | undefined;
  userLocation: { lat: number; lng: number } | null | undefined;
  stationaryDurationMs: number | null | undefined;
  /**
   * 사용자 명시 의향 trip인지 — boardingLock 활성 여부. lockless trip 자동 종료 차단.
   * 호출자가 `Boolean(boardingLock)`을 그대로 전달.
   */
  lockActive: boolean;
}

export function detectStationaryTripEnd(
  input: StationaryTripEndDetectInput,
): DestinationArrivalDetectResult {
  const { destinationStation, userLocation, stationaryDurationMs, lockActive } = input;

  if (destinationStation == null || userLocation == null) {
    return { shouldAutoClear: false, confidence: 'low' };
  }
  if (!lockActive) {
    return { shouldAutoClear: false, confidence: 'low' };
  }

  const distanceM =
    haversine(
      userLocation.lat,
      userLocation.lng,
      destinationStation.lat,
      destinationStation.lng,
    ) * KM_TO_M;
  if (distanceM > DESTINATION_NEARBY_RADIUS_M) {
    return { shouldAutoClear: false, confidence: 'low' };
  }

  const stationaryEnough =
    stationaryDurationMs != null && stationaryDurationMs >= STATIONARY_TRIP_END_THRESHOLD_MS;
  if (!stationaryEnough) {
    return { shouldAutoClear: false, confidence: 'medium' };
  }

  return { shouldAutoClear: true, confidence: 'high' };
}
