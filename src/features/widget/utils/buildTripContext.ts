import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import type { WidgetTripContext } from '../api/widgetStorage';

/**
 * #1929 — widget tripContext wire helper.
 *
 * 4곳의 호출자(useWidgetMirror, HomeScreen AppState force, backgroundLocationTask,
 * notificationRouter)가 동일 로직으로 `WidgetTripContext`를 구성해 `saveStationToWidget`의
 * 5th arg로 forward하기 위한 DRY 진입점.
 *
 * 입력 매트릭스 (4 시나리오):
 *  - destination null → undefined (trip 비활성, 호출자는 그대로 5th arg에 forward)
 *  - currentStation null → undefined (안전 — current 없이는 trip 표시 무의미)
 *  - route direct (transfer 0개) → `nextTransferName: undefined`, 직통 trip 활성
 *  - route transfer/multi-transfer → `nextTransferName: route.transferName ?? transfers[0].transferName`, 환승 trip 활성
 *
 * 반환 타입이 `WidgetTripContext | undefined`인 이유: `saveStationToWidget`의 5th arg가
 * `WidgetTripContext | undefined`이므로 null 대신 undefined를 반환해 호출부에서 `?? undefined`
 * 같은 임시 변환을 제거한다 (호출자는 결과를 그대로 5th arg에 forward 가능).
 *
 * 위젯 측 `SubwayWidget.swift:229` `if entry.tripActive, ..., freshness != .expired`
 * 가드는 본 helper가 `tripActive: true`를 stamp해야만 진입 가능 — RC-15 효과는 4곳
 * 동시 wire 후에야 작동한다.
 */
export interface BuildTripContextArgs {
  destination: Station | null;
  currentStation: Station | null;
  /**
   * 사용자 현재 trip의 route. 4 호출자 모두 같은 source 사용 시 동일 로직 보장.
   *  - FG: HomeScreen `route` (selectedKey 기반 derive).
   *  - BG: `ROUTE_KEY` AsyncStorage 파싱.
   *  - notification: store/payload에서 read.
   *
   * null/undefined 또는 direct 타입이면 `nextTransferName` undefined.
   */
  route?: Route | null;
}

/**
 * 환승 정보가 있는 Route에서 다음 환승역 이름 추출. 호출자에서 깊은 체이닝 회피 + DRY.
 */
function extractNextTransferName(route: Route | null | undefined): string | undefined {
  if (!route) return undefined;
  if (route.type === 'direct') return undefined;
  if (route.type === 'transfer') return route.transferName;
  const firstSegment = route.transfers[0];
  return firstSegment?.transferName;
}

export function buildWidgetTripContext(
  args: BuildTripContextArgs,
): WidgetTripContext | undefined {
  const { destination, currentStation, route } = args;
  if (!destination || !currentStation) return undefined;
  return {
    currentStationName: currentStation.name,
    destinationName: destination.name,
    nextTransferName: extractNextTransferName(route),
    tripActive: true,
  };
}
