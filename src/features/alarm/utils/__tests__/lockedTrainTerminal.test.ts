import { findLockedTrainTerminal } from '../lockedTrainTerminal';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';

const row = (trainCode: string, terminalStation?: string): ArrivalInfo =>
  ({ trainCode, terminalStation }) as ArrivalInfo;

const arrival = (up: ArrivalInfo[], down: ArrivalInfo[]): StationArrival =>
  ({ up, down }) as StationArrival;

describe('findLockedTrainTerminal', () => {
  const lock = { trainCode: '2201' };

  it('lock.trainCode와 일치하는 up/down row의 종착역을 반환한다', () => {
    expect(findLockedTrainTerminal(arrival([row('2201', '성수')], []), lock)).toBe('성수');
    expect(findLockedTrainTerminal(arrival([row('9'), ], [row('2201', '왕십리')]), lock)).toBe('왕십리');
  });

  it.each([
    ['lock 없음', arrival([row('2201', '성수')], []), null],
    ['arrival 없음', null, lock],
    ['arrival undefined', undefined, lock],
    ['일치 row 없음', arrival([row('1111', '성수')], []), lock],
    ['일치 row에 종착 정보 없음', arrival([row('2201')], []), lock],
  ] as const)('%s이면 undefined (추측하지 않음)', (_name, a, l) => {
    expect(findLockedTrainTerminal(a, l)).toBeUndefined();
  });
});
