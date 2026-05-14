import type { LineNumber } from '../types/station';
import type { Route } from './stationRoute';
import { getStationsOnLine } from './stationRoute';

export type TripDirection = 'up' | 'down';

/**
 * 현재 위치 station id와 경로의 첫 구간을 비교해 진행 방향(상행/하행)을 유도한다.
 *
 * 노선별 station id 정렬상의 index를 기준으로 판정:
 *   - 다음 waypoint index > 현재 station index → 'down'
 *   - 그 반대 → 'up'
 *   - 현재가 다른 노선이거나 인덱스 동일 → null (호출자는 양방향 합산으로 폴백)
 *
 * 환상선(2호선 등)은 index 단방향성이 깨질 수 있으므로 정확하지 않을 수 있다.
 * 정확한 방향 정보를 강제할 수 없는 경계 케이스는 null로 안전 폴백한다.
 */
export function resolveTripDirection(
  route: NonNullable<Route>,
  destinationName: string,
  currentStationId: string,
): TripDirection | null {
  const { line, nextWaypointName } = firstLeg(route, destinationName);
  const lineStations = getStationsOnLine(line);
  const currIdx = lineStations.findIndex((s) => s.id === currentStationId);
  const nextIdx = lineStations.findIndex((s) => s.name === nextWaypointName);
  if (currIdx < 0 || nextIdx < 0 || currIdx === nextIdx) return null;
  return nextIdx > currIdx ? 'down' : 'up';
}

function firstLeg(
  route: NonNullable<Route>,
  destinationName: string,
): { line: LineNumber; nextWaypointName: string } {
  if (route.type === 'direct') {
    return { line: route.line, nextWaypointName: destinationName };
  }
  if (route.type === 'transfer') {
    return { line: route.fromLine, nextWaypointName: route.transferName };
  }
  const first = route.transfers[0];
  return { line: first.fromLine, nextWaypointName: first.transferName };
}
