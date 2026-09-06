/**
 * #2328 (consensus-B, 설계 SSoT #2323 코멘트 (2) 오매칭 필터) — leg 후보 오매칭 사전 배제.
 *
 * `transferLegConsensus.ts`(#2327) 후보 엔진이 다음 waypoint arrivals에서 관측한 trainCode를
 * 실제 승차 열차 후보로 신뢰할지 판정하기 전, 4단계 순수 필터로 명백한 오매칭을 사전 배제한다.
 * 평가 순서(설계안 (2)):
 *
 *   ① `computeAllowedLines` 밖 — hard reject. 신규 로직 없음, `consensusGate.ts`(#1439 E6) 재사용.
 *   ② `inferLegDirection` vs 후보 진행 방향(isUp) mismatch — hard reject. 방향 추론 불가(null,
 *      비단조/지선 노선)면 dormant(pass) — 정차 패턴 필터(④)가 실질적 오매칭 방지를 대행한다.
 *   ③ 지선: 후보 행선지(terminus, `seoul.ts:parseTerminusStationName`)가 leg2 waypoint 진행
 *      방향을 커버하지 못하는 분기(다른 지선 종점, 미매핑 종점)면 hard reject. 같은 경로 안에서
 *      leg2 최종 waypoint 전에 멈추는 단축 운행은 soft 감점(caller가 우선순위만 낮춤).
 *   ④ 급행: `EXPRESS_STOPS`(#1652 ADR-005)에 없는 정차 waypoint는 급행 후보에게
 *      "not-applicable" — 정차 안 하는 역을 못 봤다고 mismatch로 오집계하면 9호선 급행 회귀가
 *      재발한다.
 *
 * 전부 순수 함수 — KV/네트워크 의존 없음. `transferLegConsensus`/`advanceTripPosition` 배선은
 * consensus-C(#2329)가 담당한다(본 PR 범위 밖).
 */

import lineTopology from '../../../src/data/lineTopology.json';
import { findStationByNameAndLine } from '../../../src/shared/utils/stationLookup';
import { EXPRESS_STOPS, type ExpressStopsByType } from '../../../src/data/expressStops';
import type { TrainType } from '../../../src/shared/constants/trainTypes';
import { computeAllowedLines, isLockLineAllowed } from './consensusGate';
import { inferLegDirection } from './legDirection';
import type { LineNumber, Route, Waypoint } from './types';

interface ClosedLoopMeta {
  mainIdRange: { firstId: string; lastId: string };
  loopTailRange?: { firstId: string; lastId: string };
}

/** #1703 lineTopology.json `closedLoops` — mainIdRange가 지선 배제 SSoT (`legDirection.ts`와 공유). */
const CLOSED_LOOPS = lineTopology.closedLoops as Partial<Record<string, ClosedLoopMeta>>;
/** backend `LineNumber = string`으로 인덱싱하기 위한 캐스트 — frontend union key 타입 우회. */
const EXPRESS_STOPS_BY_LINE = EXPRESS_STOPS as Partial<Record<string, ExpressStopsByType>>;

export type LegFilterVerdict =
  | { kind: 'pass' }
  | { kind: 'not-applicable' }
  | { kind: 'soft-penalty'; reason: string }
  | { kind: 'reject'; reason: string };

/** shared `findStationByNameAndLine`은 union LineNumber를 받지만 backend는 string — 런타임은 `===` 비교라 안전. */
function lookupStation(name: string, line: LineNumber) {
  return findStationByNameAndLine(name, line as Parameters<typeof findStationByNameAndLine>[1]);
}

/**
 * ① 후보 line이 trip route + waypoints의 allowedLines union 밖이면 hard reject.
 * `consensusGate.ts:computeAllowedLines`/`isLockLineAllowed` 그대로 재사용(신규 로직 없음).
 */
export function filterCandidateLine(
  candidateLine: LineNumber,
  route: Route,
  waypoints: readonly Waypoint[] = [],
): LegFilterVerdict {
  const allowed = computeAllowedLines(route, waypoints);
  return isLockLineAllowed({ line: candidateLine }, allowed)
    ? { kind: 'pass' }
    : { kind: 'reject', reason: 'line-not-allowed' };
}

/**
 * ② leg 진행 방향과 후보 진행 방향(isUp) mismatch면 hard reject.
 * `inferLegDirection`이 null(비단조/지선 노선 — #1719 정책)이면 방향 추론 불가 — dormant(pass).
 */
export function filterCandidateDirection(
  line: LineNumber,
  candidateIsUp: boolean,
  fromStationName: string,
  toStationName: string,
): LegFilterVerdict {
  const expected = inferLegDirection(line, fromStationName, toStationName);
  if (expected === null) return { kind: 'pass' };
  const candidateDirection = candidateIsUp ? 'up' : 'down';
  return candidateDirection === expected
    ? { kind: 'pass' }
    : { kind: 'reject', reason: 'direction-mismatch' };
}

