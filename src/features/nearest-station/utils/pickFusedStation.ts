import type { NearestStationResult } from '../../../shared/types/station';
import type { StationArrival } from '../../../shared/types/arrival';
import type { LinePositions } from '../../../shared/types/position';
import type { FusionConfidence, FusionSource } from '../../../shared/types/fusion';
import { getArrivalPriority } from '../../../shared/constants/arrivalCodes';
import { getTrainStatusPriority } from '../../../shared/constants/trainStatus';
import { createLogger } from '../../../shared/utils/logger';
import { getTierRank, tierFor } from './fusionTierPriority';

const logger = createLogger('pickFusedStation');

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

/**
 * R-10 §4.3 tie-break: 점수 동률 시 `freshness_ts`(receivedAtMs) 비교가 필요해
 * 점수와 함께 그 점수를 만든 신호의 receivedAtMs를 반환한다.
 *
 * - `score`: 신호의 priority 최댓값. 신호 없음 = 0.
 * - `freshness`: `score`에 기여한 가장 신선한 신호의 receivedAtMs. score=0이면 0.
 */
interface SignalScore {
  score: number;
  freshness: number;
}

const NO_SIGNAL: SignalScore = { score: 0, freshness: 0 };

/** mock/stale 무시 + arvlCd 우선순위 최댓값 + 최댓값 기여 신호의 receivedAtMs. */
function bestPriorityForArrival(arrival: StationArrival | null | undefined): SignalScore {
  if (!arrival || arrival.isMock) return NO_SIGNAL;
  let score = 0;
  let freshness = 0;
  for (const list of [arrival.up, arrival.down]) {
    for (const info of list) {
      if (info.receivedAtMs <= 0) continue;
      const p = getArrivalPriority(info.arrivalCode);
      if (p > score) {
        score = p;
        freshness = info.receivedAtMs;
      } else if (p === score && info.receivedAtMs > freshness) {
        freshness = info.receivedAtMs;
      }
    }
  }
  return { score, freshness };
}

/** stale(receivedAtMs<=0) 무시 + trainSttus 우선순위 최댓값 + 최댓값 기여 신호의 receivedAtMs. */
function bestPriorityForPosition(
  trains: LinePositions['trains'] | null | undefined,
): SignalScore {
  if (!trains || trains.length === 0) return NO_SIGNAL;
  let score = 0;
  let freshness = 0;
  for (const t of trains) {
    if (t.receivedAtMs <= 0) continue;
    const p = getTrainStatusPriority(t.trainStatus);
    if (p > score) {
      score = p;
      freshness = t.receivedAtMs;
    } else if (p === score && t.receivedAtMs > freshness) {
      freshness = t.receivedAtMs;
    }
  }
  return { score, freshness };
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
 * 2) 점수 최댓값 후보 선택.
 *    - R-10 §4.3 (#1169): 점수 동률 시 `freshness_ts` 비교 — 더 최근 신호를 가진 후보 우선.
 *    - freshness도 동률이면 거리 가까운(=먼저 들어온) 후보 유지.
 * 3) source 분류: position 점수 > 0 우선(가장 정확) > arrival 점수 > 0 > GPS.
 *    같은 점수라도 신호원이 다르면 정확도 순(position > arrival)으로 source 라벨 결정.
 *    - R-10 §4.3 (#1169): 같은 score + 같은 tier 후보일 때, freshness가 더 큰 신호원의 라벨을 부여.
 * 4) 모두 0이면 GPS 최근접 사용.
 * 5) 후보가 비어있으면 null.
 *
 * R-10 §4.3에서 명시한 `lock 활성 + tier mismatch → 1단계 강등`은 호출자(`useFusedNearestStation`,
 * 향후 `decideFusionResult`)에서 처리한다 — pickFusedStation은 lock 컨텍스트를 받지 않음.
 */
