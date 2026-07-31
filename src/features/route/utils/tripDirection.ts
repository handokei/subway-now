import type { LineNumber } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { getFirstLeg, getStationsOnLine, getStationById } from '../../../shared/utils/stationRoute';
import { isClosedLoopMainStation, shortestLinePathIndices } from '../../../shared/utils/lineLoopPath';

export type TripDirection = 'up' | 'down';

/**
 * #1922 — currentStationId의 노선에 맞는 leg의 line + endName을 산출한다.
 *
 * 기본은 `getFirstLeg`(첫 leg)이지만, 환승 후 leg에 진입하면 current station은 다른 line이 된다.
 * 본 함수가 current 노선에 일치하는 leg를 선택해 환승 후에도 direction 추론을 가능하게 한다.
 *
 * 산출 규칙:
 *   - direct: 항상 첫 leg(=유일 leg).
 *   - transfer: current.line === fromLine → 첫 leg(fromLine, transferName).
 *               current.line === toLine → 두 번째 leg(toLine, destinationName).
 *               그 외 → 첫 leg fallback(기존 동작 유지).
 *   - multi-transfer: current.line이 일치하는 leg를 채택. fromLine은 transfers[i].fromLine,
 *     endName은 transfers[i].transferName. 마지막 leg는 toLine, endName=destinationName.
 *
 * #1965 — multi-transfer route가 같은 line을 두 번 이상 지나면(예: 2호선 → 4호선 → 2호선
 * → 7호선) 단순 "첫 매칭 leg" 채택은 실제로 나중 leg에 있는 사용자를 첫 leg로 오판한다.
 * bounded leg(양 끝 경계가 모두 알려진 i>=1)는 진입/이탈 boundary 사이에 currentStationId가
 * 실제로 있는지(arc 범위) 검증해 뒤(나중 leg)에서부터 먼저 매칭을 시도한다. i=0은 시작
 * 경계(trip origin)를 알 수 없어 arc 검증이 불가능하므로 bounded leg 중 매칭이 없을 때만
 * 마지막 fallback으로 채택한다.
 */
function isStationInLegArc(
  line: LineNumber,
  currentStationId: string,
  entryBoundaryName: string,
  exitBoundaryName: string,
): boolean {
  const lineStations = getStationsOnLine(line);
  const currIdx = lineStations.findIndex((s) => s.id === currentStationId);
  const entryIdx = lineStations.findIndex((s) => s.name === entryBoundaryName);
  const exitIdx = lineStations.findIndex((s) => s.name === exitBoundaryName);
  if (currIdx < 0 || entryIdx < 0 || exitIdx < 0) return false;
  const lo = Math.min(entryIdx, exitIdx);
  const hi = Math.max(entryIdx, exitIdx);
  return currIdx >= lo && currIdx <= hi;
}

function pickLegForCurrentLine(
  route: NonNullable<Route>,
  destinationName: string,
  currentLine: LineNumber,
  currentStationId: string,
): { line: LineNumber; endName: string } {
  if (route.type === 'direct') {
    return { line: route.line, endName: destinationName };
  }
  if (route.type === 'transfer') {
    if (currentLine === route.toLine) {
      return { line: route.toLine, endName: destinationName };
    }
    return { line: route.fromLine, endName: route.transferName };
  }
  // multi-transfer — bounded leg(i>=1)를 뒤에서부터 먼저 arc 검증.
  const { transfers } = route;
  for (let i = transfers.length - 1; i >= 1; i--) {
    if (currentLine !== transfers[i].fromLine) continue;
    const entryBoundaryName = transfers[i - 1].transferName;
    const exitBoundaryName = transfers[i].transferName;
    if (isStationInLegArc(transfers[i].fromLine, currentStationId, entryBoundaryName, exitBoundaryName)) {
      return { line: transfers[i].fromLine, endName: transfers[i].transferName };
    }
  }
  // 첫 leg(i=0) — 시작 경계 불명(unbounded), 남은 유일 후보로만 채택.
  if (currentLine === transfers[0].fromLine) {
    return { line: transfers[0].fromLine, endName: transfers[0].transferName };
  }
  const last = transfers[transfers.length - 1];
  if (currentLine === last.toLine) {
    return { line: last.toLine, endName: destinationName };
  }
  // current가 어느 leg에도 없으면 첫 leg fallback (기존 동작).
  return getFirstLeg(route, destinationName);
}

/**
 * 현재 위치 station id와 경로의 활성 leg(=current.line에 일치하는 leg)을 비교해 진행 방향(상행/하행)을 유도한다.
 *
 * 노선별 station id 정렬상의 index를 기준으로 판정:
 *   - 다음 waypoint index > 현재 station index → 'down'
 *   - 그 반대 → 'up'
 *   - 현재가 leg line에 없거나 인덱스 동일 → null (호출자는 양방향 합산으로 폴백)
 *
 * #1922 — 2호선 본선처럼 closed loop(환상선)인 경우, 단순 index 비교로는 wraparound 방향을
 * 잘못 판정할 수 있다. 양 끝점이 모두 closed loop 본선이면 `shortestLinePathIndices`로 wraparound
 * 짧은 쪽 경로를 산출해 첫 step의 방향(idx 증가/감소)으로 'up'/'down'을 결정한다.
 *
 * #1922 — 환승 후 leg(current.line이 route 두 번째 이후 leg)에서도 direction을 결정할 수 있다.
 * 기존엔 첫 leg(`getFirstLeg`)만 봐서 환승 후엔 current.id가 첫 leg line에 없어 null이었다.
 * `pickLegForCurrentLine`이 current.line과 일치하는 leg을 선택해 환상선 leg에서도 direction을 산출.
 *
 * 정확한 방향 정보를 강제할 수 없는 경계 케이스(다른 노선/같은 idx)는 null로 안전 폴백한다.
 */
export function resolveTripDirection(
  route: NonNullable<Route>,
  destinationName: string,
  currentStationId: string,
): TripDirection | null {
  // #1922 — current.line에 맞는 leg을 선택. current가 stations.json에 없으면 기존 first-leg fallback.
  const currentStation = getStationById(currentStationId);
  const { line, endName } = currentStation
    ? pickLegForCurrentLine(route, destinationName, currentStation.line, currentStationId)
    : getFirstLeg(route, destinationName);
  const lineStations = getStationsOnLine(line);
  const currIdx = lineStations.findIndex((s) => s.id === currentStationId);
  const nextIdx = lineStations.findIndex((s) => s.name === endName);
  if (currIdx < 0 || nextIdx < 0 || currIdx === nextIdx) return null;

  // #1922 — closed loop 본선 양 끝점: wraparound 짧은 쪽 path의 첫 step 방향으로 결정.
  // 2호선 강변 → 잠실나루 같은 short forward path는 path[1] > currIdx → 'down'(외선 외향).
  // 신촌 → 시청 같은 wraparound는 path[1] < currIdx → 'up'(내선 외향).
  const currId = lineStations[currIdx].id;
  const nextId = lineStations[nextIdx].id;
  if (isClosedLoopMainStation(line, currId) && isClosedLoopMainStation(line, nextId)) {
    const path = shortestLinePathIndices(lineStations, currIdx, nextIdx, line);
    // shortestLinePathIndices invariant: currIdx !== nextIdx → path.length >= 2
    const firstStepIdx = path[1];
    return firstStepIdx > currIdx ? 'down' : 'up';
  }

  return nextIdx > currIdx ? 'down' : 'up';
}
