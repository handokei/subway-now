/**
 * #1616 (R8a) — lockless 시 trackTrainProgress forward-only 가드용 arcStations 추정.
 *
 * 배경:
 * `useFusedNearestStation` 의 trainProgress 계산은 `boardingLock` 활성 시에만 `segmentStations` /
 * `boardingStationId` 를 trackTrainProgress에 전달했다. 즉 lockless trip(boardingLock=null)에서는
 * forward-only 가드가 OFF — R2 lockless time-integration cascade가 backward jump을 허용해
 * "pt/fu/gp 다 잘못된 역" misfire 회귀(2026-06-19 trip evidence: pt 다 이수, 실제 학동/강남구청).
 *
 * 본 helper는 route + userLocation으로 user-position 기준 arc 윈도우를 추정해 lockless 시에도
 * trackTrainProgress가 backward 후보를 reject할 수 있게 한다. 정확한 lock 없어도 route arc 상
 * "사용자 근처 ± window" segment를 산출 — 추정 cut-off은 정확하지 않지만 lock 없을 때 어떤 가드도
 * 없는 현 동작보다는 보수적으로 안전.
 *
 * 추정 algorithm:
 *   a. computeRouteArc로 route + origin + destination → 전체 arc Station[] 산출.
 *   b. userLocation에서 가장 가까운 arc 위 station을 찾는다 (haversine 단순 비교).
 *   c. 그 station 인덱스 ± window 범위 station을 반환 (양 끝 clamp).
 *
 * route / origin / destination / userLocation 중 하나라도 없거나, arc 산출 실패 시 undefined 반환 —
 * 호출자는 segmentStations=undefined로 fallback해 기존 lockless 동작 유지 (회귀 0).
 *
 * window=3 — pickCandidateTrains의 DEFAULT_WINDOW_STATIONS와 일치. 사용자 위치 추정 오차 + 표준
 * candidate window를 같이 흡수해 false reject 최소화.
 */
import type { Station } from '../../../shared/types/station';
import { haversine } from '../../../shared/utils/haversine';
import { computeRouteArc } from './routeProgress';
import type { Route } from '../../../shared/utils/stationRoute';

/**
 * #1616 (R8a) — lockless arc 윈도우 추정 default window (양옆 station 수).
 * pickCandidateTrains DEFAULT_WINDOW_STATIONS=3과 동일 — 두 가드가 같은 영역 정의를 공유.
 */
export const ESTIMATE_ARC_WINDOW_STATIONS = 3;

export interface EstimateArcStationsInput {
  route: Route;
  origin: Station | null;
  destination: Station | null;
  userLocation: { lat: number; lng: number } | null;
  windowStations?: number;
}

export interface EstimateArcStationsResult {
  segmentStations: readonly Station[];
  /** arc 윈도우의 첫 station id — trackTrainProgress의 boardingStationId 자리에 사용. */
  boardingStationId: string;
}

export function estimateArcStationsFromRoute(
  input: EstimateArcStationsInput,
): EstimateArcStationsResult | undefined {
  const { route, origin, destination, userLocation, windowStations } = input;

  if (!route || !origin || !destination || !userLocation) return undefined;

  const arc = computeRouteArc(route, origin, destination);
  if (!arc || arc.stations.length === 0) return undefined;

  const window = Math.max(0, windowStations ?? ESTIMATE_ARC_WINDOW_STATIONS);

  // arc 위 user GPS-nearest station 검색 — haversine 단순 비교(arc 매우 길어도 528건 << render budget).
  let nearestIdx = 0;
  let nearestDist = Infinity;
  for (let i = 0; i < arc.stations.length; i++) {
    const s = arc.stations[i];
    const d = haversine(userLocation.lat, userLocation.lng, s.lat, s.lng);
    if (d < nearestDist) {
      nearestDist = d;
      nearestIdx = i;
    }
  }

  const start = Math.max(0, nearestIdx - window);
  const end = Math.min(arc.stations.length, nearestIdx + window + 1);
  const segmentStations = arc.stations.slice(start, end);

  // segmentStations[0] = 윈도우 시작 = 추정 boarding 위치. trackTrainProgress의 forward-only는
  // 이 위치 이전 candidate를 reject 한다 — lockless에서 보수적 안전망 역할.
  return {
    segmentStations,
    boardingStationId: segmentStations[0].id,
  };
}
