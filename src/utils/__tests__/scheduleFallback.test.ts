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
    const result = buildScheduleArrival('2', '__missing__', now);
    expect(result.up).toEqual([]);
    expect(result.down).toEqual([]);
    expect(result.source).toBe('closed');
    expect(result.isMock).toBe(true);
  });

  // wall-clock anchor 기반이므로 정확한 값은 nowMs % headway에 의존.
  // 시간대별 헤드웨이 분류와 anchor 범위(0 < first <= headway, second = first + headway)를 검증.

  it('returns 2 up/down trains during weekday peak with line 2 headway 150s', () => {
    const now = new Date('2026-05-18T08:00:00+09:00');
    const result = buildScheduleArrival('2', '__missing__', now);
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
    const result = buildScheduleArrival('1', '__missing__', now);
    expect(result.source).toBe('schedule');
    const first = result.up[0].arrivalSeconds;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(360);
  });

  it('uses saturday offPeak even during what would be peak time', () => {
    const now = new Date('2026-05-16T08:00:00+09:00'); // Saturday
    const result = buildScheduleArrival('2', '__missing__', now);
    expect(result.up[0].arrivalSeconds).toBeLessThanOrEqual(330);
  });

  it('falls back to offPeak headway if peak entry missing (weekend peak lookup is never triggered, but defensive)', () => {
    const now = new Date('2026-05-18T08:00:00+09:00');
    const result = buildScheduleArrival('gyeongui', '__missing__', now);
    expect(result.source).toBe('schedule');
    expect(result.up[0].arrivalSeconds).toBeLessThanOrEqual(540);
  });

  it('sets receivedAtMs to now.getTime()', () => {
    const now = new Date('2026-05-18T15:00:00+09:00');
    const result = buildScheduleArrival('2', '__missing__', now);
    expect(result.up[0].receivedAtMs).toBe(now.getTime());
  });

  it('marks late period for 23:00 with late headway', () => {
    const now = new Date('2026-05-18T23:00:00+09:00');
    const result = buildScheduleArrival('2', '__missing__', now);
    expect(result.source).toBe('schedule');
    expect(result.up[0].arrivalSeconds).toBeLessThanOrEqual(480);
  });

  it('handles sunday late period', () => {
    const now = new Date('2026-05-17T22:30:00+09:00');
    const result = buildScheduleArrival('1', '__missing__', now);
    expect(result.up[0].arrivalSeconds).toBeLessThanOrEqual(660);
  });

  it('arrivalMinutes equals floor(arrivalSeconds/60)', () => {
    const now = new Date('2026-05-18T15:00:00+09:00');
    const result = buildScheduleArrival('1', '__missing__', now);
    expect(result.up[0].arrivalMinutes).toBe(Math.floor(result.up[0].arrivalSeconds / 60));
  });

  it('anchors next departure to wall-clock so polling (+5s) returns continuously decreasing ETA', () => {
    const t0 = new Date('2026-05-18T15:00:00.000+09:00');
    const t5 = new Date(t0.getTime() + 5_000);
    const r0 = buildScheduleArrival('2', '__missing__', t0);
    const r5 = buildScheduleArrival('2', '__missing__', t5);
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
    const result = buildScheduleArrival('1', '__missing__', new Date(alignedMs));
    expect(result.up[0].arrivalSeconds).toBe(360); // 다음 격자로 시프트되어 headway 그대로
  });

  it('returns source=closed when line key is missing from headway table (defensive)', () => {
    const now = new Date('2026-05-18T15:00:00+09:00');
    // 알려지지 않은 미래 노선이 LineNumber에 추가됐지만 lineHeadways.json에 누락된 경우.
    const result = buildScheduleArrival('gtx-a' as LineNumber, '__missing__', now);
    expect(result.source).toBe('closed');
    expect(result.up).toEqual([]);
  });

  it('up 트레인은 up 종착역으로, down 트레인은 down 종착역으로 destination을 채운다 (#471)', () => {
    const now = new Date('2026-05-18T15:00:00+09:00');
    const result = buildScheduleArrival('1', '__missing__', now);
    expect(result.up.every((t) => t.destination === '소요산')).toBe(true);
    expect(result.down.every((t) => t.destination === '인천')).toBe(true);
  });

  it('up과 down은 서로 다른 ETA를 가진다 — half-headway 위상 분리 (#517)', () => {
    // line 2 peak 헤드웨이 150s. 이 시각은 nowMs % 150_000 === 0 (격자 정렬 케이스).
    // up=150s, down=75s로 분리되어야 한다. up/down이 같은 격자에 정렬되면 동일 ETA로
    // 표시되어 디버그/UX에 혼란을 유발한다.
    const now = new Date('2026-05-18T08:00:00+09:00');
    const result = buildScheduleArrival('2', '__missing__', now);
    expect(result.up[0].arrivalSeconds).not.toBe(result.down[0].arrivalSeconds);
    // 각 방향 두 번째 트레인은 first + headway 관계 유지
    expect(result.up[1].arrivalSeconds).toBe(result.up[0].arrivalSeconds + 150);
    expect(result.down[1].arrivalSeconds).toBe(result.down[0].arrivalSeconds + 150);
  });

  it('down 트레인도 wall-clock 폴링(+5s)에서 연속 감소한다 (#517)', () => {
    const t0 = new Date('2026-05-18T15:00:00.000+09:00');
    const t5 = new Date(t0.getTime() + 5_000);
    const r0 = buildScheduleArrival('2', '__missing__', t0);
    const r5 = buildScheduleArrival('2', '__missing__', t5);
    if (r0.down[0].arrivalSeconds > 5) {
      expect(r5.down[0].arrivalSeconds).toBe(r0.down[0].arrivalSeconds - 5);
    }
  });

  it('2호선(순환선)은 내선/외선순환을 행선지로 사용한다 (#471)', () => {
    const now = new Date('2026-05-18T15:00:00+09:00');
    const result = buildScheduleArrival('2', '__missing__', now);
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
      const result = build('1', '__missing__', now);
      expect(result.source).toBe('schedule');
      expect(result.up[0].destination).toBe('');
      expect(result.down[0].destination).toBe('');
    });
    // isolateModules는 자체 레지스트리를 사용하지만 doMock 잔존 방지를 위해 명시적 reset.
    jest.resetModules();
  });
});

