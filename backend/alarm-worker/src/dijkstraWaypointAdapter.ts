/**
 * #1604 / #1610 — backend Dijkstra waypoint adapter.
 *
 * Shared 모듈(`src/shared/utils/dijkstraRoute.ts` + `src/shared/utils/buildRouteGraph.ts`)을
 * backend Worker 환경에 그대로 import해 사용한다. 본 어댑터는 backend-only 관심사만 분리한다:
 *
 *  - `findStationIdByNameAndLine` : `promptDisplay.originStation`(이름) + `promptDisplay.line` →
 *    station id 역추적. shared 그래프 nodes 순회 — 데이터 SSOT은 shared가 보유.
 *  - `inferredRouteToWaypoints`   : shared `Route` → backend `Waypoint[]`. `types.ts`의 backend
 *    `Waypoint` 타입(자체 `LineNumber=string`)을 따른다. shared `LineNumber`(typed union)를
 *    그대로 사용할 수 있도록 type cast 1회만.
 *  - `inferWaypointsFromOriginAndDestination` : POST /trips infer entry point. 모든 미해소
 *    케이스(origin/destination/도달 불가/동일역)는 null — caller가 incoming waypoints 유지.
 *  - `getRouteGraphStats`         : 테스트/디버그 helper.
 *
 * 정신: shared 모듈은 device + backend 공용 알고리즘만 보유. backend 전용 타입 변환은
 * adapter에 격리해 shared가 backend types.ts에 의존하지 않게 한다 (직각 분리).
 *
 * 사용처:
 *   - `src/index.ts` POST /trips 핸들러 — `waypoints=[destination only]` + `promptDisplay`
 *     모두 있을 때 자동 경로 추론(옵션 (B), S1 #1534 spirit — backend = decider).
 */
import {
  buildRouteGraph,
  type RouteGraph,
} from '../../../src/shared/utils/buildRouteGraph';
import {
  findRouteByType,
  type Route,
} from '../../../src/shared/utils/dijkstraRoute';
import type { LineNumber, Waypoint } from './types';

/**
 * 그래프 stats 노출 — 테스트/디버그 진단용.
 */
export function getRouteGraphStats(): RouteGraph['stats'] {
  return buildRouteGraph().stats;
}

/**
 * (name, line) → station id 조회. POST /trips에서 device의 `promptDisplay.originStation` +
 * `promptDisplay.line`로 currentStation id를 역추적할 때 사용한다. 매치 0건이면 null.
 *
 * `line` 인자는 backend `LineNumber=string` — shared `LineNumber`(typed union)로 좁힐 수
 * 없는 임의 입력도 graceful하게 매치되도록 string으로 받는다. 매치는 nodes.values()를
 * 순회하므로 unknown line 입력은 자연스럽게 미매치(null) — 추가 가드 불필요.
 */
export function findStationIdByNameAndLine(name: string, line: LineNumber): string | null {
  const graph = buildRouteGraph();
  for (const station of graph.nodes.values()) {
    if (station.name === name && (station.line as string) === line) {
      return station.id;
    }
  }
  return null;
}

/**
 * shared `Route` → backend `Waypoint[]`. routeWaypoints(device)와 형태 정합.
 *
 * 규칙:
 *  - 각 leg는 시작역(=출발역 또는 환승역) 제외, 나머지 station을 `intermediate`로 펼친다.
 *    마지막 leg의 마지막 station은 `destination`으로 swap.
 *  - 각 transfer는 fromLine 컨텍스트의 `transfer` waypoint로 표현 (device routeWaypoints와 동일).
 *  - 결과 시퀀스는 backend의 `validateTrip`이 occurrenceIdx/hopIndex를 stamp한다.
 *
 * destinationName: 목적지 역 표시명 (device `promptDisplay`/route 의도 보존용).
 */
export function inferredRouteToWaypoints(
  route: Route,
  destinationName: string,
): Array<Pick<Waypoint, 'stationName' | 'line' | 'kind'>> {
  const result: Array<Pick<Waypoint, 'stationName' | 'line' | 'kind'>> = [];
  const graph = buildRouteGraph();
  const stationName = (id: string): string => graph.nodes.get(id)?.name ?? id;

  const legCount = route.legs.length;
  for (let i = 0; i < legCount; i += 1) {
    const leg = route.legs[i];
    const isLastLeg = i === legCount - 1;
    // leg.stationIds[0] = 출발역(직전 transfer 또는 fromId) — push 안 함.
    for (let j = 1; j < leg.stationIds.length; j += 1) {
      const stationId = leg.stationIds[j];
      const isLastStationOfLeg = j === leg.stationIds.length - 1;
      // 마지막 leg의 마지막 station = destination. 표시명은 destinationName 우선(device 의도).
      if (isLastLeg && isLastStationOfLeg) {
        result.push({ stationName: destinationName, line: leg.line, kind: 'destination' });
      } else if (isLastStationOfLeg) {
        // 환승역 — 다음 transfer가 같은 fromLine의 같은 stationName으로 처리.
        const transfer = route.transfers[i];
        const name = transfer ? transfer.stationName : stationName(stationId);
        result.push({ stationName: name, line: leg.line, kind: 'transfer' });
      } else {
        result.push({ stationName: stationName(stationId), line: leg.line, kind: 'intermediate' });
      }
    }
  }
  return result;
}

/**
 * POST /trips infer 진입점. device의 `promptDisplay`(originStation + line) + `destination`(station id)
 * 만으로 backend가 Dijkstra 경로를 계산해 `Waypoint[]`를 반환한다.
 *
 *  - origin 미해소 / destination 미해소 / 도달 불가 / 동일역 → null (caller가 incoming waypoints 유지).
 *  - 정상 시 device routeWaypoints와 동형 시퀀스 반환.
 */
export function inferWaypointsFromOriginAndDestination(args: {
  originName: string;
  originLine: LineNumber;
  destinationId: string;
  destinationName: string;
}): Array<Pick<Waypoint, 'stationName' | 'line' | 'kind'>> | null {
  const fromId = findStationIdByNameAndLine(args.originName, args.originLine);
  if (fromId === null) return null;
  const graph = buildRouteGraph();
  if (!graph.nodes.has(args.destinationId)) return null;
  // backend는 min-time(운행+환승 도보 시간) 단일 mode만 사용 — POST /trips infer에서
  // "사용자가 가장 빨리 갈 수 있는 경로"를 산출하면 충분(min-transfer/min-distance UI 비교는 device 책임).
  // shared `findRouteByType`은 typed `LineNumber`만 받지만 본 호출은 station id 두 개라 LineNumber 무관.
  const route = findRouteByType(fromId, args.destinationId, 'min-time');
  if (route === null) return null;
  // 동일역(degenerate) — legs/transfers 모두 빈 배열. 호출자가 incoming 그대로 유지하도록 null.
  if (route.legs.length === 0 && route.transfers.length === 0) return null;
  return inferredRouteToWaypoints(route, args.destinationName);
}

