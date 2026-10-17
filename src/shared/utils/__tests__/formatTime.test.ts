import { formatArrivalTime, formatClockTime, formatClockTimeWithSeconds } from '../formatTime';

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

describe('formatClockTime (#625)', () => {
  it('HH:mm 24h 포맷, zero-padded', () => {
    // 디바이스 timezone에 의존하므로 같은 epoch ms를 Date()로 환산해 비교.
    const epoch = 1_700_000_000_000;
    const d = new Date(epoch);
    const expected = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(formatClockTime(epoch)).toBe(expected);
  });

  it('한 자리 시/분도 두 자리로 패딩', () => {
    // 2026-01-01T03:05:00 UTC 같은 시각을 timezone-agnostic하게 검증.
    const d = new Date(2026, 0, 1, 3, 5);
    expect(formatClockTime(d.getTime())).toBe('03:05');
  });
});

describe('formatClockTimeWithSeconds (#852)', () => {
  it('null이면 (never)', () => {
    expect(formatClockTimeWithSeconds(null)).toBe('(never)');
  });

  it('HH:mm:ss 24h 포맷, 한 자리도 모두 두 자리로 패딩', () => {
    const d = new Date(2026, 5, 3, 8, 7, 5);
    expect(formatClockTimeWithSeconds(d.getTime())).toBe('08:07:05');
  });

  it('두 자리 시/분/초를 그대로 표기', () => {
    const d = new Date(2026, 5, 3, 14, 30, 45);
    expect(formatClockTimeWithSeconds(d.getTime())).toBe('14:30:45');
  });
});
