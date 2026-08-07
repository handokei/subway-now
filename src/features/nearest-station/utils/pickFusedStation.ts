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
  /**
   * #2204 — 이번 cycle의 winning priority가 ARRIVED 임계(100) 이상이었던 station id.
   * `confidence`는 temporal consensus 결과(1회차 관측은 'arrival-arriving')라 원시 신호 판별에
   * 쓸 수 없다 — 호출자가 다음 cycle의 `prevHighPriorityStationId`로 그대로 전달해 이력을 추적한다.
   * priority<100(GPS-only 포함)이면 null.
   */
  highPriorityStationId: string | null;
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
 *
 * #2204 (ADR-026 ①잔여 적대적 검증 HOLE) — temporal consensus. 이전엔 단일 폴링에서
 * priority>=100(arvlCd=1/ARRIVED)만 관측되면 즉시 'arrival-confirmed'로 확정했다. 단일 폴링은
 * API/센서 순간 noise에 취약 — 최소 연속 2 cycle(직전 cycle에도 같은 station이 priority>=100)
 * 관측돼야 확정한다.
 *
 * `prevHighPriorityStationId` 미제공(undefined)이면 이력을 추적하지 않는 호출자(기존 단위 테스트
 * 등) — 기존 단일 폴링 즉시 확정 동작을 그대로 유지한다(backward compat, graceful).
 * `null`로 명시 전달되면(호출자가 이력 추적 중, 직전 cycle엔 확정 후보 없음) 첫 관측은 아직
 * 'arrival-arriving'만 반환 — 다음 cycle에 같은 station이 다시 priority>=100이면 확정된다.
 */
function confidenceFromPriority(
  priority: number,
  winnerStationId: string,
  prevHighPriorityStationId: string | null | undefined,
): FusionConfidence {
  if (priority < 100) return 'arrival-arriving';
  const consensusReached =
    prevHighPriorityStationId === undefined || prevHighPriorityStationId === winnerStationId;
  return consensusReached ? 'arrival-confirmed' : 'arrival-arriving';
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
 *
 * @param prevHighPriorityStationId #2204 — temporal consensus 추적용. 호출자가 직전 cycle
 *   결과의 `highPriorityStationId`를 그대로 넘기면 arrival-confirmed 확정에 연속 2 cycle 합의를
 *   요구한다. 미제공(undefined)이면 기존 단일 폴링 즉시 확정 동작 유지(backward compat).
 */
export function pickFusedStation(
  candidates: FusionCandidate[],
  prevHighPriorityStationId?: string | null,
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
    const fallback: FusedStationResult = {
      result: candidates[0].candidate,
      confidence: 'gps-only',
      source: 'gps',
      highPriorityStationId: null,
    };
    logger.debug('decided', {
      tier: tierFor(fallback.source, fallback.confidence),
      source: fallback.source,
      confidence: fallback.confidence,
      candidates: candidates.length,
    });
    return fallback;
  }

  const winnerStationId = candidates[winnerIdx].candidate.station.id;

  // R-10 (#1168): source 라벨을 explicit FUSION_TIER_PRIORITY로 결정.
  // 기존 `winnerPosScore >= winnerArrScore`와 동치(position이 arrival보다 상위 tier)지만,
  // SSOT를 단일 표(`fusionTierPriority.ts`)로 두어 신호 추가/재배열 시 호출 사이트 수정 불필요.
  const confidence = confidenceFromPriority(
    winnerPriority,
    winnerStationId,
    prevHighPriorityStationId,
  );
  const source = pickHigherTrustSource(winnerPosScore, winnerArrScore, confidence);

  const decided: FusedStationResult = {
    result: candidates[winnerIdx].candidate,
    confidence,
    source,
    highPriorityStationId: winnerPriority >= 100 ? winnerStationId : null,
  };
  logger.debug('decided', {
    tier: tierFor(decided.source, decided.confidence),
    source: decided.source,
    confidence: decided.confidence,
    posScore: winnerPosScore,
    arrScore: winnerArrScore,
    candidates: candidates.length,
  });
  return decided;
}

/**
 * winning priority에 기여한 신호원 중 더 신뢰되는 source를 tier 표 기준으로 고른다.
 *
 * - 한쪽만 winning score에 도달했다면 그 쪽으로 확정.
 * - 두 신호원이 같은 점수로 동률이면 `FUSION_TIER_PRIORITY` 표 순서로 결정 — position tier가
 *   arrival tier보다 상위라 position이 우선(기존 implicit `>=` 동작과 동치).
 */
function pickHigherTrustSource(
  posScore: number,
  arrScore: number,
  confidence: FusionConfidence,
): FusionSource {
  if (posScore > arrScore) return 'position';
  if (arrScore > posScore) return 'arrival';
  // 동점 — tier 표로 결정. position tier가 arrival tier보다 상위라 항상 'position'.
  // 표에서 두 tier가 역전되면 본 분기가 자연스럽게 따라간다(`getTierRank` lookup).
  const posRank = getTierRank(tierFor('position', confidence));
  const arrRank = getTierRank(tierFor('arrival', confidence));
  // istanbul ignore next — 현 표에서는 posRank < arrRank 보장. 표 재배열 대비 방어 분기.
  return posRank <= arrRank ? 'position' : 'arrival';
}
