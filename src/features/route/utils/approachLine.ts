import type { Route } from '../../../shared/utils/stationRoute';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { LineNumber, Station } from '../../../shared/types/station';

/**
 * #797: 현재 사용자가 탑승 중(또는 탑승 예정)인 노선을 trip route + BoardingLock SSOT로 결정한다.
 *
 * 회귀(2026-06-03 실기기): 환승역에서 useFusedNearestStation이 같은 이름·다른 노선 station 중
 * 임의로 하나를 골라 `currentStation.line`이 trip 방향과 어긋났다(예: 천호 8호선 trip인데 5호선
 * station 매칭 → BoardingTrainList가 5호선 arrivals 노출).
 *
 * 우선순위:
 *   1. **BoardingLock 존재** → `boardingLock.boardingLine` (사용자가 명시 선택한 leg, 가장 강한 신호)
 *   2. **Route + segment 진행도** → 다음 환승 전이면 fromLine, 환승 도착(stopsToTransfer===0)이면 toLine
 *   3. **fallback** → `currentStation?.line ?? null`
 *
 * stopsToTransfer===0의 의미 모호성(환승역 정확 도착 vs 환승 완료)은 BoardingLock이 있으면 1번에서
 * 해소된다. lock 없는 케이스는 "transferring or transferred"로 추정 → toLine 안내가 더 유용
 * (사용자가 다음 leg arrivals를 봐야 함).
 */
export function getApproachLine(
  route: Route,
  boardingLock: BoardingLock | null,
  currentStation: Station | null,
): LineNumber | null {
  if (boardingLock) return boardingLock.boardingLine;

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

  return currentStation?.line ?? null;
}
