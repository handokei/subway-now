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

  it('filterDirection="up"이면 up list만 검색한다 (반대방향 더 빨라도 무시)', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 240, trainCode: 'U-real' })],
      down: [info({ arrivalSeconds: 30, trainCode: 'D-fast' })],
    };
    expect(pickNextArrival(arrival, 'up')).toEqual({
      etaSeconds: 240,
      direction: 'up',
      trainCode: 'U-real',
    });
  });

  it('filterDirection="down"이면 down list만 검색한다', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 30, trainCode: 'U-fast' })],
      down: [info({ arrivalSeconds: 180, trainCode: 'D-real' })],
    };
    expect(pickNextArrival(arrival, 'down')).toEqual({
      etaSeconds: 180,
      direction: 'down',
      trainCode: 'D-real',
    });
  });

  it('filterDirection이 지정됐는데 그 방향에 양수 후보가 없으면 모두 null', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 0 })],
      down: [info({ arrivalSeconds: 300, trainCode: 'D' })],
    };
    expect(pickNextArrival(arrival, 'up')).toEqual({
      etaSeconds: null,
      direction: null,
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
