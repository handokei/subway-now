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
 * 현재역/방향역이 stations 리스트에서 매칭 안 되면 resolveTravelDirection이 null 반환 →
 * 본 함수도 null. 호출자는 fallback(종착 표기 등)을 선택한다.
 */
export function resolveNextAdjacentStationName(
  line: LineNumber,
  currentStationName: string,
  towardStationName: string,
): string | null {
  const resolution = resolveTravelDirection(line, currentStationName, towardStationName);
  if (!resolution) return null;
  // resolveTravelDirection이 같은 stations 캐시를 normalize로 매칭해 성공했으므로,
  // 같은 캐시·같은 normalize로 currentIdx 재조회는 반드시 ≥0. 노선 종단점도 toward와 동일하지
  // 않으므로 nextIdx는 항상 유효 범위 안.
  const stations = getStationsOnLine(line);
  const target = normalizeStationName(currentStationName);
  const currentIdx = stations.findIndex((s) => normalizeStationName(s.name) === target);
  const nextIdx = resolution.direction === 'down' ? currentIdx + 1 : currentIdx - 1;
  return stations[nextIdx].name;
}
