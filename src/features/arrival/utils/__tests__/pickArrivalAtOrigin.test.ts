import { pickArrivalAtOrigin } from '../pickArrivalAtOrigin';
import type { ArrivalInfo, StationArrival } from '../../api/arrivalApi';

function makeArrival(
  arrivalSeconds: number,
  receivedAtMs: number,
  trainCode = 'T-1',
): ArrivalInfo {
  return {
    destination: 'dest',
    stopsAway: null,
    arrivalSeconds,
    statusMessage: '',
    trainCode,
    line: '2',
    receivedAtMs,
    arrivalCode: -1,
    isLastTrain: false,
    trainType: 'normal',
  };
}

describe('pickArrivalAtOrigin', () => {
  it('arrival=null이면 undefined', () => {
    expect(pickArrivalAtOrigin(null, 'up')).toBeUndefined();
  });

  it('isMock=true면 undefined (정책상 mock 명시 제외)', () => {
    const arrival: StationArrival = {
      up: [makeArrival(120, 1000)],
      down: [makeArrival(60, 1000)],
      isMock: true,
    };
    expect(pickArrivalAtOrigin(arrival, 'up')).toBeUndefined();
  });

  it('up/down 모두 비어있으면 undefined', () => {
    const arrival: StationArrival = { up: [], down: [] };
    expect(pickArrivalAtOrigin(arrival, 'up')).toBeUndefined();
  });

  it('up만 있고 정상 row면 그 값 반환', () => {
    const arrival: StationArrival = {
      up: [makeArrival(180, 1700_000_000_000)],
      down: [],
    };
    expect(pickArrivalAtOrigin(arrival, 'up')).toEqual({
      arrivalSeconds: 180,
      receivedAtMs: 1700_000_000_000,
    });
  });

  it('down만 있고 정상 row면 그 값 반환', () => {
    const arrival: StationArrival = {
      up: [],
      down: [makeArrival(240, 1700_000_000_500)],
    };
    expect(pickArrivalAtOrigin(arrival, 'down')).toEqual({
      arrivalSeconds: 240,
      receivedAtMs: 1700_000_000_500,
    });
  });

  it('#1480 N8 — up=60초/down=480초, 내 방향 down이면 빠른 up이 아니라 down 값', () => {
    const arrival: StationArrival = {
      up: [makeArrival(60, 1700_000_000_700)],
      down: [makeArrival(480, 1700_000_000_500)],
    };
    expect(pickArrivalAtOrigin(arrival, 'down')).toEqual({
      arrivalSeconds: 480,
      receivedAtMs: 1700_000_000_500,
    });
  });

  it('#1480 N8 — 내 방향 up이면 down이 더 빨라도 up 값', () => {
    const arrival: StationArrival = {
      up: [makeArrival(480, 1700_000_000_700)],
      down: [makeArrival(60, 1700_000_000_500)],
    };
    expect(pickArrivalAtOrigin(arrival, 'up')).toEqual({
      arrivalSeconds: 480,
      receivedAtMs: 1700_000_000_700,
    });
  });

  it('#1480 D5 — 방향 판정 불가(null)면 양방향 최솟값 폐기, undefined(데이터 없음)', () => {
    const arrival: StationArrival = {
      up: [makeArrival(60, 1700_000_000_700)],
      down: [makeArrival(480, 1700_000_000_500)],
    };
    expect(pickArrivalAtOrigin(arrival, null)).toBeUndefined();
  });

  it('#1480 N8 — 내 방향 목록이 비면 반대 방향 열차로 대체하지 않는다', () => {
    const arrival: StationArrival = { up: [makeArrival(60, 1700_000_000_700)], down: [] };
    expect(pickArrivalAtOrigin(arrival, 'down')).toBeUndefined();
  });

  it('receivedAtMs<=0인 row는 skip', () => {
    const arrival: StationArrival = {
      up: [makeArrival(60, 0)], // 0 → skip
      down: [makeArrival(120, 1700_000_000_000)],
    };
    expect(pickArrivalAtOrigin(arrival, 'up')).toBeUndefined();
    expect(pickArrivalAtOrigin(arrival, 'down')).toEqual({
      arrivalSeconds: 120,
      receivedAtMs: 1700_000_000_000,
    });
  });

  it('arrivalSeconds<0인 row는 skip', () => {
    const arrival: StationArrival = {
      up: [makeArrival(-1, 1700_000_000_000)],
      down: [makeArrival(180, 1700_000_000_500)],
    };
    expect(pickArrivalAtOrigin(arrival, 'up')).toBeUndefined();
    expect(pickArrivalAtOrigin(arrival, 'down')).toEqual({
      arrivalSeconds: 180,
      receivedAtMs: 1700_000_000_500,
    });
  });

  it('첫 차만 평가 — 둘째 차가 더 빨라도 무시', () => {
    const arrival: StationArrival = {
      up: [makeArrival(300, 1700_000_000_000), makeArrival(60, 1700_000_000_000)],
      down: [makeArrival(400, 1700_000_000_500)],
    };
    expect(pickArrivalAtOrigin(arrival, 'up')).toEqual({
      arrivalSeconds: 300,
      receivedAtMs: 1700_000_000_000,
    });
  });

  it('양 방향 첫 차 모두 비정상이면 undefined', () => {
    const arrival: StationArrival = {
      up: [makeArrival(60, 0)],
      down: [makeArrival(-5, 1700_000_000_000)],
    };
    expect(pickArrivalAtOrigin(arrival, 'up')).toBeUndefined();
  });
});
