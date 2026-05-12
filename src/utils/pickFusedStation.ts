import type { NearestStationResult } from '../types/station';
import type { StationArrival } from '../api/arrivalApi';
import { getArrivalPriority } from '../constants/arrivalCodes';

/**
 * fusion 결과 신뢰도 — UI/로깅용. arrival 신호로 확정/추정된 경우 GPS-only보다 신선.
 */
export type FusionConfidence = 'arrival-confirmed' | 'arrival-arriving' | 'gps-only';

export interface FusedStationResult {
  result: NearestStationResult;
  confidence: FusionConfidence;
  source: 'arrival' | 'gps';
}

interface CandidateArrival {
  candidate: NearestStationResult;
  arrival: StationArrival | null;
}

/**
 * recptnDt 보정 거친 신호 중 가장 강한 priority 점수를 반환.
 * mock/누락(receivedAtMs=0) 신호는 무시 — Stage 1에서 stale로 강등됨.
 */
function bestPriorityForArrival(arrival: StationArrival | null): number {
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

function confidenceFromPriority(priority: number): FusionConfidence {
  if (priority >= 100) return 'arrival-confirmed'; // arvlCd=1 도착
  if (priority > 0) return 'arrival-arriving';
  return 'gps-only';
}

/**
 * 후보 역들의 arrival 신호로 fusion한 현재역을 결정한다.
 *
 * 입력 계약: candidates는 거리 오름차순 — `[0]`이 GPS 최근접이어야 함.
 *  (동점 시 거리 가까운 쪽이 자동 선택되도록 순회 순서로 invariant 유지)
 *
 * 규칙:
 * 1) priority 점수 최댓값을 가진 후보 선택 (arvlCd 1 > 0 > 5 > 4)
 * 2) 동점이면 더 먼저 들어온(=거리 가까운) 후보 유지
 * 3) 모두 0이면 GPS 최근접(=candidates[0]) 사용
 * 4) 후보가 비어있으면 null 반환 — 호출자가 GPS-only 분기로 fallback
 */
export function pickFusedStation(
  candidates: CandidateArrival[],
): FusedStationResult | null {
  if (candidates.length === 0) return null;

  let winner = candidates[0];
  let winnerPriority = bestPriorityForArrival(winner.arrival);

  for (let i = 1; i < candidates.length; i++) {
    const p = bestPriorityForArrival(candidates[i].arrival);
    if (p > winnerPriority) {
      winner = candidates[i];
      winnerPriority = p;
    }
  }

  const source = winnerPriority > 0 ? 'arrival' : 'gps';
  // arrival 신호가 없으면 GPS 최근접(=candidates[0])이 정답.
  const finalResult = source === 'arrival' ? winner.candidate : candidates[0].candidate;

  return {
    result: finalResult,
    confidence: confidenceFromPriority(winnerPriority),
    source,
  };
}
