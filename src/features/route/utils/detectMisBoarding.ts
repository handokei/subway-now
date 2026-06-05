import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { LinePositions } from '../../../shared/types/position';

/**
 * BoardingLock의 trainCode가 lock.boardingLine의 위치 데이터에서 관측되는지 검사 (#584 PR D3).
 *
 * - lock 또는 positions 없음 → 'no-signal' (탐지 보류 — 호출자가 카운터 미증가)
 * - positions.line이 lock.boardingLine과 다름 → 'no-signal' (관측 불가)
 * - positions에 trainNo == lock.trainCode 존재 → 'present'
 * - positions는 있고 trainNo 부재 → 'absent'
 *
 * mock 데이터(isMock=true)는 'no-signal' — 실측이 아니므로 잘못 탑승 판단 근거가 될 수 없다.
 */
export type MisBoardingObservation = 'present' | 'absent' | 'no-signal';

export function detectMisBoarding(
  lock: BoardingLock | null,
  positions: LinePositions | null,
): MisBoardingObservation {
  if (!lock || !positions) return 'no-signal';
  if (positions.isMock) return 'no-signal';
  if (positions.line !== lock.boardingLine) return 'no-signal';
  const found = positions.trains.some((t) => t.trainNo === lock.trainCode);
  return found ? 'present' : 'absent';
}
