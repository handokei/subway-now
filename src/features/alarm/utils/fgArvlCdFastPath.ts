import type { StationArrival } from '../../../shared/types/arrival';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import { ARRIVAL_CODE } from '../../../shared/constants/arrivalCodes';

/**
 * #917 A2 follow-up — FG fast path arvlCd∈{0,1} 매역 알림 발사 신호 탐색.
 *
 * 백엔드 cron이 같은 신호로 silent push를 발사할 때까지 10~30s 사이클을 기다리지 않고,
 * 클라가 FG에서 폴링한 `StationArrival`을 보는 즉시 매역 알림을 발사하기 위한 pure 판정 함수.
 *
 * 발사 조건 (AND, 하나라도 false면 null):
 *   1. `arrival` 존재
 *   2. `lock` 존재 (#640 회귀 가드 — lockless trip은 절대 발사 안 함)
 *   3. `arrival.up + arrival.down` 중 `trainCode === lock.trainCode`인 row 존재
 *   4. 해당 row의 `arrivalCode`가 ENTERING(0) 또는 ARRIVED(1)
 *
 * @returns 발사 가능 시 `{ trainCode, arvlCd }`. 모든 가드 통과해야 non-null.
 *
 * 디자인 노트:
 *   - `isImminentByArrivalCode`(destination imminent 전용)와 분리한 이유: 본 fast path는
 *     "현재 폴링 중인 임의의 station에 대한 매역 신호"로 의미가 다르다(destination에 한정 X).
 *     호출자가 station 컨텍스트를 알고 있으므로 함수 자체는 station-agnostic.
 *   - lock.trainCode가 양방향(up/down) 둘 중 어디 있어도 발사 — Seoul API가 동일 trainCode를
 *     direction 분리해 노출할 수 있고, fast path는 방향 무관한 보조 신호.
 */
export interface FgArvlCdFireSignal {
  trainCode: string;
  arvlCd: number;
}

export function findFgArvlCdFireSignal(
  arrival: StationArrival | null,
  lock: BoardingLock | null,
): FgArvlCdFireSignal | null {
  if (!arrival || !lock) return null;
  const rows = [...arrival.up, ...arrival.down];
  const match = rows.find((r) => r.trainCode === lock.trainCode);
  if (!match) return null;
  if (
    match.arrivalCode !== ARRIVAL_CODE.ENTERING &&
    match.arrivalCode !== ARRIVAL_CODE.ARRIVED
  ) {
    return null;
  }
  return { trainCode: lock.trainCode, arvlCd: match.arrivalCode };
}
