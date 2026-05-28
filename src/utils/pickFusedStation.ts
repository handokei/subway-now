import type { NearestStationResult } from '../types/station';
import type { StationArrival } from '../api/arrivalApi';
import type { LinePositions } from '../api/positionApi';
import { getArrivalPriority } from '../constants/arrivalCodes';
import { getTrainStatusPriority } from '../constants/trainStatus';

/**
 * fusion 결과 신뢰도 — UI/로깅용. 점수 ≥ 100이면 confirmed, 0 < x < 100이면 arriving.
 * 신호원(arrival/position/route-progress)은 source 필드로 분리 식별.
 * 'route-progress'는 1D map matching 진행도 기반(Phase A) — GPS 점프에 면역이지만
 * 도착/위치 API와 달리 자체 검증 신호가 아니라 별도 confidence로 둔다.
 */
export type FusionConfidence =
  | 'boarding-lock'
  | 'position-train'
  | 'arrival-confirmed'
  | 'arrival-arriving'
  | 'route-progress'
  | 'gps-only';

/**
 * fusion 신호 출처. position-train이 가장 정확(특정 trainNo 추적 → 현재역),
 * position은 station 단위 trainSttus 직접 매칭, arrival은 추정(곧 도착),
 * route-progress는 트랙 1D 진행도, gps는 거리 기반.
 * 알람 dedup·로깅에서 source별 정책 분기에 사용.
 */
export type FusionSource =
  | 'boarding-lock'
  | 'position-train'
  | 'position'
  | 'arrival'
  | 'route-progress'
  | 'gps';

export interface FusedStationResult {
  result: NearestStationResult;
  confidence: FusionConfidence;
  source: FusionSource;
}

export interface FusionCandidate {
  candidate: NearestStationResult;
  /** 도착정보 신호 (Phase 2). null이면 신호 없음. */
  arrival?: StationArrival | null;
  /**
   * 위치정보 신호 (Phase 3). 후보 역의 호선에 해당하는 LinePositions 중
   * 후보 역(statnId)에 머무는 열차들. 호출자가 후보별로 매칭해 전달한다.
   * null이면 신호 없음(미호출/실패/mock).
   */
  positionMatches?: LinePositions['trains'] | null;
}

/** mock/stale 무시 + arvlCd 우선순위 최댓값. */
function bestPriorityForArrival(arrival: StationArrival | null | undefined): number {
  if (!arrival || arrival.isMock) return 0;
  let best = 0;
  for (const list of [arrival.up, arrival.down]) {
    for (const info of list) {
      if (info.receivedAtMs <= 0) continue;
      const p = getArrivalPriority(info.arrivalCode);
      if (p > best) best = p;
    }
  }
  return best;
}

/** stale(receivedAtMs<=0) 무시 + trainSttus 우선순위 최댓값. */
function bestPriorityForPosition(
  trains: LinePositions['trains'] | null | undefined,
): number {
  if (!trains || trains.length === 0) return 0;
  let best = 0;
  for (const t of trains) {
    if (t.receivedAtMs <= 0) continue;
    const p = getTrainStatusPriority(t.trainStatus);
    if (p > best) best = p;
  }
  return best;
}

/**
 * priority > 0 케이스만 호출됨 — gps-only(=priority 0)는 호출자가 early-return으로 처리.
 * 100점 이상은 ARRIVED(도착 확정) 신호, 그외는 진입/전역 신호로 분류.
 */
function confidenceFromPriority(priority: number): FusionConfidence {
  return priority >= 100 ? 'arrival-confirmed' : 'arrival-arriving';
}

/**
 * 후보 역들의 신호(arrival + position)로 fusion한 현재역을 결정한다.
 *
 * 입력 계약: candidates는 거리 오름차순 — `[0]`이 GPS 최근접.
 *
 * 규칙:
 * 1) 각 후보의 점수 = max(arrival 점수, position 점수). 두 신호원이 같은 priority enum 사용.
 * 2) 점수 최댓값 후보 선택. 동점이면 거리 가까운(=먼저 들어온) 후보 유지.
 * 3) source 분류: position 점수 > 0 우선(가장 정확) > arrival 점수 > 0 > GPS.
 *    같은 점수라도 신호원이 다르면 정확도 순(position > arrival)으로 source 라벨 결정.
 * 4) 모두 0이면 GPS 최근접 사용.
 * 5) 후보가 비어있으면 null.
 */
export function pickFusedStation(
  candidates: FusionCandidate[],
): FusedStationResult | null {
  if (candidates.length === 0) return null;

  let winnerIdx = 0;
  let winnerPriority = -1;
  let winnerArrScore = 0;
  let winnerPosScore = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const arrScore = bestPriorityForArrival(c.arrival);
    const posScore = bestPriorityForPosition(c.positionMatches);
    const p = Math.max(arrScore, posScore);
    if (p > winnerPriority) {
      winnerIdx = i;
      winnerPriority = p;
      winnerArrScore = arrScore;
      winnerPosScore = posScore;
    }
  }

  if (winnerPriority <= 0) {
    return {
      result: candidates[0].candidate,
      confidence: 'gps-only',
      source: 'gps',
    };
  }

  // source 라벨은 winning priority에 실제로 기여한 신호원.
  // 두 신호원이 같은 점수로 동점이면 정확도 우선(position) — UI/로깅에서 더 신뢰 표시.
  const source: FusionSource =
    winnerPosScore >= winnerArrScore ? 'position' : 'arrival';

  return {
    result: candidates[winnerIdx].candidate,
    confidence: confidenceFromPriority(winnerPriority),
    source,
  };
}
