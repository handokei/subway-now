import {
  calculateBoardableTrainETA,
  decideBufferSeconds,
  waitMinutesFromBoardable,
} from '../calculateBoardableTrainETA';
import type { BoardableDeparture } from '../../../../shared/utils/timetableShared';

describe('decideBufferSeconds (#1480 정정 1 — transferTimes 기반 동적 분기)', () => {
  it.each([
    [0, 10],
    [30, 10],
    [60, 10],
    [61, 20],
    [120, 20],
    [180, 20],
    [181, 30],
    [240, 30],
    [300, 30],
    [301, 60],
    [480, 60],
    [600, 60],
  ])('walking %ds → buffer %ds', (walkingSeconds, expected) => {
    expect(decideBufferSeconds(walkingSeconds)).toBe(expected);
  });
});

describe('waitMinutesFromBoardable', () => {
  it.each([
    [0, 0],
    [30, 1], // 30s → 1분 (Math.ceil)
    [60, 1],
    [61, 2],
    [600, 10],
    [630, 11], // 10.5분 → 11분
  ])('%ds wait → %d minutes (ceil)', (waitSeconds, expectedMinutes) => {
    const departure: BoardableDeparture = {
      departureMinutes: 720,
      departureLabel: '12:00',
      waitSeconds,
      missedCount: 0,
      isNextDayFallback: false,
    };
    expect(waitMinutesFromBoardable(departure)).toBe(expectedMinutes);
  });
});

describe('calculateBoardableTrainETA', () => {
  // KST 평일 12:00 — 시청역 1호선 timetable에 다수 발차 보장.
  const KST_WEEKDAY_NOON = new Date('2026-06-09T03:00:00.000Z');

  it('returns ok with boardable departure for supported line/station/direction', () => {
    const result = calculateBoardableTrainETA({
      arrivalAt: KST_WEEKDAY_NOON,
      bufferSeconds: 20,
      nextLeg: { stationName: '시청', line: '1', direction: 'up' },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.departure.waitSeconds).toBeGreaterThanOrEqual(0);
    expect(result.effectiveArrivalAt.getTime()).toBe(
      KST_WEEKDAY_NOON.getTime() + 20 * 1000,
    );
  });

  it('returns no-timetable for unsupported line (bundang)', () => {
    const result = calculateBoardableTrainETA({
      arrivalAt: KST_WEEKDAY_NOON,
      bufferSeconds: 10,
      nextLeg: { stationName: '왕십리', line: 'bundang', direction: 'up' },
    });
    expect(result.status).toBe('no-timetable');
  });

  it('returns station-missing when station name not in timetable + logs debug', () => {
    const result = calculateBoardableTrainETA({
      arrivalAt: KST_WEEKDAY_NOON,
      bufferSeconds: 10,
      nextLeg: { stationName: '존재하지않는역', line: '1', direction: 'up' },
    });
    expect(result.status).toBe('station-missing');
  });

  it('returns day-type-unknown when arrivalAt is invalid Date', () => {
    const result = calculateBoardableTrainETA({
      arrivalAt: new Date('invalid'),
      bufferSeconds: 10,
      nextLeg: { stationName: '시청', line: '1', direction: 'up' },
    });
    expect(result.status).toBe('day-type-unknown');
  });

  it('user 시나리오 (#1480 본문) — 도착 1분 후 열차 = miss + 10분 후 boardable', () => {
    // 정적 mock으로 시나리오 격리. line-1.json mock 후 module re-load.
    jest.isolateModules(() => {
      const SCENARIO = {
        weekday: {
          up: ['1201', '1210', '1220'], // 12:01 직전 도착(=12:00) 시 12:01은 buffer 적용 후 못 탐, 12:10이 boardable
          down: ['1200'],
        },
        saturday: { up: ['1201'], down: ['1200'] },
        sunday: { up: ['1201'], down: ['1200'] },
      };
      jest.doMock('../../../../data/timetables/line-1.json', () => ({
        stations: { scenarioStation: SCENARIO },
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { calculateBoardableTrainETA: fn } = require('../calculateBoardableTrainETA');

      // 환승역 도착 = KST 12:00 (now + 도보 0초 가정). buffer 60초 + 도보 0초 추가 = effective 12:01.
      // 12:01은 boardable? — boardable lookup은 >= 비교, 같은 분이면 boardable.
      // 그러나 사용자 시나리오는 "1분 후 미탑승" — 즉 buffer가 더 커서 12:01을 못 타고 12:10이 boardable.
      // KST 12:00 + buffer 120s = 12:02. 12:01은 missed, 12:10이 boardable (8분 = 480s 대기).
      const result = fn({
        arrivalAt: new Date('2026-06-09T03:00:00.000Z'), // KST 12:00
        bufferSeconds: 120, // 2분 buffer
        nextLeg: { stationName: 'scenarioStation', line: '1', direction: 'up' },
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.departure.departureLabel).toBe('12:10');
      expect(result.departure.missedCount).toBe(1); // 12:01 missed
      // 12:02 effective → 12:10 boardable = 8분 = 480초
      expect(result.departure.waitSeconds).toBe(8 * 60);
    });
    jest.resetModules();
  });
});
