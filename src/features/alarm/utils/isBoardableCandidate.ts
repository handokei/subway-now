/**
 * #2696 — "탑승 가능 후보" 단일 불변식.
 *
 * 사용자가 "탑승했다"고 표명한 시점에 후보가 될 수 있는 열차는
 * `{방금 이 역을 출발한 열차} ∪ {지금 이 역에 있는 열차}` 뿐이다. 아직 오지 않은 열차,
 * 반대 방향 열차, 사용자의 다음 목표역 전에 종착하는 열차는 후보가 아니다.
 *
 * 이 불변식을 두 개의 독립 picker(`boardingPromptAutoLock.pickAutoTrainCodeFromArrivals`,
 * `usePrevTrainCandidate`)가 각자 다르게(그리고 각자 틀리게) 구현했던 것을 이 술어 하나로
 * 단일화한다 — 2026-09-16(7039 미도착 fallback)과 2026-09-17(8387 반대방향+조기종착) 두 사고가
 * 같은 불변식 위반이었다는 RCA 결론.
 *
 * 위치: alarm feature 내부 두 소비자(hooks/usePrevTrainCandidate.ts, utils/boardingPromptAutoLock.ts)
 * 전용이라 `features/alarm/utils/`에 둔다 — cross-feature가 아니므로 `import/no-restricted-paths`
 * eslint-disable 불필요.
 */

import { ARRIVAL_CODE } from '../../../shared/constants/arrivalCodes';
import { terminusReachesTarget } from '../../../shared/utils/stationRoute';
import type { ArrivalInfo } from '../../../shared/types/arrival';
import type { LineNumber } from '../../../shared/types/station';

/** 판정 4 — 상태 ∈ {출발2, 도착1, 진입0}만 후보. 그 외(99 운행중 등)는 "아직 오지 않은 열차". */
const BOARDABLE_ARRIVAL_CODES: ReadonlySet<number> = new Set([
  ARRIVAL_CODE.DEPARTED,
  ARRIVAL_CODE.ARRIVED,
  ARRIVAL_CODE.ENTERING,
]);

export interface BoardableCandidateContext {
  line: LineNumber;
  /**
   * 사용자 진행 방향. null이면 "미해결" — 이 경우 노선/종착 조건과 무관하게 후보가 0건이
   * 되어야 한다(#2696 위반② 재발 방지: 방향 미해결 시 양방향 병합 금지).
   */
  direction: 'up' | 'down' | null;
  /**
   * 사용자의 다음 목표역(출발역 바로 다음 정거장) 이름. null이면 조기 종착 판정을 건너뛴다
   * (판정 불가는 배제하지 않음 — 과다 필터링보다 미검출이 안전하다는 기존 관례).
   */
  nextTargetStationName: string | null;
}

/**
 * 판정 순서: 방향 미해결 → 즉시 false. 이후 노선 일치 / 상태 게이트 / 조기 종착 배제.
 *
 * `train`의 방향 자체는 이 함수가 직접 비교하지 않는다 — ArrivalInfo는 Seoul Open API의
 * up/down bucket으로 이미 분리되어 있고(방향 정보를 필드로 갖지 않음), caller가 그 bucket
 * (`arrival.up`/`arrival.down`)을 `context.direction`에 맞춰 선택해 넘긴다. `context.direction`이
 * null이면 caller가 어느 bucket도 아닌(또는 둘 다 병합한) 애매한 입력을 넘겼다는 뜻이므로
 * 이 함수가 방어적으로 전체 후보를 무효화한다 — 위반②(양방향 병합)의 근본 차단선.
 */
export function isBoardableCandidate(
  train: ArrivalInfo,
  context: BoardableCandidateContext,
): boolean {
  if (context.direction === null) return false;
  if (train.line !== context.line) return false;
  if (!BOARDABLE_ARRIVAL_CODES.has(train.arrivalCode)) return false;
  if (context.nextTargetStationName && train.terminalStation) {
    return terminusReachesTarget(
      context.line,
      context.direction,
      train.terminalStation,
      context.nextTargetStationName,
    );
  }
  return true;
}
