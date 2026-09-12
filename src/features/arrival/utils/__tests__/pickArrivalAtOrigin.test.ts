import { pickArrivalAtOrigin } from '../pickArrivalAtOrigin';
import type { ArrivalInfo, StationArrival } from '../../api/arrivalApi';

function makeArrival(
  arrivalSeconds: number,
  receivedAtMs: number,
  trainCode = 'T-1',
): ArrivalInfo {
  return {
    destination: 'dest',
    arrivalMinutes: Math.floor(arrivalSeconds / 60),
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
    expect(pickArrivalAtOrigin(null)).toBeUndefined();
  });

  it('isMock=true면 undefined (정책상 mock 명시 제외)', () => {
    const arrival: StationArrival = {
      up: [makeArrival(120, 1000)],
      down: [makeArrival(60, 1000)],
      isMock: true,
    };
    expect(pickArrivalAtOrigin(arrival)).toBeUndefined();
  });

  it('up/down 모두 비어있으면 undefined', () => {
    const arrival: StationArrival = { up: [], down: [] };
    expect(pickArrivalAtOrigin(arrival)).toBeUndefined();
  });

  it('up만 있고 정상 row면 그 값 반환', () => {
    const arrival: StationArrival = {
      up: [makeArrival(180, 1700_000_000_000)],
      down: [],
    };
    expect(pickArrivalAtOrigin(arrival)).toEqual({
      arrivalSeconds: 180,
      receivedAtMs: 1700_000_000_000,
    });
  });

  it('down만 있고 정상 row면 그 값 반환', () => {
    const arrival: StationArrival = {
      up: [],
      down: [makeArrival(240, 1700_000_000_500)],
    };
    expect(pickArrivalAtOrigin(arrival)).toEqual({
      arrivalSeconds: 240,
      receivedAtMs: 1700_000_000_500,
    });
  });

  it('up/down 둘 다 있으면 빠른 쪽 선택 (down이 빠른 케이스)', () => {
    const arrival: StationArrival = {
      up: [makeArrival(300, 1700_000_000_000)],
      down: [makeArrival(120, 1700_000_000_500)],
    };
    expect(pickArrivalAtOrigin(arrival)).toEqual({
      arrivalSeconds: 120,
      receivedAtMs: 1700_000_000_500,
    });
  });

  it('up/down 둘 다 있으면 빠른 쪽 선택 (up이 빠른 케이스)', () => {
    const arrival: StationArrival = {
      up: [makeArrival(90, 1700_000_000_700)],
      down: [makeArrival(200, 1700_000_000_500)],
    };
    expect(pickArrivalAtOrigin(arrival)).toEqual({
      arrivalSeconds: 90,
      receivedAtMs: 1700_000_000_700,
    });
  });

  it('receivedAtMs<=0인 row는 skip', () => {
    const arrival: StationArrival = {
      up: [makeArrival(60, 0)], // 0 → skip
      down: [makeArrival(120, 1700_000_000_000)],
    };
    expect(pickArrivalAtOrigin(arrival)).toEqual({
      arrivalSeconds: 120,
      receivedAtMs: 1700_000_000_000,
    });
  });

  it('arrivalSeconds<0인 row는 skip', () => {
    const arrival: StationArrival = {
      up: [makeArrival(-1, 1700_000_000_000)],
      down: [makeArrival(180, 1700_000_000_500)],
    };
    expect(pickArrivalAtOrigin(arrival)).toEqual({
      arrivalSeconds: 180,
      receivedAtMs: 1700_000_000_500,
    });
  });

  it('첫 차만 평가 — 둘째 차가 더 빨라도 무시', () => {
    const arrival: StationArrival = {
      up: [makeArrival(300, 1700_000_000_000), makeArrival(60, 1700_000_000_000)],
      down: [makeArrival(400, 1700_000_000_500)],
    };
    expect(pickArrivalAtOrigin(arrival)).toEqual({
      arrivalSeconds: 300,
      receivedAtMs: 1700_000_000_000,
    });
  });

  it('양 방향 첫 차 모두 비정상이면 undefined', () => {
    const arrival: StationArrival = {
      up: [makeArrival(60, 0)],
      down: [makeArrival(-5, 1700_000_000_000)],
    };
    expect(pickArrivalAtOrigin(arrival)).toBeUndefined();
  });
});
