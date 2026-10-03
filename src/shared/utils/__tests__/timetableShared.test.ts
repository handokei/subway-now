import {
  classifyDayTypeKst,
  findBoardableDeparture,
  formatMinutesAsHHmm,
  hasTimetable,
  nextDayType,
} from '../timetableShared';

// KST 시간대 명시 — UTC+9 (KST 정오 = UTC 03:00). 본 테스트는 stations.json/timetables JSON에
// 의존하지 않고 module mock으로 격리해 데이터 drift에 강하게 작성한다.

const KST_WEEKDAY_NOON = new Date('2026-06-09T03:00:00.000Z'); // 화요일 12:00 KST
const KST_SATURDAY_NOON = new Date('2026-06-13T03:00:00.000Z'); // 토요일 12:00 KST
const KST_SUNDAY_NOON = new Date('2026-06-14T03:00:00.000Z'); // 일요일 12:00 KST

// 정적 mock으로 막차 직후 시각을 시뮬레이션. 실 timetable에 의존하지 않게 격리.
function withMockedLine1(
  stations: Record<string, unknown>,
  call: (fn: typeof findBoardableDeparture) => void,
): void {
  jest.isolateModules(() => {
    jest.doMock('../../../data/timetables/line-1.json', () => ({ stations }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { findBoardableDeparture: build } = require('../timetableShared');
    call(build);
  });
  jest.resetModules();
}

describe('timetableShared - classifyDayTypeKst', () => {
  it.each([
    [KST_WEEKDAY_NOON, 'weekday'],
    [KST_SATURDAY_NOON, 'saturday'],
    [KST_SUNDAY_NOON, 'sunday'],
  ] as const)('classifies %s → %s', (date, expected) => {
    expect(classifyDayTypeKst(date)).toBe(expected);
  });

  it('returns null when Intl weekday part is unavailable (#1088 regression guard)', () => {
    // getWeekdayShort가 내부에서 try/catch로 null 처리하는 경로 — Date 대신 임의 object로 시뮬레이션.
    // 실제로 Hermes에서 발생할 수 있는 weekday part 누락은 intlDateParts module이 흡수해 null 반환.
    const wrappedDate = new Date('invalid-date'); // NaN getTime — Intl.DateTimeFormat이 throw
    expect(classifyDayTypeKst(wrappedDate)).toBeNull();
  });
});

describe('timetableShared - nextDayType', () => {
  it.each([
    ['weekday', 'saturday'],
    ['saturday', 'sunday'],
    ['sunday', 'weekday'],
  ] as const)('rolls %s → %s', (current, expected) => {
    expect(nextDayType(current)).toBe(expected);
  });
});

describe('timetableShared - formatMinutesAsHHmm', () => {
  it.each([
    [0, '00:00'],
    [60, '01:00'],
    [600, '10:00'],
    [1439, '23:59'],
    [1440, '00:00'], // 24h+ — % 1440 정규화
    [1500, '01:00'], // 25:00 → 01:00
    [-30, '23:30'], // 음수도 graceful — 다음날 23:30로 wrap (clamp 미적용 케이스 가드)
  ])('formats %d minutes → %s', (minutes, expected) => {
    expect(formatMinutesAsHHmm(minutes)).toBe(expected);
  });
});

describe('timetableShared - hasTimetable', () => {
  it.each(['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const)(
    'has timetable for line %s',
    (line) => {
      expect(hasTimetable(line)).toBe(true);
    },
  );

  it.each(['bundang', 'airport', 'gyeongui', 'sinbundang'] as const)(
    'does not have timetable for line %s',
    (line) => {
      expect(hasTimetable(line)).toBe(false);
    },
  );
});

describe('timetableShared - findBoardableDeparture', () => {
  // 시청역 (1호선) 평일 12:00 KST 기준 — 시점 이후 첫 발차 lookup.
  it('finds first departure at or after the reference time', () => {
    const result = findBoardableDeparture({
      stationName: '시청',
      line: '1',
      direction: 'up',
      from: KST_WEEKDAY_NOON,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // 12:00 이후 발차는 12:00 시각 그 자체 또는 이후 정수 분.
    expect(result.departure.departureMinutes).toBeGreaterThanOrEqual(720); // 12:00 = 720분
    expect(result.departure.departureLabel).toMatch(/^\d{2}:\d{2}$/);
    expect(result.departure.waitSeconds).toBeGreaterThanOrEqual(0);
    expect(result.departure.missedCount).toBeGreaterThanOrEqual(0);
    expect(result.departure.isNextDayFallback).toBe(false);
  });

  it('returns no-timetable for unsupported line (bundang, airport, etc.)', () => {
    const result = findBoardableDeparture({
      stationName: '왕십리',
      line: 'bundang',
      direction: 'up',
      from: KST_WEEKDAY_NOON,
    });
    expect(result.status).toBe('no-timetable');
  });

  it('returns station-missing when station name not in timetable', () => {
    const result = findBoardableDeparture({
      stationName: '존재하지않는역',
      line: '1',
      direction: 'up',
      from: KST_WEEKDAY_NOON,
    });
    expect(result.status).toBe('station-missing');
  });

  it('returns day-type-unknown when Date is invalid (#1088 guard)', () => {
    const result = findBoardableDeparture({
      stationName: '시청',
      line: '1',
      direction: 'up',
      from: new Date('invalid'),
    });
    expect(result.status).toBe('day-type-unknown');
  });

  it('counts missed departures before reference time', () => {
    // 평일 정오에는 새벽~정오 사이 다수 발차가 있어 missedCount > 0 보장.
    const result = findBoardableDeparture({
      stationName: '시청',
      line: '1',
      direction: 'up',
      from: KST_WEEKDAY_NOON,
    });
    if (result.status !== 'ok') {
      throw new Error('precondition: timetable lookup must succeed at noon');
    }
    expect(result.departure.missedCount).toBeGreaterThan(0);
  });

  describe('막차 후 → 다음 운행일 첫차 fallback', () => {
    it('falls back to next-day first departure when current-day timetable exhausted', () => {
      const SIMPLE_TIMETABLE = {
        weekday: { up: ['0600', '2300'], down: ['0610', '2250'] },
        saturday: { up: ['0700'], down: ['0710'] },
        sunday: { up: ['0700'], down: ['0710'] },
      };
      // 평일 23:30 KST — 막차 23:00 이후. 다음 운행일(=토요일) 07:00 첫차로 fallback.
      const WEEKDAY_AFTER_LAST = new Date('2026-06-12T14:30:00.000Z'); // 금요일 23:30 KST
      withMockedLine1({ 'testStation': SIMPLE_TIMETABLE }, (fn) => {
        const result = fn({
          stationName: 'testStation',
          line: '1',
          direction: 'up',
          from: WEEKDAY_AFTER_LAST,
        });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        expect(result.departure.isNextDayFallback).toBe(true);
        expect(result.departure.departureLabel).toBe('07:00');
        // 평일 23:30 (=1410분) → 토요일 07:00 (=420분 + 1440 = 1860분). 대기 450분 = 27000초.
        expect(result.departure.waitSeconds).toBe(450 * 60);
        expect(result.departure.missedCount).toBe(0);
      });
    });

    it('returns no-departures when both current and next day timetables empty', () => {
      const EMPTY_TIMETABLE = {
        weekday: { up: ['0000'], down: ['0000'] },
        saturday: { up: ['0000'], down: ['0000'] },
        sunday: { up: ['0000'], down: ['0000'] },
      };
      withMockedLine1({ 'emptyStation': EMPTY_TIMETABLE }, (fn) => {
        const result = fn({
          stationName: 'emptyStation',
          line: '1',
          direction: 'up',
          from: new Date('2026-06-12T14:30:00.000Z'),
        });
        expect(result.status).toBe('no-departures');
      });
    });

    it('skips malformed entries (non-4-digit, non-numeric, partial NaN) gracefully', () => {
      const MALFORMED_TIMETABLE = {
        // 다양한 malformed 형식 — length!=4 + hour NaN 단독 + minute NaN 단독 분기 보강.
        weekday: { up: ['xxx', '1a00', '0a3b', '2500', '0700'], down: ['0610'] },
        saturday: { up: ['0700'], down: ['0710'] },
        sunday: { up: ['0700'], down: ['0710'] },
      };
      // 새벽 06:00 KST — 'xxx'(파싱 실패) skip + '2500' = 1500분 (이미 어제 새벽), '0700' = 420분이 첫 boardable
      const KST_DAWN = new Date('2026-06-08T21:00:00.000Z'); // 월요일 06:00 KST
      withMockedLine1({ 'malformedStation': MALFORMED_TIMETABLE }, (fn) => {
        const result = fn({
          stationName: 'malformedStation',
          line: '1',
          direction: 'up',
          from: KST_DAWN,
        });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        // 06:00 = 360분. timetable entries: 'xxx'(skip), '2500'=1500분(>=360 → boardable), '0700'=420분
        // 첫 boardable은 timetable 순서 그대로 — '2500' 등장. 분 = 1500.
        expect(result.departure.departureMinutes).toBe(1500);
      });
    });

    it('falls back to next-day first when only malformed entries on current day', () => {
      // 익일 entry도 일부 malformed — 유효 entry skip 분기 보강 (line coverage).
      const PARTIALLY_MALFORMED = {
        weekday: { up: ['0500'], down: ['0510'] },
        saturday: { up: ['xx', '0000', '0700'], down: ['0710'] },
        sunday: { up: ['0700'], down: ['0710'] },
      };
      // 금요일 23:30 KST — 평일 entry 0500은 이미 지나감(=300<1410). 다음날=saturday로 fallback.
      // saturday entries: 'xx'(파싱 실패 skip), '0000'(미운행 skip), '0700' 첫 보드러블.
      const FRI_AFTER_LAST = new Date('2026-06-12T14:30:00.000Z'); // 금요일 23:30 KST
      withMockedLine1({ 'partialStation': PARTIALLY_MALFORMED }, (fn) => {
        const result = fn({
          stationName: 'partialStation',
          line: '1',
          direction: 'up',
          from: FRI_AFTER_LAST,
        });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        expect(result.departure.isNextDayFallback).toBe(true);
        expect(result.departure.departureLabel).toBe('07:00');
      });
    });

    it('returns day-type-unknown when KST hour part is unparseable', () => {
      // Intl.DateTimeFormat이 정상 작동하는 케이스 + Date 자체가 invalid →
      // getKstMinutesOfDay가 null 반환하는 분기 보강. classifyDayTypeKst는 이미 다른 it()에서 null 분기 커버.
      // 본 분기는 day-type만 분리 보강.
      const result = findBoardableDeparture({
        stationName: '시청',
        line: '1',
        direction: 'up',
        from: new Date(Number.NaN),
      });
      expect(result.status).toBe('day-type-unknown');
    });
  });
});
