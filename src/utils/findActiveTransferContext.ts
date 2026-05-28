import type { BoardingLock } from '../types/boardingLock';
import type { LineNumber, Station } from '../types/station';
import type { Route } from './stationRoute';
import { findStationByNameAndLine, getStationsOnLine, isSameStationName } from './stationRoute';
import { resolveAllTargets } from './stationAlarm';
import type { TripDirection } from './tripDirection';

export interface ActiveTransferContext {
  /** toLine 기준의 환승역 Station 객체 (새 lock의 boardingStationId/Line 출처). */
  transferStationInToLine: Station;
  /** 환승 후 탑승할 노선. */
  nextLine: LineNumber;
  /** 환승 직후 다음 waypoint(=destination 또는 다음 transfer)의 이름. */
  nextWaypointName: string;
  /** toLine 기준 새 진행방향. 좌표/index 비교 실패 시 null — 양방향 합산 fallback. */
  direction: TripDirection | null;
}

/**
 * BoardingLock이 활성이고 사용자가 현재 leg의 transfer waypoint에 도달했으면 환승 컨텍스트를 반환 (#584 PR E).
 *
 * - lock/route/destinationName/currentStation 중 하나라도 없으면 null
 * - resolveAllTargets로 waypoint 목록 산출 후 currentStation.name과 매칭되는 target 탐색
 * - 매칭된 target이 transfer가 아니거나 그 다음 target이 없으면 null (도착역이거나 환승 없음)
 * - 매칭된 target의 다음 target.approachLine을 nextLine으로 사용 — 환승 후 진행할 노선
 * - direction은 transferStationInToLine.id ↔ nextWaypointName의 line stations index 비교로 산출
 */
export function findActiveTransferContext(
  lock: BoardingLock | null,
  route: Route,
  destinationName: string | null,
  currentStation: Station | null,
): ActiveTransferContext | null {
  if (!lock || !route || !destinationName || !currentStation) return null;

  const targets = resolveAllTargets(route, destinationName);
  const matchedIdx = targets.findIndex((t) => isSameStationName(t.name, currentStation.name));
  if (matchedIdx === -1) return null;

  const matched = targets[matchedIdx];
  if (matched.alarmType !== 'transfer') return null;

  const next = targets[matchedIdx + 1];
  /* istanbul ignore next -- resolveAllTargets는 transfer가 매칭되면 그 다음 target(destination 또는
     다음 transfer)이 항상 존재한다. 마지막 target이 transfer가 되려면 그 자체가 destination이어야
     하는데 그 경우 alarmType==='destination'으로 위 가드에서 이미 차단됨. 방어 코드. */
  if (!next) return null;

  const nextLine = next.approachLine;
  // lock이 이미 nextLine으로 교체된 상태(=환승 완료)면 context 재노출하지 않음.
  // 사용자가 새 열차 탭 → createTransferLock → boardingLine=nextLine 갱신되었지만 GPS는 아직
  // 환승역에 머무는 경우, 가드 없으면 같은 list가 다시 노출되어 lock 중복 생성 가능.
  if (lock.boardingLine === nextLine) return null;
  const transferStationInToLine = findStationByNameAndLine(matched.name, nextLine);
  if (!transferStationInToLine) return null;

  const direction = resolveDirectionInLine(
    nextLine,
    transferStationInToLine.id,
    next.name,
  );

  return {
    transferStationInToLine,
    nextLine,
    nextWaypointName: next.name,
    direction,
  };
}

/**
 * 한 노선 내에서 from station id ↔ to station name의 index 비교로 방향 산출.
 * tripDirection.ts의 resolveTripDirection은 route의 첫 leg만 보므로 환승 후 leg에는 쓸 수 없음 — 별도 유틸.
 */
function resolveDirectionInLine(
  line: LineNumber,
  fromStationId: string,
  toStationName: string,
): TripDirection | null {
  const stations = getStationsOnLine(line);
  const currIdx = stations.findIndex((s) => s.id === fromStationId);
  const nextIdx = stations.findIndex((s) => s.name === toStationName);
  /* istanbul ignore next -- 호출 직전 findStationByNameAndLine과 next.approachLine 일관성으로
     실제 데이터에서는 도달 불가. 정합성 깨진 데이터를 위한 방어 코드. */
  if (currIdx < 0 || nextIdx < 0 || currIdx === nextIdx) return null;
  return nextIdx > currIdx ? 'down' : 'up';
}
