/**
 * #1421 — PR-AutoLock-1 측정 인프라.
 *
 * SSOT consensus가 잡은 trainCode의 종착(다음 진행) 방향이 사용자 route의 destination 쪽과
 * 일치하는지 검증한다. false-positive auto-lock 2차 게이트 — 같은 역 반대 방향 열차를 lock
 * 잡지 않게 차단.
 *
 * 판정 로직:
 *   1) routeStations 비공/`trainTerminalStationName` null이면 미충족.
 *   2) currentIdx == destinationIdx (이미 도착) → 진행 방향 의미 없어 matched=true (at-destination).
 *   3) terminal이 routeStations에 없으면 미충족 (terminal-out-of-route).
 *   4) destinationIdx > currentIdx: terminalIdx >= currentIdx → forward. 작으면 reverse.
 *      destinationIdx < currentIdx: terminalIdx <= currentIdx → forward. 크면 reverse.
 *
 * pure: React/네트워크 의존 없음. 호출자가 SSOT 산출과 route store 컨텍스트를 인자로 전달.
 */

import type { Station } from '../../../shared/types/station';

export type VerifyTrainDirectionReason =
  | 'forward'
  | 'reverse'
  | 'at-destination'
  | 'terminal-out-of-route'
  | 'no-route'
  | 'no-terminal';

export interface VerifyTrainDirectionInput {
  /** 탑승 → 목적지 순서로 정렬된 route arc 전체. */
  routeStations: readonly Station[];
  /** 현재 위치의 routeStations 인덱스 (SSOT 합의 결과 station 기준). */
  currentIdx: number;
  /** route 도착역의 routeStations 인덱스. */
  destinationIdx: number;
  /**
   * 합의된 trainCode의 종착역 이름. 다음역 자체보다 종착이 방향 검증에 단조롭다 — 한 번 잘못
   * 시작한 trip 회복 시 다음역만 보면 같은 역이 매번 잡혀도 종착 비교는 안정적.
   */
  trainTerminalStationName: string | null;
}

export interface VerifyTrainDirectionResult {
  matched: boolean;
  reason: VerifyTrainDirectionReason;
}

function isForwardOnRoute(
  routeStations: readonly Station[],
  currentIdx: number,
  destinationIdx: number,
  terminalIdx: number,
): boolean {
  // destinationIdx > currentIdx → route는 인덱스 증가 방향. terminal이 currentIdx 이상이면 forward.
  if (destinationIdx > currentIdx) return terminalIdx >= currentIdx;
  // destinationIdx < currentIdx → route는 인덱스 감소 방향. terminal이 currentIdx 이하면 forward.
  /* istanbul ignore next -- destinationIdx === currentIdx는 호출 전 'at-destination'로 분기,
     >= 미만 케이스 두 분기는 위 두 if로 망라. 안전을 위한 false fallback. */
  return terminalIdx <= currentIdx;
}

export function verifyTrainDirection(
  input: VerifyTrainDirectionInput,
): VerifyTrainDirectionResult {
  const { routeStations, currentIdx, destinationIdx, trainTerminalStationName } = input;
  if (routeStations.length === 0) return { matched: false, reason: 'no-route' };
  if (trainTerminalStationName === null) return { matched: false, reason: 'no-terminal' };
  if (currentIdx === destinationIdx) return { matched: true, reason: 'at-destination' };

  const terminalIdx = routeStations.findIndex((s) => s.name === trainTerminalStationName);
  if (terminalIdx === -1) return { matched: false, reason: 'terminal-out-of-route' };

  const forward = isForwardOnRoute(routeStations, currentIdx, destinationIdx, terminalIdx);
  return forward
    ? { matched: true, reason: 'forward' }
    : { matched: false, reason: 'reverse' };
}
