import type { LineNumber } from '../../../shared/types/station';
import { getStationsOnLine } from '../../../shared/utils/stationRoute';
import { isClosedLoopMainStation, shortestLinePathIndices } from '../../../shared/utils/lineLoopPath';

/**
 * 노선 위 진행 방향.
 * - 단조 노선: 'down' = id 증가 방향, 'up' = id 감소 방향.
 * - 2호선 순환선 본선: 'up' = 내선(id 증가 방향), 'down' = 외선(id 감소 방향) — #2867,
 *   10/3·9/17 양방향 실측 52쌍으로 확정된 ground truth. `resolveTripDirection`(tripDirection.ts)와
 *   동일한 관례.
 */
export type LineDirection = 'up' | 'down';

/**
 * 같은 노선 위 두 station id 사이의 진행 방향을 산출하는 공유 primitive (#2455).
 *
 * `shortestLinePathIndices`(2호선 closed loop wraparound-aware 짧은 경로 산출, `lineLoopPath.ts`)
 * 위에서 첫 step의 idx 증감으로 방향을 결정한다 — `resolveTripDirection`이 Route/leg 선택 뒤에
 * 내부적으로 쓰는 것과 **동일한 알고리즘**을 Route 의존 없이 station id 두 개만으로 재사용할 수
 * 있게 뽑아낸 것. `resolveTravelDirection`(단조 노선)/`inferLoopDirection`(forward-backward 호
 * 길이 비교)을 조합하지 않는 이유: 2호선 순환선 seam(시청↔충정로)에서 그 두 유틸의 wraparound
 * 판정이 서로 어긋나는 사례를 발견했다(#2455 설계 노트) — `shortestLinePathIndices` 기반 하나의
 * 알고리즘만 쓰면 이 불일치가 원천적으로 없다.
 *
 * Route가 없는 호출자(예: R1c의 `arcStations: Station[]` 기반 estimator)도 station id만으로
 * 쓸 수 있도록 의도적으로 Route-level이 아닌 station-id-level API로 설계했다.
 *
 * - 같은 station이거나(fromId === toId) 두 id 중 하나라도 해당 노선에 없으면 null (판정 불가).
 */
export function directionOnLine(
  line: LineNumber,
  fromStationId: string,
  toStationId: string,
): LineDirection | null {
  const stations = getStationsOnLine(line);
  const fromIdx = stations.findIndex((s) => s.id === fromStationId);
  const toIdx = stations.findIndex((s) => s.id === toStationId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return null;

  const path = shortestLinePathIndices(stations, fromIdx, toIdx, line);
  // shortestLinePathIndices invariant: fromIdx !== toIdx → path.length >= 2
  const firstStepIdx = path[1];

  // #2867 — 2호선 순환선 본선(양 끝 모두 closed loop main station)은 idx 증가 = 내선 = 'up'.
  // 그 외(단조 노선, 지선)는 기존 관례(id 증가 = 'down') 유지 — resolveTripDirection과 동일 분기.
  const fromId = stations[fromIdx].id;
  const toId = stations[toIdx].id;
  if (isClosedLoopMainStation(line, fromId) && isClosedLoopMainStation(line, toId)) {
    return firstStepIdx > fromIdx ? 'up' : 'down';
  }
  return firstStepIdx > fromIdx ? 'down' : 'up';
}
