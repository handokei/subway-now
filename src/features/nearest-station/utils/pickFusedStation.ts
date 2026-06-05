import type { NearestStationResult } from '../../../shared/types/station';
import type { StationArrival } from '../../../shared/types/arrival';
import type { LinePositions } from '../../../shared/types/position';
import type { FusionConfidence, FusionSource } from '../../../shared/types/fusion';
import { getArrivalPriority } from '../../../shared/constants/arrivalCodes';
import { getTrainStatusPriority } from '../../../shared/constants/trainStatus';

// FusionConfidence/FusionSource는 shared/types/fusion으로 추출됨 (#890, Phase 5).
// 기존 호출자 호환을 위해 re-export 유지.
export type { FusionConfidence, FusionSource };

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
