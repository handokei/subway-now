import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';
import type { ArrivalInfo } from '../../../../api/arrivalApi';
import { pickAutoTrainCodeFromArrivals } from '../boardingPromptAutoLock';

function arr(overrides: Partial<ArrivalInfo>): ArrivalInfo {
  return {
    destination: '',
    arrivalMinutes: 0,
    arrivalSeconds: 60,
    statusMessage: '',
    trainCode: 'T1',
    line: '2',
    receivedAtMs: 0,
    arrivalCode: -1,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

describe('pickAutoTrainCodeFromArrivals (#819 arvlCd 우선순위)', () => {
  it('빈 배열 → null', () => {
    expect(pickAutoTrainCodeFromArrivals([])).toBeNull();
  });

  it('priority 1: arvlCd=2 (출발) 단독 → 채택', () => {
    const list = [
      arr({ trainCode: 'A', arrivalCode: 0 }),
      arr({ trainCode: 'B', arrivalCode: 2 }),
      arr({ trainCode: 'C', arrivalCode: ARRIVAL_CODE.ARRIVED }),
    ];
    expect(pickAutoTrainCodeFromArrivals(list)?.trainCode).toBe('B');
  });

  it('priority 2: arvlCd=1 (도착) — arvlCd=2 없을 때', () => {
    const list = [
      arr({ trainCode: 'A', arrivalCode: 0 }),
      arr({ trainCode: 'B', arrivalCode: ARRIVAL_CODE.ARRIVED }),
    ];
    expect(pickAutoTrainCodeFromArrivals(list)?.trainCode).toBe('B');
  });

  it('priority 3: arvlCd=0 (진입) — 2/1 없을 때', () => {
    const list = [arr({ trainCode: 'A', arrivalCode: 0 })];
    expect(pickAutoTrainCodeFromArrivals(list)?.trainCode).toBe('A');
  });

  it('priority 4 fallback: 그 외 코드 → 첫 후보', () => {
    const list = [
      arr({ trainCode: 'A', arrivalCode: 99 }),
      arr({ trainCode: 'B', arrivalCode: ARRIVAL_CODE.PREV_ARRIVED }),
    ];
    expect(pickAutoTrainCodeFromArrivals(list)?.trainCode).toBe('A');
  });

  it('ambiguity: 같은 우선순위 후보 2+ → null', () => {
    const list = [
      arr({ trainCode: 'A', arrivalCode: 2 }),
      arr({ trainCode: 'B', arrivalCode: 2 }),
    ];
    expect(pickAutoTrainCodeFromArrivals(list)).toBeNull();
  });

  it('trainCode 빈 문자열 단독 → null', () => {
    const list = [arr({ trainCode: '', arrivalCode: 2 })];
    expect(pickAutoTrainCodeFromArrivals(list)).toBeNull();
  });

  it('fallback 후보의 trainCode가 빈 문자열이면 null', () => {
    const list = [arr({ trainCode: '', arrivalCode: 99 })];
    expect(pickAutoTrainCodeFromArrivals(list)).toBeNull();
  });
});
