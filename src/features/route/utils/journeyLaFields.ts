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
import type { LineNumber, Station } from '../../../shared/types/station';
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

/**
 * 재앵커링된 route에서 **아직 남은 leg만** 남긴 route. `updateRouteFromPosition`은 환승을 지나도 route 타입을
 * 유지하고(`stopsToTransfer: 0` + `completedTransfers`) 지난 환승을 여전히 담고 있어, 그대로 waypoint로 펼치면
 * 이미 지난 환승이 다시 나온다. backend `trip.waypoints`는 지난 역이 pop되므로 같은 의미로 맞춘다.
 */
function remainingLegsRoute(anchored: NonNullable<Route>): NonNullable<Route> {
  const completed = anchored.type === 'direct' ? 0 : (anchored.completedTransfers ?? 0);
  if (anchored.type === 'direct' || completed === 0) return anchored;
  if (anchored.type === 'transfer') {
    return { type: 'direct', line: anchored.toLine, stops: anchored.stopsFromTransfer, travelSeconds: anchored.secondsFromTransfer };
  }
  const { transfers } = anchored;
  if (completed >= transfers.length) {
    const { toLine } = transfers[transfers.length - 1];
    return { type: 'direct', line: toLine, stops: anchored.stopsAfterLastTransfer, travelSeconds: anchored.secondsAfterLastTransfer };
  }
  return { ...anchored, transfers: transfers.slice(completed) };
}

export function computeJourneyLaFields(
  route: Route,
  currentStation: Station,
  destination: Station,
): JourneyLaFields {
  if (!route) return {};
  const remainingRoute = anchorRouteToCurrentStation(route, currentStation, destination.id) as NonNullable<Route>;
  const waypoints = routeToWaypoints(remainingLegsRoute(remainingRoute), destination.name, currentStation);
  const [head] = waypoints;

  const fields: JourneyLaFields = {
    nextStationName: getStationDisplayNameByName(head.stationName, allStations),
  };
  // backend LA etaMinutes(= waypoint remainingSecToDest)와 같은 식: 출발 대기 제외 static ETA.
  // 소요 시간 데이터가 깨진 route(NaN)면 거짓 "NaN분" 대신 생략한다.
  const eta = calculateStaticETA(remainingRoute, { excludeOriginWait: true });
  if (Number.isFinite(eta)) fields.etaMinutes = eta as number;
  const transferIdx = waypoints.findIndex((w) => w.kind === 'transfer');
  const after = transferIdx === -1 ? undefined : waypoints[transferIdx + 1];
  if (after) {
    fields.nextLineName = LINE_NAMES[after.line as LineNumber];
    fields.nextLineDirection = getStationDisplayNameByName(after.stationName, allStations);
  }

  const legs = routeLegs(route);
  const remainingTransfers = waypoints.filter((w) => w.kind === 'transfer').length;
  const legIndex = legs.length - 1 - remainingTransfers;
  // 둘 다 같은 route에서 파생돼 legIndex는 항상 범위 안(backend의 모순 가드는 KV 레코드용이라 불필요).
  const { stops, nextLine } = legs[legIndex];
  const next = legs[legIndex + 1];
  fields.legStopsTotal = stops;
  if (next) fields.nextLegStopsTotal = next.stops;
  if (nextLine) fields.nextLineColorHex = LINE_COLORS[nextLine];
  return fields;
}
