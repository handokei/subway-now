/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { LineNumber, Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import {
  findStationByNameAndLine,
  getRemainingStops,
  isSameStationName,
} from '../../../shared/utils/stationRoute';
import { resolveAllTargets } from '../../alarm/utils/stationAlarm';
import { directionOnLine } from './directionOnLine';
import type { TripDirection } from './tripDirection';

export interface ActiveTransferContext {
  /** toLine 기준의 환승역 Station 객체 (새 lock의 boardingStationId/Line 출처). */
  transferStationInToLine: Station;
  /** 환승 후 탑승할 노선. */
  nextLine: LineNumber;
  /** 환승 직후 다음 waypoint(=destination 또는 다음 transfer)의 이름. */
  nextWaypointName: string;
  /**
   * toLine 기준 새 진행방향 — `directionOnLine`(station id 두 개, #2455)으로 산출한다.
   * `shortestLinePathIndices` 기반 단일 알고리즘이라 2호선 순환선 wraparound seam(시청↔충정로)도
   * 정확히 처리한다(#2609). nextWaypoint의 toLine station을 못 찾거나(예: 데이터 정합성 문제)
   * 같은 station이면 null — 호출자는 양방향 합산으로 fallback한다.
   */
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
 * - direction은 transferStationInToLine.id → nextWaypoint(toLine 변형)의 id를 directionOnLine
 *   (#2455, shortestLinePathIndices 기반 단일 알고리즘)으로 판정한다(#2609).
 */
export function findActiveTransferContext(
  lock: BoardingLock | null,
  route: Route,
  destinationName: string | null,
  currentStation: Station | null,
): ActiveTransferContext | null {
  if (!lock || !route || !destinationName || !currentStation) return null;

  const matched = resolveTransferWaypoint(route, destinationName, currentStation);
  if (!matched) return null;

  const { nextLine, transferStationInToLine, nextWaypointName, matchedIdx } = matched;
  // lock이 이미 nextLine으로 교체된 상태(=환승 완료)면 context 재노출하지 않음.
  // 사용자가 새 열차 탭 → createTransferLock → boardingLine=nextLine 갱신되었지만 GPS는 아직
  // 환승역에 머무는 경우, 가드 없으면 같은 list가 다시 노출되어 lock 중복 생성 가능.
  if (lock.boardingLine === nextLine) return null;

  // nextWaypoint(destination/다음 transfer)의 toLine 변형 station을 조회해 id 기반으로
  // directionOnLine에 넘긴다 — #1410 BLDN_NM drift도 findStationByNameAndLine의 정규화
  // fallback으로 흡수된다. lookup 실패(데이터 정합성 문제)면 direction=null로 안전 폴백.
  const nextWaypointStation = findStationByNameAndLine(nextWaypointName, nextLine);
  const direction = nextWaypointStation
    ? directionOnLine(nextLine, transferStationInToLine.id, nextWaypointStation.id)
    : null;

  return {
    transferStationInToLine,
    nextLine,
    nextWaypointName,
    direction,
    completedTransferIdx: matchedIdx,
  };
}

export interface LocklessTransferWaypoint {
  /** toLine 기준의 환승역 Station 객체 — legAdvance stamp의 nextLine 근거. */
  transferStationInToLine: Station;
  /** 환승 후 탑승할 노선. */
  nextLine: LineNumber;
  /** 환승 직후 다음 waypoint(=destination 또는 다음 transfer)의 이름 (#2830). */
  nextWaypointName: string;
}

/**
 * #2319 — lock 유무와 무관하게 route + destinationName + currentStation만으로 환승 waypoint
 * 도달을 판정한다. `findActiveTransferContext`는 lock 존재를 전제(#584 PR E 원 설계 — BoardingLock
 * SSOT 기반 환승 list/autoLock)해 lockless trip(origin lock 자체가 없는 trip)에서는 영원히 null을
 * 반환한다. `useTransferTrainList`의 durable legAdvance stamp(#2305)는 이 함수로 lock-비종속
 * 신호를 얻어, lockless trip 환승 진행 시에도 approachLine이 동결 route fallback으로 남지 않도록
 * 한다. arrivals list/autoLock(#1211 D5)은 여전히 lock-bound `findActiveTransferContext`만 사용
 * — 이 함수는 stamp 전용 lock-비종속 신호다.
 */
export function findLocklessTransferWaypoint(
  route: Route,
  destinationName: string | null,
  currentStation: Station | null,
): LocklessTransferWaypoint | null {
  if (!route || !destinationName || !currentStation) return null;
  const matched = resolveTransferWaypoint(route, destinationName, currentStation);
  if (!matched) return null;
  return {
    transferStationInToLine: matched.transferStationInToLine,
    nextLine: matched.nextLine,
    nextWaypointName: matched.nextWaypointName,
  };
}

/**
 * #2858 — 10/1 실측 root. `findLocklessTransferWaypoint`는 currentStation이 **정확히** 환승역
 * 자체일 때만(exact name match) 매칭한다. 환승 release(backend `lockReleasedReason='transfer'`
 * → `releaseLock`) 이후 사용자가 leg-2를 한 정거장이라도 더 진행하면 그 매칭이 다시 깨져
 * `buildBoardingPromptContext`의 lock-null 분기가 `getFirstLeg`(leg-1)로 fall back한다 —
 * "뚝섬→성수 2호선 탑승하셨나요" 좀비 로컬 프롬프트.
 *
 * transfer target을 **가장 진행된 leg(배열 끝)부터 역순**으로 스캔해, currentStation이 그 leg의
 * nextLine 위에 존재하는 첫 leg를 반환한다. 환승은 항상 line이 바뀌는 지점이라(같은 line으로
 * "환승"하는 route는 설계상 없음) currentStation이 어떤 nextLine 위에 존재한다는 사실 자체가
 * "그 leg로 이미 넘어갔다"는 충분조건이다 — 아직 그 leg에 도달하지 않은 이전 leg와 혼동되지
 * 않는다. 역순 스캔은 드문 edge(동일 역명이 여러 line에 중복 존재)에서도 기존 전제(#1921 cross-trip
 * 자동전환 등)와 동형인 monotonic 진행 가정에 따라 더 진행된 해석을 우선한다.
 *
 * `findActiveTransferContext`(lock-bound)와 `findLocklessTransferWaypoint`(exact-match, legAdvance
 * stamp 트리거용)는 의도적으로 변경하지 않는다 — 각각 "방금 막 환승역에 도달"이라는 정밀한 순간을
 * 포착해야 하는 소비자(BoardingTrainList 노출/lock 생성, legAdvance stamp)를 갖고 있어 매칭을
 * 넓히면 그 소비자들의 의미가 달라진다. 이 함수는 `boardingPromptContext`의 lock-null 분기 전용
 * (더 넓은 "지금 어느 leg인가" 신호).
 */
export function findLocklessActiveLegWaypoint(
  route: Route,
  destinationName: string | null,
  currentStation: Station | null,
): LocklessTransferWaypoint | null {
  if (!route || !destinationName || !currentStation) return null;
  const targets = resolveAllTargets(route, destinationName);

  for (let i = targets.length - 2; i >= 0; i--) {
    const target = targets[i];
    /* istanbul ignore next -- resolveAllTargets는 항상 마지막 target만 'destination'이고 그 이전은
       전부 'transfer'다(stationAlarm.ts 생성 규칙). 이 루프는 마지막 index(destination)를 제외한
       범위만 스캔하므로 이 분기는 구조적으로 도달 불가 — resolveAllTargets 계약이 바뀌는 경우에
       대한 방어 코드. */
    if (target.alarmType !== 'transfer') continue;
    const next = targets[i + 1];
    /* istanbul ignore next -- resolveAllTargets는 transfer 다음에 항상 target(destination 또는
       다음 transfer)을 보장한다(마지막 target은 항상 destination). 방어 코드. */
    if (!next) continue;

    const nextLine = next.approachLine;
    if (!findStationByNameAndLine(currentStation.name, nextLine)) continue;

    const transferStationInToLine = findStationByNameAndLine(target.name, nextLine);
    if (!transferStationInToLine) continue;

    return { transferStationInToLine, nextLine, nextWaypointName: next.name };
  }
  return null;
}

interface ResolvedTransferWaypoint {
  transferStationInToLine: Station;
  nextLine: LineNumber;
  nextWaypointName: string;
  matchedIdx: number;
}

/**
 * `findActiveTransferContext`와 `findLocklessTransferWaypoint`가 공유하는 core 매칭 로직
 * (lock 무관). resolveAllTargets로 waypoint 목록 산출 후 currentStation.name과 매칭되는
 * transfer target을 탐색한다.
 */
function resolveTransferWaypoint(
  route: NonNullable<Route>,
  destinationName: string,
  currentStation: Station,
): ResolvedTransferWaypoint | null {
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
  const transferStationInToLine = findStationByNameAndLine(matched.name, nextLine);
  if (!transferStationInToLine) return null;

  return { transferStationInToLine, nextLine, nextWaypointName: next.name, matchedIdx };
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
