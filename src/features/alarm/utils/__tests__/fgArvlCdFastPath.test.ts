import { findFgArvlCdFireSignal } from '../fgArvlCdFastPath';
import type { StationArrival } from '../../../../shared/types/arrival';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { ArrivalInfo } from '../../../../shared/types/arrival';
import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';

function makeRow(overrides: Partial<ArrivalInfo>): ArrivalInfo {
  return {
    destination: '강남',
    arrivalMinutes: 1,
    arrivalSeconds: 60,
    statusMessage: '',
    trainCode: 'T1',
    line: '2',
    receivedAtMs: 1_700_000_000_000,
    arrivalCode: ARRIVAL_CODE.ENTERING,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

function makeArrival(rows: { up?: ArrivalInfo[]; down?: ArrivalInfo[] }): StationArrival {
  return { up: rows.up ?? [], down: rows.down ?? [] };
}

const lock: BoardingLock = {
  destinationId: 'D1',
  trainCode: 'T1',
  boardingStationId: 'S1',
  boardingLine: '2',
  boardedAt: 1_700_000_000_000,
  expectedDurationMs: 600_000,
};

describe('findFgArvlCdFireSignal (#917 A2 follow-up)', () => {
  it('arrival null이면 null', () => {
    expect(findFgArvlCdFireSignal(null, lock)).toBeNull();
  });

  it('#640 회귀 가드 — lock null이면 null (lockless 매역 알림 절대 금지)', () => {
    const arrival = makeArrival({
      up: [makeRow({ trainCode: 'T1', arrivalCode: ARRIVAL_CODE.ENTERING })],
    });
    expect(findFgArvlCdFireSignal(arrival, null)).toBeNull();
  });

  it('row가 한 건도 없으면 null', () => {
    expect(findFgArvlCdFireSignal(makeArrival({}), lock)).toBeNull();
  });

  it('lock.trainCode와 일치하는 row가 없으면 null (#640 회귀 가드)', () => {
    const arrival = makeArrival({
      up: [makeRow({ trainCode: 'OTHER', arrivalCode: ARRIVAL_CODE.ENTERING })],
      down: [makeRow({ trainCode: 'ALSO-OTHER', arrivalCode: ARRIVAL_CODE.ARRIVED })],
    });
    expect(findFgArvlCdFireSignal(arrival, lock)).toBeNull();
  });

  it('lock.trainCode 일치 + arvlCd=ENTERING(0) → fire signal 반환', () => {
    const arrival = makeArrival({
      up: [makeRow({ trainCode: 'T1', arrivalCode: ARRIVAL_CODE.ENTERING })],
    });
    expect(findFgArvlCdFireSignal(arrival, lock)).toEqual({
      trainCode: 'T1',
      arvlCd: ARRIVAL_CODE.ENTERING,
    });
  });

  it('lock.trainCode 일치 + arvlCd=ARRIVED(1) → fire signal 반환', () => {
    const arrival = makeArrival({
      down: [makeRow({ trainCode: 'T1', arrivalCode: ARRIVAL_CODE.ARRIVED })],
    });
    expect(findFgArvlCdFireSignal(arrival, lock)).toEqual({
      trainCode: 'T1',
      arvlCd: ARRIVAL_CODE.ARRIVED,
    });
  });

  it('lock.trainCode 일치하지만 arvlCd=DEPARTED(2) → null (신호 아님)', () => {
    const arrival = makeArrival({
      up: [makeRow({ trainCode: 'T1', arrivalCode: ARRIVAL_CODE.DEPARTED })],
    });
    expect(findFgArvlCdFireSignal(arrival, lock)).toBeNull();
  });

  it('lock.trainCode 일치하지만 arvlCd=PREV_ARRIVED(5) → null (전역 신호는 fast path 대상 아님)', () => {
    const arrival = makeArrival({
      up: [makeRow({ trainCode: 'T1', arrivalCode: ARRIVAL_CODE.PREV_ARRIVED })],
    });
    expect(findFgArvlCdFireSignal(arrival, lock)).toBeNull();
  });

  it('down 방향에 있는 lock.trainCode도 탐지 (방향 무관)', () => {
    const arrival = makeArrival({
      up: [makeRow({ trainCode: 'X', arrivalCode: ARRIVAL_CODE.ARRIVED })],
      down: [makeRow({ trainCode: 'T1', arrivalCode: ARRIVAL_CODE.ENTERING })],
    });
    expect(findFgArvlCdFireSignal(arrival, lock)).toEqual({
      trainCode: 'T1',
      arvlCd: ARRIVAL_CODE.ENTERING,
    });
  });
});
