import {
  findStationByNameAndLine,
  getStationById,
  type Route,
  type TransferSegment,
} from '../../../shared/utils/stationRoute';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { LineNumber, Station } from '../../../shared/types/station';

/**
 * #2412 — 경로 표시 origin을 trip 시작역(tripOrigin) 고정이 아니라 **현재 leg의 시작역**으로
 * re-origin한다. 환승 전엔 tripOrigin 그대로, 환승 후엔 그 leg가 시작된 환승역으로 앵커링해
 * "용마산 → 뚝섬"이 아니라 "건대 → 뚝섬"으로 표시되게 한다.
 *
 * 새 leg 감지 신호 신설 금지(#2412) — `getApproachLine`(approachLine.ts)과 동일한 3단
 * 우선순위로 **기존 신호만** 재사용한다:
 *   1. BoardingLock 존재 → `boardingLock.boardingStationId` (새 leg lock, 가장 강한 신호)
 *   2. legAdvance stamp(#2278) → 사용자가 환승역 하차 응답으로 확인한 다음 leg의 line에
 *      대응하는 route transfer 구간의 환승역
 *   3. Route + segment 진행도(`stopsToTransfer===0`) → 이미 통과한 마지막 환승역
 *   4. 위 셋 다 없으면 tripOrigin 그대로(caller가 넘긴 값을 그대로 반환)
 *
 * 반환값이 tripOrigin과 다른 Station이면 그 leg는 "환승 후" — buildJourneyDisplay가 그 station을
 * `current`로 받아 첫 세그먼트 fromName===toName(0-hop)이 되고, journeyDisplayToStops의
 * isCollapsedZeroFirstHop(#665)이 자동으로 "환승역 → 목적지"로 접어준다.
 */
export function resolveJourneyOriginStation(
  route: Route,
  boardingLock: BoardingLock | null,
  tripOrigin: Station | null,
  legAdvanceLine?: LineNumber | null,
): Station | null {
  if (boardingLock) {
    const locked = getStationById(boardingLock.boardingStationId);
    if (locked) return locked;
  }

  if (legAdvanceLine) {
    const advanced = findTransferStationForLine(route, legAdvanceLine);
    if (advanced) return advanced;
  }

  const progressed = findLastCompletedTransferStation(route);
  if (progressed) return progressed;

  return tripOrigin;
}

/** route 형태에 관계없이 환승 구간 목록으로 정규화한다(direct=빈 배열). */
function getTransferSegments(route: Route): TransferSegment[] {
  if (!route || route.type === 'direct') return [];
  if (route.type === 'transfer') {
    return [
      {
        transferName: route.transferName,
        fromLine: route.fromLine,
        toLine: route.toLine,
        stopsToTransfer: route.stopsToTransfer,
        secondsToTransfer: route.secondsToTransfer,
      },
    ];
  }
  return route.transfers;
}

/** legAdvanceLine(다음 leg 노선)에 해당하는 환승 구간을 찾아 그 환승역을 반환한다. */
function findTransferStationForLine(route: Route, line: LineNumber): Station | null {
  const segments = getTransferSegments(route);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].toLine === line) {
      return findStationByNameAndLine(segments[i].transferName, line) ?? null;
    }
  }
  return null;
}

/**
 * route의 실측 진행도(`stopsToTransfer===0`)로 이미 통과한 마지막 환승역을 찾는다.
 * updateRouteFromPosition이 통과한 구간부터 순서대로 0으로 갱신하므로 배열은
 * [0, 0, ..., 0, 진행중, 미도달...] 형태로 단조적이다 — 첫 non-zero에서 멈춘다.
 */
function findLastCompletedTransferStation(route: Route): Station | null {
  const segments = getTransferSegments(route);
  let last: TransferSegment | null = null;
  for (const segment of segments) {
    if (segment.stopsToTransfer > 0) break;
    last = segment;
  }
  if (!last) return null;
  return findStationByNameAndLine(last.transferName, last.toLine) ?? null;
}