interface StationLike {
  readonly id: string;
}

/**
 * leg2 waypoint 커버리지를 진행 방향(waypoint 배열 순서 — nearest→furthest, trip.waypoints와
 * 동일 관행)으로 판정. terminus가 furthest(마지막 leg2 waypoint) 이상 진행하면 pass, nearest~
 * furthest 구간 안에서 못 미쳐 멈추면 soft-penalty(단축 운행), 그 구간 밖(반대 방향으로 벗어남)
 * 이면 reject.
 *
 * 정렬(min/max)이 아니라 배열의 첫/끝 원소를 쓴다 — waypoint 배열 순서 자체가 진행 방향이므로
 * id가 감소하는 방향(예: 순환선을 역방향으로 도는 leg)도 올바르게 판정한다.
 */
function evaluateWaypointCoverage(
  waypointStations: readonly StationLike[],
  terminusStation: StationLike,
): LegFilterVerdict {
  const nearest = waypointStations[0];
  const furthest = waypointStations[waypointStations.length - 1];
  const ascending = furthest.id >= nearest.id;
  const terminusId = terminusStation.id;

  const coversAll = ascending ? terminusId >= furthest.id : terminusId <= furthest.id;
  if (coversAll) return { kind: 'pass' };

  const onSamePath = ascending ? terminusId >= nearest.id : terminusId <= nearest.id;
  if (onSamePath) return { kind: 'soft-penalty', reason: 'branch-shortened-service' };

  return { kind: 'reject', reason: 'branch-terminus-diverges' };
}

/**
 * ③ 지선 오매칭 필터. terminus/leg2Waypoints 정보 부재 시 판단 불가 — 보수적으로 pass.
 *
 * mainIdRange가 등록된 노선(2/6호선)에서 leg2 waypoint가 전부 본선 구간 안에 있는데 terminus가
 * 본선 밖(지선)이면 hard reject(2호선 성수/신정지선 등). mainIdRange 미등록 노선(5호선 마천/하남
 * 분기 등)에서는 stations.json에 없는 terminus(다른 지선의 미매핑 역)를 hard reject로 다룬다 —
 * 앱이 애초에 그 지선을 모르는 상태에서 leg2 waypoint를 그 방향으로 생성할 수 없으므로, 안전한
 * 보수적 판단이다.
 */
export function filterCandidateBranchTerminus(
  line: LineNumber,
  terminus: string | null,
  leg2Waypoints: readonly Pick<Waypoint, 'stationName' | 'line'>[],
): LegFilterVerdict {
  if (terminus === null) return { kind: 'pass' };

  const waypointStations = leg2Waypoints
    .filter((wp) => wp.line === line)
    .map((wp) => lookupStation(wp.stationName, line))
    .filter((s): s is NonNullable<ReturnType<typeof lookupStation>> => s !== null);
  if (waypointStations.length === 0) return { kind: 'pass' };

  const terminusStation = lookupStation(terminus, line);
  const mainRange = CLOSED_LOOPS[line]?.mainIdRange;
  const waypointsAllInMain =
    mainRange !== undefined &&
    waypointStations.every((s) => s.id >= mainRange.firstId && s.id <= mainRange.lastId);

  if (waypointsAllInMain && mainRange !== undefined) {
    if (!terminusStation) return { kind: 'reject', reason: 'branch-terminus-unresolved' };
    const terminusInMain =
      terminusStation.id >= mainRange.firstId && terminusStation.id <= mainRange.lastId;
    if (!terminusInMain) return { kind: 'reject', reason: 'branch-terminus-diverges' };
    return evaluateWaypointCoverage(waypointStations, terminusStation);
  }

  if (!terminusStation) return { kind: 'reject', reason: 'branch-terminus-unresolved' };
  return evaluateWaypointCoverage(waypointStations, terminusStation);
}

/**
 * ④ 급행 정차 필터. 후보가 급행/특급/ITX이고 waypoint 역이 `EXPRESS_STOPS`에 없으면
 * "not-applicable" — caller(consensus-C, #2329)는 이 waypoint를 해당 후보의 match/mismatch
 * 집계에서 제외해야 한다. 데이터 미보유 노선/타입은 보수적으로 pass(정차 취급) —
 * frontend `expressLookup.ts:isExpressStop`과 동일 정책.
 */
export function filterCandidateExpressStop(
  line: LineNumber,
  trainType: TrainType,
  waypointStationName: string,
): LegFilterVerdict {
  if (trainType === 'normal') return { kind: 'pass' };
  const stops = EXPRESS_STOPS_BY_LINE[line]?.[trainType];
  if (!stops) return { kind: 'pass' };
  return stops.has(waypointStationName) ? { kind: 'pass' } : { kind: 'not-applicable' };
}
