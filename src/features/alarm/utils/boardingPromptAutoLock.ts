/**
 * #819 B 슬라이스 — "탑승" 응답 시 arvlCd 우선순위로 trainCode 자동 lock.
 *
 * ADR Section 1.2 그대로 client-side에서 재현:
 *   1순위: arvlCd=2 (출발) — 사용자가 그 차 타고 출발
 *   2순위: arvlCd=1 (도착)
 *   3순위: arvlCd=0 (진입)
 *   4순위: 그 외 → 첫 후보 (Seoul API receivedAt 정렬)
 *
 * 같은 우선순위 후보가 여러 개면 (ambiguity) → null 반환 — 클라가 자동 lock 안 하고 manual
 * fallback (사용자가 BoardingTrainList에서 직접 선택).
 *
 * line/방향 매칭은 caller가 ArrivalInfo[]를 사전 필터해서 넣는 게 자연스럽다 (useBoardingLockController의
 * directionalArrivals와 동일 정책 — 거기서 이미 진행 방향 + 노선 매칭 + arrivalSeconds>0이 필터됨).
 */

import { ARRIVAL_CODE } from '../../../shared/constants/arrivalCodes';
import type { ArrivalInfo } from '../../../api/arrivalApi';

/**
 * 후보 리스트(이미 line/방향 필터 후)에서 arvlCd 우선순위로 1대를 고른다.
 *
 * 빈 입력 또는 ambiguity → null.
 * 결과 trainCode가 빈 문자열이면 null로 강등(빈 trainCode로 lock 만들면 backend tracking이 무용).
 */
export function pickAutoTrainCodeFromArrivals(
  arrivals: readonly ArrivalInfo[],
): ArrivalInfo | null {
  if (arrivals.length === 0) return null;
  const priority: readonly number[] = [
    /* 2: 출발 — 사용자 그 차 타고 출발 */
    2,
    /* 1: 도착 */
    ARRIVAL_CODE.ARRIVED,
    /* 0: 진입 */
    ARRIVAL_CODE.ENTERING,
  ];
  for (const code of priority) {
    const tier = arrivals.filter((a) => a.arrivalCode === code);
    if (tier.length === 1) {
      return tier[0].trainCode.length > 0 ? tier[0] : null;
    }
    if (tier.length > 1) {
      // ambiguity — 자동 lock 안 함, manual fallback.
      return null;
    }
  }
  // 그 외 코드 fallback — 첫 후보. backend와 client의 receivedAt 정렬은 동일하다고 가정.
  const fallback = arrivals[0];
  return fallback.trainCode.length > 0 ? fallback : null;
}
