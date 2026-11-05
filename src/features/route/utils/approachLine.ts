import { type Route } from '../../../shared/utils/stationRoute';
import { resolveConsistentStationLine } from '../../../shared/utils/stationLookup';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { LineNumber, NearestStationResult, Station } from '../../../shared/types/station';

/**
 * #797: 현재 사용자가 탑승 중(또는 탑승 예정)인 노선을 trip route + BoardingLock SSOT로 결정한다.
 *
 * 회귀(2026-06-03 실기기): 환승역에서 useFusedNearestStation이 같은 이름·다른 노선 station 중
 * 임의로 하나를 골라 `currentStation.line`이 trip 방향과 어긋났다(예: 천호 8호선 trip인데 5호선
 * station 매칭 → BoardingTrainList가 5호선 arrivals 노출).
 *
 * 우선순위:
 *   1. **BoardingLock 존재** → `boardingLock.boardingLine` (사용자가 명시 선택한 leg, 가장 강한 신호)
 *   2. **legAdvance stamp** → 사용자가 환승역 하차 응답/버튼으로 명시 확인한 다음 leg 노선
 *      (#2278). lock은 해제 직후 null이 되지만 route의 `stopsToTransfer` 진행도는 backend SSoT
 *      갱신 지연으로 즉시 따라오지 못한다(RCA 가설 1 확정) — 그 gap을 메우는 로컬 ground truth.
 *   3. **Route + segment 진행도** → 다음 환승 전이면 fromLine, 환승 도착(stopsToTransfer===0)이면 toLine
 *   4. **fallback** → `currentStation?.line ?? null`
 *
 * stopsToTransfer===0의 의미 모호성(환승역 정확 도착 vs 환승 완료)은 BoardingLock이 있으면 1번에서
 * 해소된다. lock 없는 케이스는 "transferring or transferred"로 추정 → toLine 안내가 더 유용
 * (사용자가 다음 leg arrivals를 봐야 함).
 *
 * #1325 방어 가드: route/lock에서 산출한 line이 currentStation이 실제 정차하는 노선이 아니면
 * (잘못 탑승 / route 데시싱크로 다른 leg line이 샘) 현재역 라벨로 쓰지 않고 currentStation.line으로
 * fallback한다. upstream fusion(#1317)을 고치기 전에도 혼동 라벨을 차단하는 독립 가드.
 */
export interface ApproachLineResult {
  line: LineNumber | null;
  /**
   * #2209 (ADR-027 Decision 1) — true면 route/lock에서 산출된 확정값(위 우선순위 1·2번).
   * false면 route/lock 후보가 없어 `currentStation?.line`(fusion 임의 선택, #797)로만 떨어진
   * 상태 — boarding 후보 line 필터에 사용하면 정답 line을 통째로 지울 수 있어 미확정으로 취급한다.
   */
  confirmed: boolean;
}

/**
 * #2209 (ADR-027 Decision 1) — line 필터 안전성을 위해 확정 여부를 함께 반환하는 버전.
 * `getApproachLine`은 이 함수의 `.line`만 취하는 하위호환 wrapper.
 */
export function getApproachLineWithConfirmation(
  route: Route,
  boardingLock: BoardingLock | null,
  currentStation: Station | null,
  /**
   * #2278 — 사용자가 환승역 하차 응답/버튼으로 명시 확인한 다음 leg 노선.
   * `useLegAdvanceStore`가 SSoT. lock=null이고 route 진행도가 아직 못 따라온 구간을
   * 로컬에서 즉시 메운다. 미전달(undefined) 또는 null이면 기존 동작(우선순위 3~4) 그대로.
   */
  legAdvanceLine?: LineNumber | null,
): ApproachLineResult {
  const candidate = resolveCandidateLine(route, boardingLock, legAdvanceLine ?? null);
  const confirmed = candidate !== null;

  if (candidate && currentStation) {
    // #1325 → ADR-038 Phase 1 (#2575): 역↔노선 정합 단일 SSoT. candidate를 currentStation이
    // 실제 서비스하면 채택, 아니면 그 station의 실제 노선(currentStation.line)으로 교정.
    const line = resolveConsistentStationLine(currentStation.name, candidate, currentStation.line);
    return { line, confirmed };
  }

  return { line: candidate ?? currentStation?.line ?? null, confirmed };
}

export function getApproachLine(
  route: Route,
  boardingLock: BoardingLock | null,
  currentStation: Station | null,
  legAdvanceLine?: LineNumber | null,
): LineNumber | null {
  return getApproachLineWithConfirmation(route, boardingLock, currentStation, legAdvanceLine).line;
}

/** route + BoardingLock SSOT로 우선순위에 따라 노선을 산출한다 (검증 전 raw 후보). */
function resolveCandidateLine(
  route: Route,
  boardingLock: BoardingLock | null,
  legAdvanceLine: LineNumber | null,
): LineNumber | null {
  if (boardingLock) return boardingLock.boardingLine;
  if (legAdvanceLine) return legAdvanceLine;

  if (route) {
    if (route.type === 'direct') return route.line;

    if (route.type === 'transfer') {
      return route.stopsToTransfer > 0 ? route.fromLine : route.toLine;
    }

    // route.type === 'multi-transfer' — 위 두 분기로 exhaustive 좁혀짐.
    for (const t of route.transfers) {
      if (t.stopsToTransfer > 0) return t.fromLine;
    }
    const last = route.transfers[route.transfers.length - 1];
    if (last) return last.toLine;
  }

  return null;
}

/**
 * #2590 (code review 2/3번) — backend SSoT mirror 채택 전 cross-line 가드. `useFusedNearestStation`
 * (FG cascade picker, ADR-010/#2307/#2387)이 원래 구현한 두 단계 판정을 순수 추출해
 * `useTransferTrainList`(환승 컨텍스트)와 공유한다 — 동작/타이밍/조건 100% 동일(pure extraction).
 *
 * 판정 순서 (하나라도 해당하면 거부):
 *   1. `positionTrainResult`(device GPS 확정 live 신호, distance/arc/forward 게이트 통과)가 있고
 *      resolved line과 다르면 거부. positionTrainResult가 없으면(GPS 열화/미배선) 이 단계는
 *      판정하지 않고 통과 — 이는 완화가 아니라 원 설계 자체가 "더 강한 신호가 있을 때만 대조"이기
 *      때문(#2307). GPS를 판정 근거로 쓰지 않는 orchestrator(`useTransferTrainList`)는 항상
 *      positionTrainResult=null을 넘기므로 이 단계가 자연히 no-op이 된다 — FG와 동일 함수·동일
 *      의미론을 공유하는 것이지 별도의 완화된 경로가 아니다.
 *   2. 사용자가 명시 확인한 line(BoardingLock 또는 legAdvance stamp, `getApproachLineWithConfirmation`
 *      `confirmed`)과 다르면 거부(#2387). route는 의도적으로 전달하지 않는다 — bare route
 *      progression(계획값)은 사용자 확인이 아니라 positionTrainResult급 신뢰도가 아니다.
 */
export function evaluateBackendSsotCrossLineGuard(
  resolvedLine: LineNumber,
  positionTrainResult: Pick<NearestStationResult, 'station'> | null,
  boardingLock: BoardingLock | null,
  legAdvanceLine: LineNumber | null,
): boolean {
  if (positionTrainResult && resolvedLine !== positionTrainResult.station.line) {
    return true;
  }
  const approach = getApproachLineWithConfirmation(null, boardingLock, null, legAdvanceLine);
  if (approach.confirmed && resolvedLine !== approach.line) {
    return true;
  }
  return false;
}
