import type { LineNumber } from '../../../shared/types/station';
import { resolveTravelDirection } from './travelDirection';
import { inferLoopDirection, nextLoopAdjacentStationName } from './loopDirection';
import { getStationsOnLine, normalizeStationName } from '../../../shared/utils/stationRoute';

/**
 * 현재역에서 toward 방향(다음 waypoint 또는 종착)으로 한 정거장 뒤의 인접역 이름을 반환(#649).
 *
 * BoardingTrainList가 사용자에게 "다음 인접역 방면"으로 표기하기 위함 — 종착(석남) 대신
 * 다음 정거장(중곡) 같은 즉각적인 정보를 노출한다.
 *
 * 단조 노선(`lineTopology.json`의 monotonicLines)이 우선. 비단조/순환 노선(2호선 본선, 6호선
 * 응암 루프)은 resolveTravelDirection이 null을 반환하므로 `inferLoopDirection` +
 * `nextLoopAdjacentStationName`(loopDirection.ts)으로 fallback한다(#2446 — 뚝섬에서 "성수행"
 * 같은 raw headsign이 그대로 노출되던 회귀. resolveTravelDirection null → 이 함수도 null →
 * 호출자가 route와 무관한 원본 trainLineNm으로 fallback했던 것이 근본 원인).
 *
 * 두 fallback 모두 실패(대상 노선 아님/역 미매칭/ambiguous)하면 null. 호출자는 기존과 동일하게
 * 종착 표기 등으로 fallback한다.
 */
export function resolveNextAdjacentStationName(
  line: LineNumber,
  currentStationName: string,
  towardStationName: string,
): string | null {
  const resolution = resolveTravelDirection(line, currentStationName, towardStationName);
  if (resolution) {
    // resolveTravelDirection이 같은 stations 캐시를 normalize로 매칭해 성공했으므로,
    // 같은 캐시·같은 normalize로 currentIdx 재조회는 반드시 ≥0. 노선 종단점도 toward와 동일하지
    // 않으므로 nextIdx는 항상 유효 범위 안.
    const stations = getStationsOnLine(line);
    const target = normalizeStationName(currentStationName);
    const currentIdx = stations.findIndex((s) => normalizeStationName(s.name) === target);
    const nextIdx = resolution.direction === 'down' ? currentIdx + 1 : currentIdx - 1;
    return stations[nextIdx].name;
  }

  const loopDirection = inferLoopDirection(line, currentStationName, towardStationName);
  if (!loopDirection) return null;
  return nextLoopAdjacentStationName(line, currentStationName, loopDirection);
}
