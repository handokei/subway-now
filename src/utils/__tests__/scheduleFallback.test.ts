import {
  classifyDayType,
  classifyPeriod,
  buildScheduleArrival,
  hasHeadwayData,
  hasTerminalData,
} from '../scheduleFallback';
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
  // KST 절대시각을 ISO 문자열로 만들어 호스트 타임존에 의존하지 않게 한다 (CI는 UTC).
  const make = (h: number, m: number) => {
    const hh = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    return new Date(`2026-05-18T${hh}:${mm}:00+09:00`);
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

  // wall-clock anchor 기반이므로 정확한 값은 nowMs % headway에 의존.
  // 시간대별 헤드웨이 분류와 anchor 범위(0 < first <= headway, second = first + headway)를 검증.

  it('returns 2 up/down trains during weekday peak with line 2 headway 150s', () => {
    const now = new Date('2026-05-18T08:00:00+09:00');
    const result = buildScheduleArrival('2', now);
    expect(result.source).toBe('schedule');
    expect(result.up).toHaveLength(2);
    expect(result.down).toHaveLength(2);
    const first = result.up[0].arrivalSeconds;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(150);
    expect(result.up[1].arrivalSeconds).toBe(first + 150);
  });

  it('uses offPeak headway during weekday daytime', () => {
    const now = new Date('2026-05-18T15:00:00+09:00');
    const result = buildScheduleArrival('1', now);
    expect(result.source).toBe('schedule');
    const first = result.up[0].arrivalSeconds;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(360);
  });

  it('uses saturday offPeak even during what would be peak time', () => {
    const now = new Date('2026-05-16T08:00:00+09:00'); // Saturday
    const result = buildScheduleArrival('2', now);
    expect(result.up[0].arrivalSeconds).toBeLessThanOrEqual(330);
  });

  it('falls back to offPeak headway if peak entry missing (weekend peak lookup is never triggered, but defensive)', () => {
    const now = new Date('2026-05-18T08:00:00+09:00');
    const result = buildScheduleArrival('gyeongui', now);
    expect(result.source).toBe('schedule');
    expect(result.up[0].arrivalSeconds).toBeLessThanOrEqual(540);
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
    expect(result.up[0].arrivalSeconds).toBeLessThanOrEqual(480);
  });

  it('handles sunday late period', () => {
    const now = new Date('2026-05-17T22:30:00+09:00');
    const result = buildScheduleArrival('1', now);
    expect(result.up[0].arrivalSeconds).toBeLessThanOrEqual(660);
  });

  it('arrivalMinutes equals floor(arrivalSeconds/60)', () => {
    const now = new Date('2026-05-18T15:00:00+09:00');
    const result = buildScheduleArrival('1', now);
    expect(result.up[0].arrivalMinutes).toBe(Math.floor(result.up[0].arrivalSeconds / 60));
  });

  it('anchors next departure to wall-clock so polling (+5s) returns continuously decreasing ETA', () => {
    const t0 = new Date('2026-05-18T15:00:00.000+09:00');
    const t5 = new Date(t0.getTime() + 5_000);
    const r0 = buildScheduleArrival('2', t0);
    const r5 = buildScheduleArrival('2', t5);
    // 둘 다 schedule이고 같은 헤드웨이 격자 안이라면 +5s 폴링 결과는 5초 적게 남아야 함.
    // 트레인 시프트 직후가 아니면 정확히 -5s.
    if (r0.up[0].arrivalSeconds > 5) {
      expect(r5.up[0].arrivalSeconds).toBe(r0.up[0].arrivalSeconds - 5);
    }
  });

  it('shifts next-departure anchor when nowMs lies exactly on grid (no 0s train shown)', () => {
    // line 1 offPeak headway = 360s. grid 정렬 케이스 강제.
    const headwayMs = 360_000;
    const alignedMs = Math.ceil(new Date('2026-05-18T15:00:00+09:00').getTime() / headwayMs) * headwayMs;
    const result = buildScheduleArrival('1', new Date(alignedMs));
    expect(result.up[0].arrivalSeconds).toBe(360); // 다음 격자로 시프트되어 headway 그대로
  });

  it('returns source=closed when line key is missing from headway table (defensive)', () => {
    const now = new Date('2026-05-18T15:00:00+09:00');
    // 알려지지 않은 미래 노선이 LineNumber에 추가됐지만 lineHeadways.json에 누락된 경우.
    const result = buildScheduleArrival('gtx-a' as LineNumber, now);
    expect(result.source).toBe('closed');
    expect(result.up).toEqual([]);
  });

  it('up 트레인은 up 종착역으로, down 트레인은 down 종착역으로 destination을 채운다 (#471)', () => {
    const now = new Date('2026-05-18T15:00:00+09:00');
    const result = buildScheduleArrival('1', now);
    expect(result.up.every((t) => t.destination === '소요산')).toBe(true);
    expect(result.down.every((t) => t.destination === '인천')).toBe(true);
  });

  it('2호선(순환선)은 내선/외선순환을 행선지로 사용한다 (#471)', () => {
    const now = new Date('2026-05-18T15:00:00+09:00');
    const result = buildScheduleArrival('2', now);
    expect(result.up[0].destination).toBe('내선순환');
    expect(result.down[0].destination).toBe('외선순환');
  });

  it('terminal 데이터가 누락된 노선은 destination이 빈 문자열 (#471 fallback)', () => {
    // headway는 있지만 terminal은 없는 가상 케이스. lineTerminals.json을 비워 분기 강제.
    jest.isolateModules(() => {
      jest.doMock('../../data/lineTerminals.json', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { buildScheduleArrival: build } = require('../scheduleFallback');
      const now = new Date('2026-05-18T15:00:00+09:00');
      const result = build('1', now);
      expect(result.source).toBe('schedule');
      expect(result.up[0].destination).toBe('');
      expect(result.down[0].destination).toBe('');
    });
    // isolateModules는 자체 레지스트리를 사용하지만 doMock 잔존 방지를 위해 명시적 reset.
    jest.resetModules();
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

describe('hasTerminalData', () => {
  it('returns true for all current LineNumber values', () => {
    const lines: LineNumber[] = [
      '1', '2', '3', '4', '5', '6', '7', '8', '9',
      'airport', 'gyeongui', 'bundang', 'sinbundang',
    ];
    for (const line of lines) {
      expect(hasTerminalData(line)).toBe(true);
    }
  });

  it('returns false for an unknown line', () => {
    expect(hasTerminalData('gtx-a' as LineNumber)).toBe(false);
  });
});
