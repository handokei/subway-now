/**
 * GPS 무관 origin fallback 해석기 (#2959).
 *
 * `currentStation`이 GPS dead zone(지하 등)으로 null일 때, 사용자가 이미 명시한 GPS 무관
 * origin 후보(직접 선택한 출발역 / 활성 BoardingLock의 탑승역 / persist된 trip 출발역) 중
 * 먼저 존재하는 값을 fallback으로 채택한다.
 *
 * `routeToWaypoints` 3번째 인자(`useApnsTripRegistration.ts`)와 `buildBoardingPromptContext`
 * (`boardingPromptContext.ts`) 양쪽이 이 해석기를 호출해야 두 경로가 같은 origin을 기준으로
 * 함께 열리거나 함께 sparse로 남는다 — 한쪽만 고치면 backend 재합성 fallback이 계속 막힌다
 * (#2959 Fix 범위, lessons L21 "사본이 늘면 같은 버그가 복제된다" 재발 방지).
 *
 * 후보 우선순위(HomeScreen.tsx effectiveOrigin 체인 중 GPS 무관 항목만 — `result?.station` /
 * `lastFusedStationRef`는 GPS 파생이라 제외):
 *   1. customOrigin — 사용자가 직접 선택한 출발역
 *   2. boardingLockStation — 활성 BoardingLock의 탑승역
 *   3. tripOrigin — persist된 trip 출발역 (#700 hydration)
 *
 * R-1 — 후보가 전부 null/undefined이면 null 반환(현행 sparse 유지, 억지 추측 금지).
 * R-2 — `currentStation`이 있으면 후보를 보지 않고 그 값을 그대로 반환(현행 동작 100% 불변).
 * R-3 — 후보가 route 상에 없는 노선의 역이면(`isStationOnRoute`) 건너뛰고 다음 후보를
 * 시도한다 — `routeToWaypoints`의 `buildTransfer`/`buildMultiTransfer`는 첫 segment만
 * `currentStation` 값으로 게이트되고 이후 segment는 `enabled`(non-null 여부)만 보고 항상
 * 전체 전개되므로, line 검증 없이 비non-null 후보를 그대로 넘기면 "엉뚱한 노선의 역"이어도
 * 뒤쪽 segment가 통째로 (잘못) 전개된다 — 여기서 미리 걸러야 한다.
 */
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { isStationOnRoute } from '../../../shared/utils/stationRoute';

export function resolveGpsFreeOrigin(
  currentStation: Station | null,
  candidates: ReadonlyArray<Station | null | undefined>,
  route: Route,
): Station | null {
  if (currentStation != null) return currentStation;
  if (!route) return null;
  for (const candidate of candidates) {
    if (candidate != null && isStationOnRoute(candidate, route)) return candidate;
  }
  return null;
}
