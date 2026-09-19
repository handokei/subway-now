import { createDebugBuffer } from '../../../shared/utils/createDebugBuffer';

/**
 * #1896 (RC-8) — boarding-lock GPS displacement gate trigger 전용 ring buffer.
 *
 * 배경: drift gate가 활성화되는 시나리오(T2 evidence: 8분 stuck)에서 매 폴링 cycle(~30s)마다
 * entry가 push된다. 단일 fusionDebugBuffer(cap=500) 채널에 적재하면 fusion decision /
 * sticky / gps-fix 등 진단 1순위 entry가 evict되는 self-pollution이 발생.
 * `candidateRejectBuffer`(#1902, RC-18) 패턴 동일 — 별 buffer로 분리.
 *
 * cap=50: drift gate trigger는 stuck 1회 시나리오에서 16~20회 fire (8분 / 30s cycle).
 * 정상 trip 60+분에서도 cap을 넘지 않도록 여유 확보.
 *
 * 두 종류 branch:
 *  - `positionTrain`: `positionTrainBoardingLockMatch` 분기 drift block 트리거.
 *  - `arvlCdArrived`: `arvlCdArrivedMatch` 분기 drift block 트리거.
 */
export const BOARDING_LOCK_DRIFT_BUFFER_CAPACITY = 50;

export type BoardingLockDriftBranch = 'positionTrain' | 'arvlCdArrived';

export interface BoardingLockDriftEntry {
  kind: 'boarding-lock-drift';
  ts: number;
  /** 트리거된 분기 — positionTrainBoardingLockMatch 또는 arvlCdArrivedMatch. */
  branch: BoardingLockDriftBranch;
  /** lock 결과 역 이름 — drift 발생 시점에 lock이 가리키던 station. */
  lockStationName: string;
  /** lock 결과 역 노선. */
  lockStationLine: string;
  /** GPS와 lock station 간 거리(m). null이면 GPS 없음 (이 분기는 실용적으로 미도달이지만 타입 안정용). */
  driftMeters: number | null;
}

const db = createDebugBuffer<BoardingLockDriftEntry>(BOARDING_LOCK_DRIFT_BUFFER_CAPACITY);

export function pushBoardingLockDriftEntry(entry: BoardingLockDriftEntry): void {
  db.push(entry);
}

export function getBoardingLockDriftEntries(): readonly BoardingLockDriftEntry[] {
  return db.get();
}

export function clearBoardingLockDriftEntries(): void {
  db.clear();
}

export function subscribeBoardingLockDrift(listener: () => void): () => void {
  return db.subscribe(listener);
}