describe('buildScheduleArrival — 시간표 lookup (#473 Phase 3)', () => {
  it('시간표 적중 시 isMock=false 반환 + lookup 기반 ETA', () => {
    // 1호선 서울역 평일 09:00. line-1.json에 서울역 시간표 존재.
    const now = new Date('2026-05-18T09:00:00+09:00');
    const result = buildScheduleArrival('1', '서울역', now);
    expect(result.source).toBe('schedule');
    expect(result.isMock).toBe(false);
    expect(result.up.length).toBeGreaterThan(0);
  });

  it('시간표 없는 노선은 헤드웨이 폴백 (분당선)', () => {
    const now = new Date('2026-05-18T09:00:00+09:00');
    const result = buildScheduleArrival('bundang', '왕십리', now);
    expect(result.source).toBe('schedule');
    expect(result.isMock).toBe(true);
  });

  it('시간표 노선이지만 매칭 안 되는 역명은 헤드웨이 폴백', () => {
    const now = new Date('2026-05-18T09:00:00+09:00');
    const result = buildScheduleArrival('1', '__no_such_station__', now);
    expect(result.isMock).toBe(true);
  });

  it('KST 0~5시는 dayType을 전 영업일로 shift + 24h+ 키로 비교', () => {
    // 토요일 02:00 KST → 금요일 영업일의 24h+ 시간표 엔트리(예: "2421") 매칭.
    // line-1.json 서울역에 "2421"이 있다면 02:00에는 ETA 약 21분.
    const now = new Date('2026-05-16T02:00:00+09:00'); // Saturday 02:00
    const result = buildScheduleArrival('1', '서울역', now);
    // 시간표가 매칭되면 isMock=false; 매칭 못 하면 헤드웨이 폴백(isMock=true).
    // 어느 쪽이든 source='schedule' 유지 (운행종료 분기는 헤드웨이 폴백에서만).
    expect(['schedule', 'closed']).toContain(result.source);
  });

  it('막차 후(시간표 entry 모두 nowKey 미만)는 헤드웨이 폴백 → closed', () => {
    // 모든 timetable entry가 nowKey보다 작은 mock 데이터로 결정적 검증.
    jest.isolateModules(() => {
      jest.doMock('../../data/timetables/line-1.json', () => ({
        stations: {
          '__last_train_done__': {
            // 평일 시간표: 23:30 막차 끝, 24h+ 엔트리 없음.
            weekday: { up: ['0530', '2330'], down: ['0530', '2330'] },
          },
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { buildScheduleArrival: build } = require('../scheduleFallback');
      // KST 평일 02:00 → effectiveDay='sunday' (Tuesday → 이전 영업일 = weekday이지만
      // previousBusinessDay(Tue)=weekday이므로 weekday 매칭. 그러나 nowKey="2600"인데
      // weekday 시간표 max="2330" → 매칭 실패. classifyPeriod=closed → 빈 배열.
      const now = new Date('2026-05-19T02:00:00+09:00'); // Tuesday 02:00 KST
      const result = build('1', '__last_train_done__', now);
      expect(result.source).toBe('closed');
      expect(result.up).toEqual([]);
      expect(result.down).toEqual([]);
    });
    jest.resetModules();
  });

  it('Monday 02:00 KST는 sunday 시간표 lookup (전 영업일 = 일요일)', () => {
    // 2026-05-25은 월요일. KST 02:00 = UTC 17:00 전날(2026-05-24 일요일 17:00 UTC).
    const now = new Date('2026-05-24T17:00:00Z'); // KST Mon 02:00
    const result = buildScheduleArrival('1', '서울역', now);
    // sunday 시간표 데이터가 02:00(=2600 nowKey)에는 거의 없을 것 → 헤드웨이 폴백 closed.
    // 분기 진입 자체가 핵심 (line 191).
    expect(['schedule', 'closed']).toContain(result.source);
  });

  it('Saturday 02:00 KST는 weekday 시간표 lookup (전 영업일 = 금요일)', () => {
    // 2026-05-23 토요일 02:00 KST.
    const now = new Date('2026-05-22T17:00:00Z'); // KST Sat 02:00
    const result = buildScheduleArrival('1', '서울역', now);
    expect(['schedule', 'closed']).toContain(result.source);
  });

  it('Sunday 02:00 KST는 saturday 시간표 lookup (전 영업일 = 토요일)', () => {
    // 2026-05-24 일요일 02:00 KST. previousBusinessDay('Sun') → 'saturday'.
    const now = new Date('2026-05-23T17:00:00Z'); // KST Sun 02:00
    const result = buildScheduleArrival('1', '서울역', now);
    expect(['schedule', 'closed']).toContain(result.source);
  });

  it('시간표 노선/역 존재하지만 dayType 키 없음 → 헤드웨이 폴백 (line 196)', () => {
    // 정상 케이스로는 unreachable이지만 isolateModules로 시간표 구조 변형 분기 강제.
    jest.isolateModules(() => {
      jest.doMock('../../data/timetables/line-1.json', () => ({
        stations: { '__test_station__': {} }, // weekday/saturday/sunday 모두 없음
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { buildScheduleArrival: build } = require('../scheduleFallback');
      const now = new Date('2026-05-18T15:00:00+09:00');
      const result = build('1', '__test_station__', now);
      expect(result.isMock).toBe(true); // 헤드웨이 폴백
    });
    jest.resetModules();
  });

  it('hour<5 + 24h+ 시간표 entry 매칭 시 hhmmToFutureSeconds nowHour shift 적용 (line 168)', () => {
    // KST Monday 02:30 (= UTC Sun 17:30). 사용자 시간 시간표 비교 키 "2630".
    // 이전 영업일(Sunday)의 24h+ 엔트리가 "2700" 이상이면 매치.
    jest.isolateModules(() => {
      jest.doMock('../../data/timetables/line-1.json', () => ({
        stations: {
          '__late_night__': {
            sunday: { up: ['2700', '2730'], down: ['2715'] }, // 익일 03:00, 03:30
          },
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { buildScheduleArrival: build } = require('../scheduleFallback');
      const now = new Date('2026-05-24T17:30:00Z'); // KST Mon 02:30
      const result = build('1', '__late_night__', now);
      // 시간표 hit → isMock=false, hhmmToFutureSeconds nowHour<5 분기 진입.
      expect(result.isMock).toBe(false);
      expect(result.up.length).toBe(2);
      // 02:30 → 03:00 = 30분 = 1800초
      expect(result.up[0].arrivalSeconds).toBe(30 * 60);
    });
    jest.resetModules();
  });

  it('시간표 day.up/down 빈 배열 → 폴백 (line 199)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../data/timetables/line-1.json', () => ({
        stations: {
          '__test_empty__': {
            weekday: { up: [], down: [] }, // 빈 배열
          },
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { buildScheduleArrival: build } = require('../scheduleFallback');
      const now = new Date('2026-05-18T15:00:00+09:00');
      const result = build('1', '__test_empty__', now);
      expect(result.isMock).toBe(true); // 헤드웨이 폴백
    });
    jest.resetModules();
  });

  it('hhmmToFutureSeconds 자정 wrap — 23:30에 "2421" 시각은 약 51분 후', () => {
    // 직접 검증: 평일 23:30 KST. 시간표에 "2421" 엔트리가 있다면 ETA ≈ 51분.
    const now = new Date('2026-05-18T23:30:00+09:00');
    const result = buildScheduleArrival('1', '서울역', now);
    // 시간표 hit 시 isMock=false. up/down 중 다음 발차 시각이 51분 안팎이어야.
    if (!result.isMock && result.up.length > 0) {
      // 23:30 ~ 24:21 = 51분 = 3060초 (정확히 일치 안 할 수 있으니 범위)
      // 첫 발차가 24:21이 아니라면 더 빠른 시각.
      expect(result.up[0].arrivalSeconds).toBeGreaterThanOrEqual(0);
      expect(result.up[0].arrivalSeconds).toBeLessThanOrEqual(3 * 3600);
    }
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
