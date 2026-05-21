import { classifyDayType, classifyPeriod, buildScheduleArrival, hasHeadwayData } from '../scheduleFallback';
import type { LineNumber } from '../../types/station';

describe('classifyDayType', () => {
  it('returns sunday for Sunday', () => {
    expect(classifyDayType(new Date('2026-05-17T10:00:00+09:00'))).toBe('sunday');
  });
  it('returns saturday for Saturday', () => {
    expect(classifyDayType(new Date('2026-05-16T10:00:00+09:00'))).toBe('saturday');
  });
  it('returns weekday for Monday through Friday', () => {
    expect(classifyDayType(new Date('2026-05-18T10:00:00+09:00'))).toBe('weekday'); // Mon
    expect(classifyDayType(new Date('2026-05-22T10:00:00+09:00'))).toBe('weekday'); // Fri
  });
});

describe('classifyPeriod', () => {
  const make = (h: number, m: number) => {
    const d = new Date('2026-05-18T00:00:00+09:00');
    d.setHours(h, m, 0, 0);
    return d;
  };

  it('returns closed between 01:00 and 05:30', () => {
    expect(classifyPeriod(make(1, 0), 'weekday')).toBe('closed');
    expect(classifyPeriod(make(3, 30), 'weekday')).toBe('closed');
    expect(classifyPeriod(make(5, 29), 'weekday')).toBe('closed');
  });

  it('returns late between 22:00 and 01:00', () => {
    expect(classifyPeriod(make(22, 0), 'weekday')).toBe('late');
    expect(classifyPeriod(make(23, 59), 'weekday')).toBe('late');
    expect(classifyPeriod(make(0, 30), 'weekday')).toBe('late');
  });

  it('returns peak on weekday morning/evening rush', () => {
    expect(classifyPeriod(make(7, 0), 'weekday')).toBe('peak');
    expect(classifyPeriod(make(9, 29), 'weekday')).toBe('peak');
    expect(classifyPeriod(make(18, 0), 'weekday')).toBe('peak');
    expect(classifyPeriod(make(19, 59), 'weekday')).toBe('peak');
  });

  it('returns offPeak on weekend during rush window', () => {
    expect(classifyPeriod(make(8, 0), 'saturday')).toBe('offPeak');
    expect(classifyPeriod(make(19, 0), 'sunday')).toBe('offPeak');
  });

  it('returns offPeak in regular daytime', () => {
    expect(classifyPeriod(make(5, 30), 'weekday')).toBe('offPeak');
    expect(classifyPeriod(make(10, 0), 'weekday')).toBe('offPeak');
    expect(classifyPeriod(make(15, 30), 'weekday')).toBe('offPeak');
    expect(classifyPeriod(make(21, 59), 'weekday')).toBe('offPeak');
  });
});

describe('buildScheduleArrival', () => {
  it('returns empty arrival with source=closed during closed hours', () => {
    const now = new Date('2026-05-18T03:00:00+09:00');
    const result = buildScheduleArrival('2', now);
    expect(result.up).toEqual([]);
    expect(result.down).toEqual([]);
    expect(result.source).toBe('closed');
    expect(result.isMock).toBe(true);
  });

  it('returns 2 up/down trains during weekday peak with line 2 headway 150s', () => {
    const now = new Date('2026-05-18T08:00:00+09:00');
    const result = buildScheduleArrival('2', now);
    expect(result.source).toBe('schedule');
    expect(result.up).toHaveLength(2);
    expect(result.down).toHaveLength(2);
    expect(result.up[0].arrivalSeconds).toBe(75);
    expect(result.up[1].arrivalSeconds).toBe(225);
  });

  it('uses offPeak headway during weekday daytime', () => {
    const now = new Date('2026-05-18T15:00:00+09:00');
    const result = buildScheduleArrival('1', now);
    expect(result.source).toBe('schedule');
    expect(result.up[0].arrivalSeconds).toBe(180); // 360/2
  });

  it('uses saturday offPeak even during what would be peak time', () => {
    const now = new Date('2026-05-16T08:00:00+09:00'); // Saturday
    const result = buildScheduleArrival('2', now);
    expect(result.up[0].arrivalSeconds).toBe(165); // 330/2
  });

  it('falls back to offPeak headway if peak entry missing (weekend peak lookup is never triggered, but defensive)', () => {
    const now = new Date('2026-05-18T08:00:00+09:00');
    const result = buildScheduleArrival('gyeongui', now);
    expect(result.source).toBe('schedule');
    expect(result.up[0].arrivalSeconds).toBe(270); // 540/2
  });

  it('sets receivedAtMs to now.getTime()', () => {
    const now = new Date('2026-05-18T15:00:00+09:00');
    const result = buildScheduleArrival('2', now);
    expect(result.up[0].receivedAtMs).toBe(now.getTime());
  });

  it('marks late period for 23:00 with late headway', () => {
    const now = new Date('2026-05-18T23:00:00+09:00');
    const result = buildScheduleArrival('2', now);
    expect(result.source).toBe('schedule');
    expect(result.up[0].arrivalSeconds).toBe(240); // 480/2
  });

  it('handles sunday late period', () => {
    const now = new Date('2026-05-17T22:30:00+09:00');
    const result = buildScheduleArrival('1', now);
    expect(result.up[0].arrivalSeconds).toBe(330); // 660/2
  });

  it('arrivalMinutes equals floor(arrivalSeconds/60)', () => {
    const now = new Date('2026-05-18T15:00:00+09:00');
    const result = buildScheduleArrival('1', now);
    expect(result.up[0].arrivalMinutes).toBe(3); // floor(180/60)
  });

  it('returns source=closed when line key is missing from headway table (defensive)', () => {
    const now = new Date('2026-05-18T15:00:00+09:00');
    // 알려지지 않은 미래 노선이 LineNumber에 추가됐지만 lineHeadways.json에 누락된 경우.
    const result = buildScheduleArrival('gtx-a' as LineNumber, now);
    expect(result.source).toBe('closed');
    expect(result.up).toEqual([]);
  });
});

describe('hasHeadwayData', () => {
  it('returns true for all current LineNumber values', () => {
    const lines: LineNumber[] = [
      '1', '2', '3', '4', '5', '6', '7', '8', '9',
      'airport', 'gyeongui', 'bundang', 'sinbundang',
    ];
    for (const line of lines) {
      expect(hasHeadwayData(line)).toBe(true);
    }
  });

  it('returns false for an unknown line', () => {
    expect(hasHeadwayData('gtx-a' as LineNumber)).toBe(false);
  });
});
