import { ARRIVAL_CODE, getArrivalPriority } from '../arrivalCodes';

describe('arrivalCodes', () => {
  it('ARRIVAL_CODE 매핑이 xls 스펙과 일치한다', () => {
    expect(ARRIVAL_CODE.ENTERING).toBe(0);
    expect(ARRIVAL_CODE.ARRIVED).toBe(1);
    expect(ARRIVAL_CODE.DEPARTED).toBe(2);
    expect(ARRIVAL_CODE.PREV_DEPARTED).toBe(3);
    expect(ARRIVAL_CODE.PREV_ENTERING).toBe(4);
    expect(ARRIVAL_CODE.PREV_ARRIVED).toBe(5);
    expect(ARRIVAL_CODE.RUNNING).toBe(99);
  });

  it('getArrivalPriority: 1(도착) > 0(진입) > 5(전역도착) > 4(전역진입)', () => {
    expect(getArrivalPriority(ARRIVAL_CODE.ARRIVED)).toBeGreaterThan(
      getArrivalPriority(ARRIVAL_CODE.ENTERING),
    );
    expect(getArrivalPriority(ARRIVAL_CODE.ENTERING)).toBeGreaterThan(
      getArrivalPriority(ARRIVAL_CODE.PREV_ARRIVED),
    );
    expect(getArrivalPriority(ARRIVAL_CODE.PREV_ARRIVED)).toBeGreaterThan(
      getArrivalPriority(ARRIVAL_CODE.PREV_ENTERING),
    );
    expect(getArrivalPriority(ARRIVAL_CODE.PREV_ENTERING)).toBeGreaterThan(0);
  });

  it('getArrivalPriority: 출발/전역출발/운행중/누락은 0', () => {
    expect(getArrivalPriority(ARRIVAL_CODE.DEPARTED)).toBe(0);
    expect(getArrivalPriority(ARRIVAL_CODE.PREV_DEPARTED)).toBe(0);
    expect(getArrivalPriority(ARRIVAL_CODE.RUNNING)).toBe(0);
    expect(getArrivalPriority(undefined)).toBe(0);
    expect(getArrivalPriority(-1)).toBe(0);
    expect(getArrivalPriority(42)).toBe(0);
  });
});
