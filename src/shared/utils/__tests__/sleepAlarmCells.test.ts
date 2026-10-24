/**
 * #3100 — 취침 알람 칸 순수 함수 table. 최대치는 호출 시점에 상수에서 읽으므로 `max` 인자 / 상수 mock
 * 두 방식으로 MAX=3, MAX=4를 모두 검증한다.
 */
import {
  crossingForSingleAdvance,
  expandSleepAlarmStops,
  normalizeSleepAlarmConfig,
  selectSleepAlarmFire,
  sleepAlarmStopOptions,
  sleepAlarmSuffix,
} from '../sleepAlarmCells';

describe('normalizeSleepAlarmConfig — 정리·거부', () => {
  const MAX3 = 3;

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['문자열', '3'],
    ['숫자', 3],
    ['빈 객체', {}],
    ['stops 없음', { mode: 'selected' }],
    ['stops 비배열', { mode: 'selected', stops: '3' }],
    ['stops null', { mode: 'selected', stops: null }],
    ['mode 없음', { stops: [3] }],
    ['mode 미지원', { mode: 'all', stops: [3] }],
    ['범위 하한 밖 [0]', { mode: 'selected', stops: [0] }],
    ['범위 상한 밖 [MAX+1]', { mode: 'selected', stops: [MAX3 + 1] }],
    ['음수', { mode: 'selected', stops: [-1] }],
    ['비정수', { mode: 'selected', stops: [1.5] }],
    ['문자열 원소', { mode: 'selected', stops: ['3'] }],
    ['빈 배열', { mode: 'selected', stops: [] }],
  ])('거부 -> undefined (기본값): %s', (_name, raw) => {
    expect(normalizeSleepAlarmConfig(raw, MAX3)).toBeUndefined();
  });

  it.each([
    ['선택 {1} = 기본과 동등', { mode: 'selected', stops: [1] }],
    ['매 역 시작 1 = 기본과 동등', { mode: 'every', stops: [1] }],
    ['선택 {1,1} 중복 정리 후 기본과 동등', { mode: 'selected', stops: [1, 1] }],
  ])('기본값과 같은 설정은 undefined(필드 없음): %s', (_name, raw) => {
    expect(normalizeSleepAlarmConfig(raw, MAX3)).toBeUndefined();
  });

  it.each([
    ['선택 {3,1}', { mode: 'selected', stops: [3, 1] }, { mode: 'selected', stops: [3, 1] }],
    ['정렬(오름차순 입력) -> 내림차순', { mode: 'selected', stops: [1, 3] }, { mode: 'selected', stops: [3, 1] }],
    ['중복 제거', { mode: 'selected', stops: [3, 3, 2] }, { mode: 'selected', stops: [3, 2] }],
    ['범위 밖 원소만 걸러냄', { mode: 'selected', stops: [3, 0, 9] }, { mode: 'selected', stops: [3] }],
    ['매 역은 시작 N 하나만', { mode: 'every', stops: [3, 2] }, { mode: 'every', stops: [3] }],
    ['매 역 시작 2', { mode: 'every', stops: [2] }, { mode: 'every', stops: [2] }],
    ['선택 {2}', { mode: 'selected', stops: [2] }, { mode: 'selected', stops: [2] }],
  ])('정규화: %s', (_name, raw, expected) => {
    expect(normalizeSleepAlarmConfig(raw, MAX3)).toEqual(expected);
  });

  it('최대치는 인자로 바꿀 수 있다 — MAX=4면 4가 유효, MAX=3이면 거부', () => {
    expect(normalizeSleepAlarmConfig({ mode: 'every', stops: [4] }, 4)).toEqual({ mode: 'every', stops: [4] });
    expect(normalizeSleepAlarmConfig({ mode: 'every', stops: [4] }, MAX3)).toBeUndefined();
  });

  it('입력 객체를 변형하지 않는다', () => {
    const raw = { mode: 'selected', stops: [1, 3, 3] };
    normalizeSleepAlarmConfig(raw, MAX3);
    expect(raw.stops).toEqual([1, 3, 3]);
  });
});

