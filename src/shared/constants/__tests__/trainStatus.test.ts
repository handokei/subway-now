import { TRAIN_STATUS, getTrainStatusPriority } from '../trainStatus';

describe('trainStatus', () => {
  it('상수가 스펙과 일치 (0:진입,1:도착,2:출발,3:전역출발)', () => {
    expect(TRAIN_STATUS.ENTERING).toBe(0);
    expect(TRAIN_STATUS.ARRIVED).toBe(1);
    expect(TRAIN_STATUS.DEPARTED).toBe(2);
    expect(TRAIN_STATUS.PREV_DEPARTED).toBe(3);
  });

  it('priority: ARRIVED(1)이 ENTERING(0)보다 강하고 그외는 0', () => {
    expect(getTrainStatusPriority(TRAIN_STATUS.ARRIVED)).toBeGreaterThan(
      getTrainStatusPriority(TRAIN_STATUS.ENTERING),
    );
    expect(getTrainStatusPriority(TRAIN_STATUS.DEPARTED)).toBe(0);
    expect(getTrainStatusPriority(TRAIN_STATUS.PREV_DEPARTED)).toBe(0);
    expect(getTrainStatusPriority(undefined)).toBe(0);
    expect(getTrainStatusPriority(99)).toBe(0);
  });
});
