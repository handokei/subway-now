import type { Route } from '../../../shared/utils/stationRoute';
import type { LineNumber } from '../../../shared/types/station';

/**
 * 현재 BoardingLock leg의 끝 역(다음 환승역 또는 최종 도착역) 이름을 결정한다.
 * - direct: 도착역
 * - transfer: boardingLine == fromLine이면 transferName, toLine이면 도착역
 * - multi-transfer: transfers 배열에서 boardingLine==fromLine인 segment의 transferName.
 *   마지막 segment의 toLine이면 도착역.
 * 매칭 실패 시 null (lock 노선이 route segment 어느 것에도 일치 안 함 — 비정상).
 */
export function findSegmentEndStationName(
  route: NonNullable<Route>,
  boardingLine: LineNumber,
  destinationName: string,
): string | null {
  if (route.type === 'direct') return destinationName;
  if (route.type === 'transfer') {
    if (boardingLine === route.fromLine) return route.transferName;
    if (boardingLine === route.toLine) return destinationName;
    return null;
  }
  // multi-transfer
  for (const t of route.transfers) {
    if (t.fromLine === boardingLine) return t.transferName;
  }
  const last = route.transfers[route.transfers.length - 1];
  if (last && last.toLine === boardingLine) return destinationName;
  return null;
}
