/**
 * Route → transfer leg 평탄화 (#899 Seam C).
 *
 * `useBoardingLockAutoRelease`가 환승 waypoint 자동 release 분기에서 사용한다.
 * Route 타입(direct/transfer/multi-transfer) 분기 대신 호출처는 단일 배열 순회로
 * lock.boardingLine과 매칭되는 leg를 찾는다 — Route 분기가 transferLegs 한 곳에만
 * 존재하도록 격리한다.
 *
 * leg는 "어느 노선을 타고 어느 역까지 가서 갈아탄다"의 단위:
 *  - DirectRoute: leg 없음 (환승이 없으므로 도착 release만 발화).
 *  - TransferRoute: 1개 leg.
 *  - MultiTransferRoute: transfers.length 개 leg.
 */
import type { Route } from '../../../shared/utils/stationRoute';
import type { LineNumber } from '../../../shared/types/station';

export interface TransferLeg {
  /** 환승역 이름 (stations.json의 name과 일치). */
  transferName: string;
  /** 현재 leg에서 타고 있는 노선. lock.boardingLine과 비교해 매칭한다. */
  fromLine: LineNumber;
}

/**
 * Route → TransferLeg[]. null/direct는 [] 반환 — 호출처는 빈 배열을 자연스럽게 처리.
 *
 * 정렬 보장: trip 진행 순서(첫 환승부터). 다음 leg는 array[i+1].
 */
export function getTransferLegs(route: Route): TransferLeg[] {
  if (!route) return [];
  if (route.type === 'direct') return [];
  if (route.type === 'transfer') {
    return [{ transferName: route.transferName, fromLine: route.fromLine }];
  }
  return route.transfers.map((t) => ({
    transferName: t.transferName,
    fromLine: t.fromLine,
  }));
}