export function pickFusedStation(
  candidates: FusionCandidate[],
): FusedStationResult | null {
  if (candidates.length === 0) return null;

  let winnerIdx = 0;
  let winnerPriority = -1;
  let winnerArr: SignalScore = NO_SIGNAL;
  let winnerPos: SignalScore = NO_SIGNAL;
  let winnerFreshness = 0;
  let candidateTieBreaks = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const arr = bestPriorityForArrival(c.arrival);
    const pos = bestPriorityForPosition(c.positionMatches);
    const p = Math.max(arr.score, pos.score);
    // 이 후보의 freshness_ts = winning score에 기여한 가장 신선한 신호의 receivedAtMs.
    const candidateFreshness = freshnessOfWinningScore(p, arr, pos);
    if (p > winnerPriority) {
      winnerIdx = i;
      winnerPriority = p;
      winnerArr = arr;
      winnerPos = pos;
      winnerFreshness = candidateFreshness;
    } else if (p === winnerPriority && p > 0 && candidateFreshness > winnerFreshness) {
      // R-10 §4.3: 점수 동률 + 더 최근 신호 → tie-break로 교체.
      candidateTieBreaks++;
      winnerIdx = i;
      winnerArr = arr;
      winnerPos = pos;
      winnerFreshness = candidateFreshness;
    }
  }

  if (winnerPriority <= 0) {
    const fallback: FusedStationResult = {
      result: candidates[0].candidate,
      confidence: 'gps-only',
      source: 'gps',
    };
    logger.debug('decided', {
      tier: tierFor(fallback.source, fallback.confidence),
      source: fallback.source,
      confidence: fallback.confidence,
      candidates: candidates.length,
    });
    return fallback;
  }

  // R-10 (#1168): source 라벨을 explicit FUSION_TIER_PRIORITY로 결정.
  // R-10 §4.3 (#1169): 점수 동률 + tier 동률 시 freshness_ts 비교로 라벨 확정.
  const confidence = confidenceFromPriority(winnerPriority);
  const sourcePick = pickHigherTrustSource(winnerPos, winnerArr, confidence);

  const decided: FusedStationResult = {
    result: candidates[winnerIdx].candidate,
    confidence,
    source: sourcePick.source,
  };
  logger.debug('decided', {
    tier: tierFor(decided.source, decided.confidence),
    source: decided.source,
    confidence: decided.confidence,
    posScore: winnerPos.score,
    arrScore: winnerArr.score,
    candidates: candidates.length,
    // R-10 §4.3 telemetry — tie 발생 빈도 추적용 (이슈 #1169 acceptance).
    candidateTieBreaks,
    sourceTieBreakBy: sourcePick.tieBreakBy,
  });
  return decided;
}

/**
 * 후보의 freshness_ts = winning score(=max(arr, pos))에 기여한 신호 중 더 신선한 receivedAtMs.
 *
 * - 한쪽만 winning score 도달 → 그 쪽 freshness.
 * - 양쪽 동률(둘 다 winning score 도달) → 더 큰 freshness.
 * - winning score = 0 (신호 없음) → 0.
 */
function freshnessOfWinningScore(winning: number, arr: SignalScore, pos: SignalScore): number {
  if (winning <= 0) return 0;
  const arrContrib = arr.score === winning ? arr.freshness : 0;
  const posContrib = pos.score === winning ? pos.freshness : 0;
  return Math.max(arrContrib, posContrib);
}

interface SourcePick {
  source: FusionSource;
  /** telemetry: 어느 규칙으로 source 라벨이 정해졌는가. */
  tieBreakBy: 'score' | 'freshness' | 'tier';
}

/**
 * winning priority에 기여한 신호원 중 더 신뢰되는 source를 결정한다.
 *
 * 규칙 (R-10 §4.3):
 * 1) 한쪽 score가 더 크면 그쪽 — `tieBreakBy='score'`.
 * 2) score 동률 + freshness 차이 → 더 최근 신호의 source — `tieBreakBy='freshness'`.
 * 3) score + freshness 모두 동률 → `FUSION_TIER_PRIORITY` 표 순서로 결정 — `tieBreakBy='tier'`.
 *    현 표에서는 position tier가 arrival tier보다 상위라 'position' 우선(기존 동작과 동치).
 */
function pickHigherTrustSource(
  pos: SignalScore,
  arr: SignalScore,
  confidence: FusionConfidence,
): SourcePick {
  if (pos.score > arr.score) return { source: 'position', tieBreakBy: 'score' };
  if (arr.score > pos.score) return { source: 'arrival', tieBreakBy: 'score' };
  // score 동률 — freshness_ts 비교 (R-10 §4.3 lexicographic).
  if (pos.freshness > arr.freshness) return { source: 'position', tieBreakBy: 'freshness' };
  if (arr.freshness > pos.freshness) return { source: 'arrival', tieBreakBy: 'freshness' };
  // freshness도 동률 — tier 표로 결정 (결정론 보장).
  const posRank = getTierRank(tierFor('position', confidence));
  const arrRank = getTierRank(tierFor('arrival', confidence));
  // istanbul ignore next — 현 표에서는 posRank < arrRank 보장. 표 재배열 대비 방어 분기.
  return { source: posRank <= arrRank ? 'position' : 'arrival', tieBreakBy: 'tier' };
}
