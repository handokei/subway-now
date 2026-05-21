import { isImminentByArrivalCode } from '../imminentArrivalSignal';
import { ARRIVAL_CODE } from '../../constants/arrivalCodes';
import type { ArrivalInfo, StationArrival } from '../../api/arrivalApi';

function makeTrain(trainCode: string, arrivalCode: number): ArrivalInfo {
  return {
    destination: '',
    arrivalMinutes: 0,
    arrivalSeconds: 0,
    statusMessage: '',
    trainCode,
    receivedAtMs: 0,
    arrivalCode,
    isLastTrain: false,
    trainType: 'normal',
  };
}

function makeArrival(up: ArrivalInfo[], down: ArrivalInfo[] = []): StationArrival {
  return { up, down };
}

describe('isImminentByArrivalCode', () => {
  it('arrival이 null이면 false', () => {
    expect(isImminentByArrivalCode(null, 'T1')).toBe(false);
  });

  it('trainCode가 null이면 false (lock 실패 보수 정책)', () => {
    const arrival = makeArrival([makeTrain('T1', ARRIVAL_CODE.ENTERING)]);
    expect(isImminentByArrivalCode(arrival, null)).toBe(false);
  });

  it('매칭되는 trainCode가 없으면 false', () => {
    const arrival = makeArrival([makeTrain('T1', ARRIVAL_CODE.ARRIVED)]);
    expect(isImminentByArrivalCode(arrival, 'T2')).toBe(false);
  });

  it('매칭 train의 arrivalCode가 ENTERING(0)이면 true', () => {
    const arrival = makeArrival([makeTrain('T1', ARRIVAL_CODE.ENTERING)]);
    expect(isImminentByArrivalCode(arrival, 'T1')).toBe(true);
  });

  it('매칭 train의 arrivalCode가 ARRIVED(1)이면 true', () => {
    const arrival = makeArrival([makeTrain('T1', ARRIVAL_CODE.ARRIVED)]);
    expect(isImminentByArrivalCode(arrival, 'T1')).toBe(true);
  });

  it('매칭 train이 down 방향에 있어도 true', () => {
    const arrival = makeArrival([], [makeTrain('T1', ARRIVAL_CODE.ENTERING)]);
    expect(isImminentByArrivalCode(arrival, 'T1')).toBe(true);
  });

  it('매칭 train의 arrivalCode가 DEPARTED/RUNNING/전역 코드면 false', () => {
    const cases = [
      ARRIVAL_CODE.DEPARTED,
      ARRIVAL_CODE.PREV_DEPARTED,
      ARRIVAL_CODE.PREV_ENTERING,
      ARRIVAL_CODE.PREV_ARRIVED,
      ARRIVAL_CODE.RUNNING,
    ];
    for (const code of cases) {
      const arrival = makeArrival([makeTrain('T1', code)]);
      expect(isImminentByArrivalCode(arrival, 'T1')).toBe(false);
    }
  });

  it('빈 up/down 배열은 false', () => {
    expect(isImminentByArrivalCode(makeArrival([]), 'T1')).toBe(false);
  });
});
