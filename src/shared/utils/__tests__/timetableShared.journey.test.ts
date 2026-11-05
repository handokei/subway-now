import { findBoardableDeparture } from '../timetableShared';

// 정적 mock 시간표로 전날 꼬리 데이터 이상(파싱 불가/미운행 슬롯)을 시뮬레이션 — 실 timetable과 격리.
function withMockedLine1(stations: Record<string, unknown>, call: (fn: typeof findBoardableDeparture) => void): void {
  jest.isolateModules(() => {
    jest.doMock('../../../data/timetables/line-1.json', () => ({ stations }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { findBoardableDeparture: build } = require('../timetableShared');
    call(build);
  });
  jest.resetModules();
}

// #1480 PR-C — 환승 대기 시간표 조회 결함 N2(역명 정규화) / N4(다음 운행일) / N5(자정 이후 전날 24xx 꼬리).
// 모든 시각은 KST 고정 주입(결정적). 기대값은 src/data/timetables 실데이터에서 읽은 값이다.

/** KST 벽시계 → Date. */
function kst(y: number, mo: number, d: number, h: number, mi: number, s = 0): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - 9 * 3_600_000);
}

describe('N2 — 역명 정규화 조회 (stations.json 표기 ≠ timetable 키)', () => {
  const from = kst(2026, 10, 28, 12, 0); // 수요일 정오

  it('"군자(능동)"(stations.json 표기)도 timetable 키 "군자"로 조회된다 (정확일치 miss였음)', () => {
    const result = findBoardableDeparture({ stationName: '군자(능동)', line: '7', direction: 'down', from });
    expect(result.status).toBe('ok');
  });

  it('정규화 전 표기("군자")와 같은 결과', () => {
    const viaParen = findBoardableDeparture({ stationName: '군자(능동)', line: '7', direction: 'down', from });
    const plain = findBoardableDeparture({ stationName: '군자', line: '7', direction: 'down', from });
    expect(viaParen).toEqual(plain);
  });

  it('존재하지 않는 역은 여전히 station-missing', () => {
    expect(
      findBoardableDeparture({ stationName: '없는역(없음)', line: '7', direction: 'down', from }).status,
    ).toBe('station-missing');
  });
});

describe('N4 — 막차 후 다음 운행일 첫차는 실제 다음 날의 요일로 고른다', () => {
  // 1호선 소요산 down: 평일 첫차 0546 / 토요일 첫차 0545, 평일 막차 2347 (꼬리 없음).
  it('목요일 23:50 막차 후 → 금요일(weekday) 첫차 05:46 (토요일 05:45 아님)', () => {
    const result = findBoardableDeparture({
      stationName: '소요산',
      line: '1',
      direction: 'down',
      from: kst(2026, 10, 29, 23, 50),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.departure.isNextDayFallback).toBe(true);
    expect(result.departure.departureLabel).toBe('05:46');
    // 23:50 → 익일 05:46 = 5h56m
    expect(result.departure.waitSeconds).toBe(356 * 60);
  });

  it('금요일 23:50 → 토요일 첫차 05:45', () => {
    const result = findBoardableDeparture({
      stationName: '소요산',
      line: '1',
      direction: 'down',
      from: kst(2026, 10, 30, 23, 50),
    });
    expect(result.status === 'ok' && result.departure.departureLabel).toBe('05:45');
  });

  it('일요일 23:50 → 월요일(weekday) 첫차 05:46', () => {
    const result = findBoardableDeparture({
      stationName: '소요산',
      line: '1',
      direction: 'down',
      from: kst(2026, 11, 1, 23, 50),
    });
    expect(result.status === 'ok' && result.departure.departureLabel).toBe('05:46');
  });
});

describe('N5 — 자정 이후에는 전날 시간표의 24xx 꼬리를 먼저 본다', () => {
  // 2호선 신림 down 평일 꼬리: 2404, 2419, 2436, 2456.
  it('목요일 00:20 → 전날(수요일) 2436 (=00:36), 같은 날 새벽 첫차가 아님', () => {
    const result = findBoardableDeparture({
      stationName: '신림',
      line: '2',
      direction: 'down',
      from: kst(2026, 10, 29, 0, 20),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.departure.isNextDayFallback).toBe(false);
    expect(result.departure.departureMinutes).toBe(24 * 60 + 36);
    expect(result.departure.departureLabel).toBe('00:36');
    expect(result.departure.waitSeconds).toBe(16 * 60);
  });

  it('꼬리가 모두 지난 시각(01:30)에는 같은 날 첫차(새벽)로 진행한다', () => {
    const result = findBoardableDeparture({
      stationName: '신림',
      line: '2',
      direction: 'down',
      from: kst(2026, 10, 29, 1, 30),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.departure.departureMinutes).toBeLessThan(24 * 60);
  });
});

describe('초 단위 정밀 대기', () => {
  it('같은 분 안에서 초가 지나면 대기는 0으로 clamp (ADR-010 동일 분 허용)', () => {
    // 2호선 건대입구 down 06:41 — 06:41:30에 도착해도 같은 분 열차는 boardable, 대기 0.
    const result = findBoardableDeparture({
      stationName: '건대입구',
      line: '2',
      direction: 'down',
      from: kst(2026, 10, 28, 6, 41, 30),
    });
    expect(result.status === 'ok' && result.departure.waitSeconds).toBe(0);
  });

  it('06:39:29 → 06:41 열차까지 91초', () => {
    const result = findBoardableDeparture({
      stationName: '건대입구',
      line: '2',
      direction: 'down',
      from: kst(2026, 10, 28, 6, 39, 29),
    });
    expect(result.status === 'ok' && result.departure.waitSeconds).toBe(91);
  });
});

describe('N5 — 전날 꼬리의 비정상 엔트리는 건너뛴다', () => {
  it('미운행 슬롯·파싱 불가·24시 이전 엔트리를 무시하고 유효한 꼬리만 고른다', () => {
    const day = { up: ['0600', '2300', '0000', 'xx', '2430'], down: ['0610'] };
    const stations = { 테스트역: { weekday: day, saturday: day, sunday: day } };
    withMockedLine1(stations, (fn) => {
      const result = fn({ stationName: '테스트역', line: '1', direction: 'up', from: kst(2026, 10, 29, 0, 20) });
      expect(result.status === 'ok' && result.departure.departureMinutes).toBe(24 * 60 + 30);
    });
  });
});
