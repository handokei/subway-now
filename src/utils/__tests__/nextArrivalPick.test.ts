import { pickNextArrival } from '../nextArrivalPick';
import type { ArrivalInfo, StationArrival } from '../../api/arrivalApi';

function info(overrides: Partial<ArrivalInfo>): ArrivalInfo {
  return {
    destination: 'D',
    arrivalMinutes: 0,
    arrivalSeconds: 100,
    statusMessage: '',
    trainCode: 'T-1',
    receivedAtMs: 0,
    arrivalCode: -1,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

describe('pickNextArrival', () => {
  it('arrival이 null이면 모두 null', () => {
    expect(pickNextArrival(null)).toEqual({
      etaSeconds: null,
      direction: null,
      trainCode: null,
    });
  });

  it('isMock=true면 모두 null', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 100 })],
      down: [],
      isMock: true,
    };
    expect(pickNextArrival(arrival)).toEqual({
      etaSeconds: null,
      direction: null,
      trainCode: null,
    });
  });

  it('up/down 양방향에서 가장 빠른 양수 arrivalSeconds를 선택한다', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 300, trainCode: 'U1' })],
      down: [info({ arrivalSeconds: 120, trainCode: 'D1' })],
    };
    expect(pickNextArrival(arrival)).toEqual({
      etaSeconds: 120,
      direction: 'down',
      trainCode: 'D1',
    });
  });

  it('동일 방향 내에서도 최소값을 선택한다', () => {
    const arrival: StationArrival = {
      up: [
        info({ arrivalSeconds: 500, trainCode: 'U-late' }),
        info({ arrivalSeconds: 80, trainCode: 'U-soon' }),
      ],
      down: [],
    };
    expect(pickNextArrival(arrival)).toEqual({
      etaSeconds: 80,
      direction: 'up',
      trainCode: 'U-soon',
    });
  });

  it('0 이하 arrivalSeconds는 후보에서 제외한다', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 0 }), info({ arrivalSeconds: -5 })],
      down: [info({ arrivalSeconds: 250, trainCode: 'D-only' })],
    };
    expect(pickNextArrival(arrival)).toEqual({
      etaSeconds: 250,
      direction: 'down',
      trainCode: 'D-only',
    });
  });

  it('양수 후보가 전혀 없으면 모두 null', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 0 })],
      down: [info({ arrivalSeconds: -1 })],
    };
    expect(pickNextArrival(arrival)).toEqual({
      etaSeconds: null,
      direction: null,
      trainCode: null,
    });
  });

  it('trainCode가 빈 문자열이면 null로 변환한다', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 100, trainCode: '' })],
      down: [],
    };
    expect(pickNextArrival(arrival)).toEqual({
      etaSeconds: 100,
      direction: 'up',
      trainCode: null,
    });
  });

  it('isMock 필드가 없는 입력 형태({up,down}만)도 동작한다', () => {
    const result = pickNextArrival({
      up: [info({ arrivalSeconds: 60, trainCode: 'fetch-T' })],
      down: [],
    });
    expect(result).toEqual({
      etaSeconds: 60,
      direction: 'up',
      trainCode: 'fetch-T',
    });
  });
});
