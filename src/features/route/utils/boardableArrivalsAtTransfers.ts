import type { BoardableArrival, BoardableArrivalsAtTransfers } from '../../../shared/utils/stationRoute';

/**
 * #1480 PR-D — 활성 환승(`ActiveTransferContext.completedTransferIdx`)의 환승역 도착 목록을 엔진 입력으로 배치한다.
 *
 * arrivals는 useTransferTrainList가 이미 toLine·진행 방향(directionOnLine) bucket으로 거른 목록이다.
 * 엔진이 환승 순서(index)로 슬롯을 읽으므로 활성 환승 위치에만 채우고 앞 슬롯은 null. 환승 컨텍스트가 없으면
 * undefined(입력 없음 → 엔진이 시간표 → 배차간격/2). 신선도·T_platform 이후 선택은 stationRoute/엔진 소관.
 */
export function buildBoardableArrivalsAtTransfers(
  transferIdx: number | null,
  arrivals: ReadonlyArray<BoardableArrival>,
): BoardableArrivalsAtTransfers | undefined {
  if (transferIdx === null) return undefined;
  return Array.from({ length: transferIdx + 1 }, (_, i) => (i === transferIdx && arrivals.length > 0 ? arrivals : null));
}
