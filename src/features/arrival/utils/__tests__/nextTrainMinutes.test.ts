import { pickNextTrainMinutes } from '../nextTrainMinutes';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';

function row(arrivalSeconds: number | null): ArrivalInfo {
  return {
    destination: 'dest',
    stopsAway: null,
    arrivalSeconds,
    statusMessage: '',
    trainCode: 'T',
    line: '2',
    receivedAtMs: 1_000,
    arrivalCode: 99,
    isLastTrain: false,
    trainType: 'normal',
  };
}

describe('pickNextTrainMinutes — 출발 대기 방향 (#1480 N8)', () => {
  const arrival: StationArrival = { up: [row(60)], down: [row(480)] };

  it('up=1분/down=8분, 내 방향 down이면 8 (양방향 최솟값 1이 아님)', () => {
    expect(pickNextTrainMinutes(arrival, 'down')).toBe(8);
  });

  it('내 방향 up이면 1', () => {
    expect(pickNextTrainMinutes(arrival, 'up')).toBe(1);
  });

  it('D5 — 방향 null이면 데이터 없음(Infinity) — 최솟값 1로 대체하지 않는다', () => {
    expect(pickNextTrainMinutes(arrival, null)).toBe(Infinity);
  });

  it('내 방향 목록이 비면 Infinity', () => {
    expect(pickNextTrainMinutes({ up: [row(60)], down: [] }, 'down')).toBe(Infinity);
  });
});
