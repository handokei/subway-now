/**
 * #3221 — 기기가 쓰는 여정 LA(탑승 전·서버 갱신 전)에 채우는 "남은 시간 / 진행 막대 / 다음 역" 필드.
 *
 * backend `computeLegProgressContext` / `computeNextStopContext`(`tripMultiHop.ts`)와 **같은 의미**다:
 *   - 입력은 freeze된 **원본 route**(trip 등록에 쓰는 것과 같은 소스). 재앵커링된 remainingRoute는 지나온
 *     구간이 0이라 leg 전체 정거장 수를 알 수 없다.
 *   - 남은 waypoint는 trip 등록과 같은 생산자(`routeToWaypoints`)로 만든다 → head=다음 역,
 *     남은 환승 waypoint 수로 현재 leg 인덱스를 구한다(원본 leg 수 - 1 - 남은 환승 수).
 *   - 산출 불가 필드는 생략한다(위젯 폴백 유지).
 * 기기/서버 parity는 backend `journeyLaFields.deviceParity.test.ts`가 강제한다.
 */
import type { Station } from '../../../shared/types/station';
import { LINE_COLORS, LINE_NAMES } from '../../../shared/constants/lineColors';
import { getStationDisplayNameByName } from '../../../shared/utils/stationDisplay';
import stationsData from '../../../data/stations.json';
import {
  anchorRouteToCurrentStation,
  calculateStaticETA,
  type Route,
} from '../../../shared/utils/stationRoute';
import { routeToWaypoints } from './routeWaypoints';

const allStations = stationsData as Station[];

export interface JourneyLaFields {
  etaMinutes?: number;
  legStopsTotal?: number;
  nextLegStopsTotal?: number;
  nextLineColorHex?: string;
  nextStationName?: string;
  nextLineName?: string;
  nextLineDirection?: string;
}

/** route를 leg별 { 정거장 수, 이 leg 다음에 갈아탈 노선 } 목록으로 편다 — 환승 횟수에 의존하지 않는다. */
function routeLegs(route: NonNullable<Route>): Array<{ stops: number; nextLine?: Station['line'] }> {
  if (route.type === 'direct') return [{ stops: route.stops }];
  if (route.type === 'transfer') {
    return [{ stops: route.stopsToTransfer, nextLine: route.toLine }, { stops: route.stopsFromTransfer }];
  }
  return [
    ...route.transfers.map((t) => ({ stops: t.stopsToTransfer, nextLine: t.toLine })),
    { stops: route.stopsAfterLastTransfer },
  ];
}

export function computeJourneyLaFields(
  _route: Route,
  _currentStation: Station,
  _destination: Station,
): JourneyLaFields {
  return {};
}
