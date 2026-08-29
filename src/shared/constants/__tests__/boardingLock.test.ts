import { PENDING_TRAIN_CODE, isPendingTrainCode } from '../boardingLock';

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
