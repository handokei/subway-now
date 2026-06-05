import type { BoardingLock } from '../../alarm/types/boardingLock';
import type { LineNumber, Station } from '../../../shared/types/station';
import type { Route } from './stationRoute';
import {
  findStationByNameAndLine,
  getRemainingStops,
  getStationsOnLine,
  isSameStationName,
} from './stationRoute';
import { resolveAllTargets } from '../../alarm/utils/stationAlarm';
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
  /**
   * 사용자가 방금 도달해서 환승을 끝낸 transfer의 인덱스 (#604).
   * - transfer 라우트: 항상 0
   * - multi-transfer 라우트: route.transfers 배열의 인덱스와 1:1 (resolveAllTargets가 같은 순서로 매핑)
   * createTransferLock이 calculateRemainingLegETA(route, completedTransferIdx)로 잔여 ride time을
   * 산출하는 데 사용. 잔여 leg는 idx+1번째 transfer부터 시작.
   */
  completedTransferIdx: number;
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
    completedTransferIdx: matchedIdx,
  };
}

/** prefetch 트리거에 사용 — 환승 imminent로 판정하는 잔여 stops 임계값 (#814). */
const PREFETCH_IMMINENT_STOPS = 1;

export interface UpcomingTransferTarget {
  /** 환승 후 탑승할 노선 — useArrivalInfo lineHint로 사용. */
  nextLine: LineNumber;
  /** toLine 기준 환승역 이름 — prefetch 캐시 키(useArrivalInfo의 stationName과 동일 스코프). */
  transferStationName: string;
}

/**
 * 현재 leg에서 다음 환승이 imminent(잔여 stops ≤ 1)인지 판정하고, prefetch 대상(next line + 환승역)
 * 을 반환한다 (#814). 이미 환승역 도달해 findActiveTransferContext가 활성 컨텍스트를 반환하는
 * 순간은 포함된다(잔여 stops = 0).
 *
 * - lock/route/currentStation 중 하나라도 없으면 null
 * - lock.boardingLine을 fromLine으로 가지는 transfer waypoint(=다음 환승)를 찾아
 *   currentStation으로부터의 잔여 stops를 계산. PREFETCH_IMMINENT_STOPS 이하만 반환
 * - direct route는 transfer waypoint가 없어 null
 * - currentStation이 fromLine 변형이 아닌 경우(=환승 도중 nextLine으로 이미 stitch된 상태)는
 *   nextLine 변형으로 currentStation을 재조회해 잔여=0(=환승역 위)로 평가
 *
 * 호출자(useTransferTrainList)는 결과를 받으면 prefetchArrival을 호출해 BoardingTrainList
 * warmup을 줄인다. 비환승 trip은 null 반환 → prefetch 미발생.
 */
export function findUpcomingTransferPrefetch(
  lock: BoardingLock | null,
  route: Route,
  destinationName: string | null,
  currentStation: Station | null,
): UpcomingTransferTarget | null {
  if (!lock || !route || !destinationName || !currentStation) return null;
  if (route.type === 'direct') return null;

  const targets = resolveAllTargets(route, destinationName);
  // 다음 환승 = lock.boardingLine을 fromLine으로 사용하는 transfer 타겟 (= approachLine === boardingLine).
  // multi-transfer에서도 사용자가 현재 leg의 boardingLine을 기준으로 다음 환승만 찾는다.
  const upcoming = targets.find(
    (t) => t.alarmType === 'transfer' && t.approachLine === lock.boardingLine,
  );
  if (!upcoming) return null;

  const upcomingIdx = targets.indexOf(upcoming);
  const next = targets[upcomingIdx + 1];
  // resolveAllTargets는 transfer 타겟 뒤에 destination/다음 transfer를 보장 — 방어 코드만.
  /* istanbul ignore next */
  if (!next) return null;

  const nextLine = next.approachLine;
  // 위 upcoming 매칭이 t.approachLine === lock.boardingLine 조건으로 이미 filter 했으므로
  // lock.boardingLine === nextLine 시나리오는 매칭 자체가 안 된다 (다음 leg는 다른 노선).
  // 같은 노선 안에서 leg가 분리되는 케이스(e.g. 분기선)는 stations.json 라우트에 없음.

  // 잔여 stops: currentStation이 fromLine 변형이면 직접 계산.
  const fromLineStation = findStationByNameAndLine(currentStation.name, upcoming.approachLine);
  const transferOnFromLine = findStationByNameAndLine(upcoming.name, upcoming.approachLine);
  /* istanbul ignore next -- targets는 stations.json에서 도출되므로 lookup 실패는 데이터 정합성 가상 케이스. */
  if (!transferOnFromLine) return null;

  // currentStation.name이 fromLine 변형으로 존재하지 않으면 잔여 stops를 계산할 수 없다.
  // 일반 시나리오에선 사용자가 fromLine 위에 있어 lookup이 항상 성공한다. lookup 실패는 fusion이
  // 다른 노선으로 stitch됐거나 데이터 정합성 깨진 케이스 — 보수적으로 prefetch 건너뜀.
  if (!fromLineStation) return null;

  const remainingStops = getRemainingStops(fromLineStation.id, transferOnFromLine.id);
  /* istanbul ignore next -- fromLineStation과 transferOnFromLine은 같은 line(upcoming.approachLine)
     으로 lookup된 결과라 getRemainingStops가 null을 반환할 일이 없다. 방어 코드. */
  if (remainingStops === null) return null;
  if (remainingStops > PREFETCH_IMMINENT_STOPS) return null;

  return { nextLine, transferStationName: upcoming.name };
}

/**
 * 한 노선 내에서 from station id ↔ to station name의 index 비교로 방향 산출.
 * tripDirection.ts의 resolveTripDirection은 route의 첫 leg만 보므로 환승 후 leg에는 쓸 수 없음 — 별도 유틸.
 * 테스트 노출용 export — 실데이터 의존이라 정/역방향 양쪽 분기 강제하기 위해 직접 호출.
 */
export function resolveDirectionInLine(
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
