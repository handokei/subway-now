import type { StationArrival } from '../../../shared/types/arrival';
import type { BoardingLock } from '../../../shared/types/boardingLock';

// 잠긴 열차(lock.trainCode)의 종착역(`bstatnNm`)을 도착 응답 row에서 찾는다.
// lock/응답/일치 row/종착 정보 중 하나라도 없으면 undefined — 호출부는 "종착 불명"으로 취급한다.
export function findLockedTrainTerminal(
  arrival: StationArrival | null | undefined,
  lock: Pick<BoardingLock, 'trainCode'> | null,
): string | undefined {
  if (!arrival || !lock) return undefined;
  const rows = [...arrival.up, ...arrival.down];
  return rows.find((row) => row.trainCode === lock.trainCode)?.terminalStation;
}