describe('expandSleepAlarmStops', () => {
  it('설정 없음 -> [MIN]', () => {
    expect(expandSleepAlarmStops(undefined)).toEqual([1]);
  });
  it('선택 -> 그대로(내림차순)', () => {
    expect(expandSleepAlarmStops({ mode: 'selected', stops: [3, 1] })).toEqual([3, 1]);
  });
  it('매 역 시작 N -> N..MIN 전부', () => {
    expect(expandSleepAlarmStops({ mode: 'every', stops: [3] })).toEqual([3, 2, 1]);
    expect(expandSleepAlarmStops({ mode: 'every', stops: [2] })).toEqual([2, 1]);
    expect(expandSleepAlarmStops({ mode: 'every', stops: [4] })).toEqual([4, 3, 2, 1]);
  });
});

describe('selectSleepAlarmFire — to <= N < from 인 N이 있으면 실제 남은 수(to) 하나', () => {
  it.each([
    // [stops, from, to, expected]
    [[1], 2, 1, 1], // 기본값: 직전 역 전진
    [[1], 3, 2, undefined], // 기본값은 2역 전을 안 건드린다
    [[1], 4, 1, 1], // 점프로 1역 전이 소비됨 -> catch-up 1회
    [[1], 4, 2, undefined], // 점프했지만 1역 전은 아직 남음
    [[3], 4, 3, 3], // 3역 전 도달
    [[3], 3, 2, undefined], // N < from 경계: N == from 이면 이미 지난 칸
    [[3, 1], 2, 1, 1],
    [[3, 1], 4, 3, 3],
    [[3, 1], 5, 2, 2], // 3역 전을 건너뜀 -> 실제 남은 수로 1회
    [[3, 1], 5, 1, 1], // 3과 1 모두 걸치지만 1회(실제 남은 수)
    [[3, 2, 1], 3, 2, 2], // 매 역: 각 전진이 자기 칸
    [[3, 2, 1], 2, 1, 1],
    [[2], 3, 2, 2],
    [[2], 2, 1, undefined],
  ] as [number[], number, number, number | undefined][])(
    'stops %j, from %i, to %i -> %s',
    (stops, fromRemaining, toRemaining, expected) => {
      expect(selectSleepAlarmFire(stops, { fromRemaining, toRemaining })).toBe(expected);
    },
  );
});

describe('crossingForSingleAdvance', () => {
  it.each([1, 2, 3, 4])('to %i -> {from: to+1, to}', (toRemaining) => {
    expect(crossingForSingleAdvance(toRemaining)).toEqual({ fromRemaining: toRemaining + 1, toRemaining });
  });
});

describe('sleepAlarmSuffix', () => {
  it('MIN은 접미사 없음(기본값 바이트 동일), 그 외 s{N}', () => {
    expect(sleepAlarmSuffix(1)).toBe('');
    expect(sleepAlarmSuffix(2)).toBe('s2');
    expect(sleepAlarmSuffix(3)).toBe('s3');
    expect(sleepAlarmSuffix(4)).toBe('s4');
  });
});

describe('sleepAlarmStopOptions — 행 수는 MAX - MIN + 1', () => {
  it('인자 max에서 파생', () => {
    expect(sleepAlarmStopOptions(3)).toEqual([3, 2, 1]);
    expect(sleepAlarmStopOptions(4)).toEqual([4, 3, 2, 1]);
  });

  it('인자 생략 시 상수 최대치를 호출 시점에 읽는다 (MAX 변형 mock)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../constants/sleepAlarm', () => ({
        ...jest.requireActual('../../constants/sleepAlarm'),
        SLEEP_ALARM_MAX_STOPS_BEFORE: 4,
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const cells = require('../sleepAlarmCells') as typeof import('../sleepAlarmCells');
      expect(cells.sleepAlarmStopOptions()).toEqual([4, 3, 2, 1]);
      expect(cells.normalizeSleepAlarmConfig({ mode: 'every', stops: [4] })).toEqual({ mode: 'every', stops: [4] });
    });
    jest.dontMock('../../constants/sleepAlarm');
  });

  it('원본 상수(MAX=3) 기본', () => {
    expect(sleepAlarmStopOptions()).toEqual([3, 2, 1]);
  });
});
