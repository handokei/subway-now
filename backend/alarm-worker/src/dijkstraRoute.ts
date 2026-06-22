/**
 * #1604 — Backend Dijkstra adapter.
 *
 * 알고리즘 본체는 `src/shared/utils/dijkstraRoute.ts` (frontend shared, PR #1644)를 재사용한다.
 * 본 모듈은 backend-specific 입구만 정의:
 *   - `findStationIdByNameAndLine`: device의 `promptDisplay.originStation` + `line`을 station id로 역추적
 *   - `inferWaypointsFromOriginAndDestination`: 최단시간(`min-time`) 경로 → backend `Waypoint[]` 변환
 *
 * 사용처: `index.ts` POST /trips 핸들러에서 `waypoints = [destination only]` 케이스의
 * 자동 경로 추론(옵션 B, S1 #1534 spirit과 정합 — backend = decider).
 *
 * Backend가 frontend shared를 import하는 패턴은 [[lesson_backend_imports_frontend_shared]] 참조.
 * tsconfig include로 shared file 직접 컴파일.
 */
import stationsRaw from '../../../src/data/stations.json';
import { findStationByNameAndLine } from '../../../src/shared/utils/stationLookup';
import {
  findRouteByType,
  type Route,
  type RouteLeg,
} from '../../../src/shared/utils/dijkstraRoute';
import type { LineNumber, Waypoint } from './types';

/** Dijkstra 결과를 Waypoint 형태로 매핑하기 위한 sub-shape. validateTrip이 occurrenceIdx/hopIndex stamp. */
export type InferredWaypoint = Pick<Waypoint, 'stationName' | 'line' | 'kind'>;

/**
 * (name, line) → station id 조회. POST /trips에서 device의 `promptDisplay.originStation` +
 * `promptDisplay.line`로 currentStation의 id를 역추적할 때 사용한다.
 * 매치 없으면 null.
 *
 * shared `findStationByNameAndLine`을 재사용 (canonical fallback 포함, #1405).
 */
export function findStationIdByNameAndLine(name: string, line: LineNumber): string | null {
  // backend `LineNumber = string`이지만 shared lookup은 union 타입 LineNumber를 받음 — string
  // 호환성 보장(런타임 비교는 `===`). cast로 타입 시스템 경계만 통과.
  const station = findStationByNameAndLine(
    name,
    line as Parameters<typeof findStationByNameAndLine>[1],
  );
  return station?.id ?? null;
}

/**
 * stationId → stationName 역조회 캐시. shared `findStationByNameAndLine`은 (name,line) 진입이라
 * 역방향 lookup이 없어 별도 1회 빌드. infer 경로는 호출 빈도 낮음 + lazy 1회 build로 비용 무시.
 */
let stationNameByIdCache: Map<string, string> | null = null;

function lookupStationNameById(id: string): string {
  if (stationNameByIdCache === null) {
    const next = new Map<string, string>();
    for (const s of stationsRaw as Array<{ id: string; name: string }>) {
      next.set(s.id, s.name);
    }
    stationNameByIdCache = next;
  }
  return stationNameByIdCache.get(id) ?? id;
}

/** 테스트 전용 — name lookup 캐시 초기화. */
export function __resetStationNameCache(): void {
  stationNameByIdCache = null;
}

/**
 * `Route.legs` → backend Waypoint[]. routeWaypoints(device)와 형태 정합.
 *
 * 규칙:
 *  - 각 leg는 시작역(=출발역 또는 환승역) 제외, 나머지 station을 `intermediate`로 펼친다.
 *    마지막 leg의 마지막 station은 `destination`으로 swap.
 *  - 각 transfer는 fromLine 컨텍스트의 `transfer` waypoint로 표현 (device routeWaypoints와 동일).
 *  - 결과 시퀀스는 backend의 `validateTrip`이 occurrenceIdx/hopIndex를 stamp한다.
 */
function routeToInferredWaypoints(route: Route, destinationName: string): InferredWaypoint[] {
  const result: InferredWaypoint[] = [];
  const legs = route.legs;
  const legCount = legs.length;

  for (let i = 0; i < legCount; i += 1) {
    const leg = legs[i] as RouteLeg;
    const isLastLeg = i === legCount - 1;
    const stationIds = leg.stationIds;
    // leg.stationIds[0] = 출발역(직전 transfer 또는 fromId) — push 안 함.
    for (let j = 1; j < stationIds.length; j += 1) {
      const isLastStationOfLeg = j === stationIds.length - 1;
      if (isLastLeg && isLastStationOfLeg) {
        // 마지막 leg의 마지막 station = destination. 표시명은 destinationName 우선(device 의도).
        result.push({ stationName: destinationName, line: leg.line, kind: 'destination' });
      } else if (isLastStationOfLeg) {
        // 환승역 — 다음 transfer record의 stationName 사용 (device routeWaypoints와 동형).
        // transfer record는 leg 개수 - 1만큼 있으므로 마지막 leg가 아니면 항상 존재.
        const transfer = route.transfers[i];
        const name = transfer ? transfer.stationName : '';
        result.push({ stationName: name, line: leg.line, kind: 'transfer' });
      } else {
        result.push({
          stationName: lookupStationNameById(stationIds[j]),
          line: leg.line,
          kind: 'intermediate',
        });
      }
    }
  }
  return result;
}

/**
 * POST /trips infer 진입점. device의 `promptDisplay`(originStation + line) + `destination`(station id)
 * 만으로 backend가 Dijkstra(min-time) 경로를 계산해 `Waypoint[]`를 반환한다.
 *
 *  - origin 미해소 / destination 미해소 / 도달 불가 / 동일역 → null (caller가 incoming waypoints 유지).
 *  - 정상 시 device routeWaypoints와 동형 시퀀스 반환.
 */
export function inferWaypointsFromOriginAndDestination(args: {
  originName: string;
  originLine: LineNumber;
  destinationId: string;
  destinationName: string;
}): InferredWaypoint[] | null {
  const fromId = findStationIdByNameAndLine(args.originName, args.originLine);
  if (fromId === null) return null;
  // shared findRouteByType이 graph build + Dijkstra 실행. destination id가 graph에 없으면
  // null 반환 — 별도 nodes.has 체크 불필요.
  const route = findRouteByType(fromId, args.destinationId, 'min-time');
  if (route === null) return null;
  // 동일역(degenerate) — legs/transfers 모두 빈 배열. 호출자가 incoming 그대로 유지하도록 null.
  if (route.legs.length === 0 && route.transfers.length === 0) return null;
  return routeToInferredWaypoints(route, args.destinationName);
}
