import { formatArrivalTime } from '../formatTime';

describe('formatArrivalTime', () => {
  it('0초 이하이면 "곧 도착"을 반환한다', () => {
    expect(formatArrivalTime(0)).toBe('곧 도착');
    expect(formatArrivalTime(-1)).toBe('곧 도착');
  });

  it('60초 미만이면 초만 표시한다', () => {
    expect(formatArrivalTime(30)).toBe('30초');
    expect(formatArrivalTime(1)).toBe('1초');
    expect(formatArrivalTime(59)).toBe('59초');
  });

  it('60초 이상이면 분과 초를 표시한다', () => {
    expect(formatArrivalTime(60)).toBe('1분 0초');
    expect(formatArrivalTime(90)).toBe('1분 30초');
    expect(formatArrivalTime(150)).toBe('2분 30초');
    expect(formatArrivalTime(300)).toBe('5분 0초');
  });
});
