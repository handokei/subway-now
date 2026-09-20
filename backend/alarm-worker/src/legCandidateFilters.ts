/**
 * #2328 (consensus-B, 설계 SSoT #2323 코멘트 (2) 오매칭 필터) — leg 후보 오매칭 사전 배제.
 *
 * `transferLegConsensus.ts`(#2327) 후보 엔진이 다음 waypoint arrivals에서 관측한 trainCode를
 * 실제 승차 열차 후보로 신뢰할지 판정하기 전, 순수 필터로 명백한 오매칭을 사전 배제한다.
 * 평가 순서(설계안 (2)):
 *
 *   ① `computeAllowedLines` 밖 — hard reject. 신규 로직 없음, `consensusGate.ts`(#1439 E6) 재사용.
 *   ② `inferLegDirection` vs 후보 진행 방향(isUp) mismatch — hard reject. 방향 추론 불가(null,
 *      비단조/지선 노선)면 dormant(pass) — 정차 패턴 필터가 실질적 오매칭 방지를 대행한다.
 *
 * #2765 (게이트 전수감사 A) — ③ 지선 필터(`filterCandidateBranchTerminus`)와 ④ 급행 필터
 * (`filterCandidateExpressStop`)는 설계됐으나 caller(consensus-C, #2329)에 끝내 배선되지 않은
 * 채 생산자 0건으로 남은 것이 감사로 확정돼 제거됐다. 급행 mismatch 오집계 방어가 필요해지면
 * 그때 별도 설계(#2754 트랙)로 재도입한다.
 *
 * 전부 순수 함수 — KV/네트워크 의존 없음. `transferLegConsensus`/`advanceTripPosition` 배선은
 * consensus-C(#2329)가 담당한다(본 PR 범위 밖).
 */

import { computeAllowedLines, isLockLineAllowed } from './consensusGate';
import { inferLegDirection } from './legDirection';
import type { LineNumber, Route, Waypoint } from './types';

export type LegFilterVerdict =
  | { kind: 'pass' }
  | { kind: 'not-applicable' }
  | { kind: 'soft-penalty'; reason: string }
  | { kind: 'reject'; reason: string };

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

