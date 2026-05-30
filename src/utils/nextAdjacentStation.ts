import type { LineNumber } from '../types/station';
import { resolveTravelDirection } from './travelDirection';
import { getStationsOnLine, normalizeStationName } from './stationRoute';

/**
 * 현재역에서 toward 방향(다음 waypoint 또는 종착)으로 한 정거장 뒤의 인접역 이름을 반환(#649).
 *
 * BoardingTrainList가 사용자에게 "다음 인접역 방면"으로 표기하기 위함 — 종착(석남) 대신
 * 다음 정거장(중곡) 같은 즉각적인 정보를 노출한다.
 *
 * 단조 노선(`lineTopology.json`의 monotonicLines)에 한해 동작. 비단조/순환 노선이거나
 * 현재역/방향역이 stations 리스트에서 매칭 안 되면 null — 호출자는 fallback(종착 표기 등)을 선택한다.
 *
 * 현재역이 방향 끝(첫/마지막 정거장)이면 null.
 */
export function resolveNextAdjacentStationName(
  line: LineNumber,
  currentStationName: string,
  towardStationName: string,
): string | null {
  const resolution = resolveTravelDirection(line, currentStationName, towardStationName);
  if (!resolution) return null;
  const stations = getStationsOnLine(line);
  const target = normalizeStationName(currentStationName);
  const currentIdx = stations.findIndex((s) => normalizeStationName(s.name) === target);
  if (currentIdx === -1) return null;
  const nextIdx = resolution.direction === 'down' ? currentIdx + 1 : currentIdx - 1;
  if (nextIdx < 0 || nextIdx >= stations.length) return null;
  return stations[nextIdx].name;
}
