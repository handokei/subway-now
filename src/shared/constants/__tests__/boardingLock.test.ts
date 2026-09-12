import { PENDING_TRAIN_CODE, isPendingTrainCode, isRealBoardingLock } from '../boardingLock';
import type { BoardingLock } from '../../types/boardingLock';

describe('isPendingTrainCode (#2407)', () => {
  it('PENDING_TRAIN_CODE sentinel → true', () => {
    expect(isPendingTrainCode(PENDING_TRAIN_CODE)).toBe(true);
  });

  it('실 trainCode → false', () => {
    expect(isPendingTrainCode('2026082601')).toBe(false);
  });

  it('빈 문자열 → false (sentinel은 명시 상수만 인정, falsy coercion에 의존하지 않음)', () => {
    expect(isPendingTrainCode('')).toBe(false);
  });
});

// #2407 Gap B (root fix) — pending fallback lock은 backend 관점에서 lockless와 동일 취급돼야
// 한다. UI가 "실 lock"으로 오인해 train picker를 숨기면(BoardingLockHopCard) 사용자가 실
// trainCode를 고를 기회를 영영 잃는 deadlock이 생긴다.
describe('isRealBoardingLock (#2407 Gap B)', () => {
  const BASE_LOCK: BoardingLock = {
    destinationId: 'dst',
    trainCode: '2026082601',
    boardingStationId: 'S1',
    boardingLine: '2',
    boardedAt: Date.now(),
    expectedDurationMs: 600_000,
  };

  it('lock=null → false', () => {
    expect(isRealBoardingLock(null)).toBe(false);
  });

  it('실 trainCode lock → true', () => {
    expect(isRealBoardingLock(BASE_LOCK)).toBe(true);
  });

  it('pending trainCode lock(PENDING_TRAIN_CODE) → false', () => {
    expect(isRealBoardingLock({ ...BASE_LOCK, trainCode: PENDING_TRAIN_CODE })).toBe(false);
  });
});
