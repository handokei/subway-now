/**
 * #819 B 슬라이스 — "탑승" 응답 시 arvlCd 우선순위로 trainCode 자동 lock.
 *
 * ADR Section 1.2 그대로 client-side에서 재현:
 *   1순위: arvlCd=2 (출발) — 사용자가 그 차 타고 출발
 *   2순위: arvlCd=1 (도착)
 *   3순위: arvlCd=0 (진입)
 *
 * 같은 우선순위 후보가 여러 개면 (ambiguity) → null 반환 — 클라가 자동 lock 안 하고 manual
 * fallback (사용자가 BoardingTrainList에서 직접 선택).
 *
 * #2696 — 이전 구현은 위 3개 tier 어디에도 안 걸리면(아직 오지 않은 열차 등) `arrivals[0]`
 * (가장 먼저 도착 예정, 즉 아직 안 온 열차)을 그대로 채택하는 4순위 fallback이 있었다. 이 fallback
 * 자체가 불변식 위반이었다(2026-09-16 7039 evidence) — 제거하고, `isBoardableCandidate` 술어로
 * 사전에 걸러진 후보 중에서만 우선순위를 적용한다. 후보가 0건이면 null — caller
 * (`useBoardingPromptResponder.tryAutoLock`)는 이미 chosen===null을 "train 미확정"으로 다뤄
 * `createPendingFallbackLock`(#2407)으로 이어간다 — lockless cascade로 이어지지 않는다.
 *
 * line/방향 매칭은 `isBoardableCandidate`가 `context`로 판정한다 — caller가 line/방향을 미리
 * 슬라이스해서 넣을 필요는 없어졌지만(방어적으로 다시 걸러도 무해), 기존 caller
 * (useBoardingLockController의 directionalArrivals 등)는 그대로 pre-filter된 값을 넘겨도 된다.
 */

import { ARRIVAL_CODE } from '../../../shared/constants/arrivalCodes';
import { isBoardableCandidate, type BoardableCandidateContext } from './isBoardableCandidate';
import type { ArrivalInfo } from '../../../shared/types/arrival';

export type { BoardableCandidateContext };

/**
 * 후보 리스트에서 `isBoardableCandidate`로 거른 뒤 arvlCd 우선순위로 1대를 고른다.
 *
 * 빈 입력, 술어 통과 후보 0건, 또는 ambiguity → null.
 * 결과 trainCode가 빈 문자열이면 null로 강등(빈 trainCode로 lock 만들면 backend tracking이 무용).
 *
 * @param arrivals - 후보 원본(line/방향 pre-filter 여부 무관 — 술어가 다시 판정한다).
 * @param context - line/direction/nextTargetStationName. direction===null이면 항상 null 반환.
 */
export function pickAutoTrainCodeFromArrivals(
  arrivals: readonly ArrivalInfo[],
  context: BoardableCandidateContext,
): ArrivalInfo | null {
  const candidates = arrivals.filter((a) => isBoardableCandidate(a, context));
  if (candidates.length === 0) return null;

  const priority: readonly number[] = [
    /* 2: 출발 — 사용자 그 차 타고 출발 */
    2,
    /* 1: 도착 */
    ARRIVAL_CODE.ARRIVED,
    /* 0: 진입 */
    ARRIVAL_CODE.ENTERING,
  ];
  for (const code of priority) {
    const tier = candidates.filter((a) => a.arrivalCode === code);
    if (tier.length === 1) {
      return tier[0].trainCode.length > 0 ? tier[0] : null;
    }
    if (tier.length > 1) {
      // ambiguity — 자동 lock 안 함, manual fallback.
      return null;
    }
  }
  /* istanbul ignore next -- isBoardableCandidate가 상태 ∈ {0,1,2}만 통과시키므로 candidates의
     arrivalCode는 반드시 priority 3개 tier 중 하나에 속한다 — 위 루프가 항상 return한다. */
  return null;
}
