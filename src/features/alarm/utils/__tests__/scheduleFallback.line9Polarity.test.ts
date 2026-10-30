import { buildScheduleArrival } from '../scheduleFallback';

/**
 * #1480 — 9호선 시간표 up/down 극성. 앱 규약상 9호선 idx 증가 = down(`lineTerminals.9.down`=중앙보훈병원 방면).
 * 시간표는 ARRIVETIME 기반이라 종점의 "출발 방향" 열은 0000이고, 종점에는 그쪽으로 들어오는 열차만 잡힌다:
 * 개화(idx 최소)는 up(개화행) 도착만, 중앙보훈병원(idx 최대)은 down(중앙보훈병원행) 도착만 있다. (3호선 대화와 동일 구조)
 */
describe('9호선 시간표 극성 (#1480)', () => {
  const noon = new Date('2026-05-18T12:00:00+09:00');

  it('개화: up(개화행 도착) 열차가 있고 down(출발 열, 0000)은 없다', () => {
    const arrival = buildScheduleArrival('9', '개화', noon);
    expect(arrival.source).toBe('schedule');
    expect(arrival.up.length).toBeGreaterThan(0);
    expect(arrival.down).toEqual([]);
  });

  it('중앙보훈병원: down(중앙보훈병원행 도착) 열차가 있고 up(출발 열, 0000)은 없다', () => {
    const arrival = buildScheduleArrival('9', '중앙보훈병원', noon);
    expect(arrival.source).toBe('schedule');
    expect(arrival.down.length).toBeGreaterThan(0);
    expect(arrival.up).toEqual([]);
  });
});
