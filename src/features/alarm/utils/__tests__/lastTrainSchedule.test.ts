jest.mock('../../../../data/lastTrains.json', () => ({
  version: '1',
  lines: {
    '1': 'covered',
    '2': 'covered',
    '3': 'uncovered',
    '4': 'covered',
    '5': 'covered',
    '6': 'covered',
    '7': 'covered',
    '8': 'covered',
    '9': 'covered',
    airport: 'uncovered',
    gyeongui: 'uncovered',
    bundang: 'uncovered',
    sinbundang: 'uncovered',
  },
  stations: {
    '1-001': {
      weekday: { up: '00:36', down: '23:47' },
      saturday: { up: '00:27', down: '23:48' },
      sunday: { up: '00:27', down: null },
    },
    '2-009': {
      weekday: { up: '00:30' },
    },
  },
}));

import {
  classifyDayTypeKst,
  getLastTrainTime,
  isLineCovered,
  minutesUntilLastTrain,
  todayKstKey,
} from '../lastTrainSchedule';

describe('classifyDayTypeKst', () => {
  it('금요일 → weekday', () => {
    expect(classifyDayTypeKst(new Date('2026-06-26T05:00:00Z'))).toBe('weekday');
  });

  it('토요일 → saturday', () => {
    expect(classifyDayTypeKst(new Date('2026-06-27T05:00:00Z'))).toBe('saturday');
  });

  it('일요일 → sunday', () => {
    expect(classifyDayTypeKst(new Date('2026-06-28T05:00:00Z'))).toBe('sunday');
  });

  it('Intl 회귀 시 null', () => {
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementationOnce(() => {
      throw new Error('hermes');
    });
    expect(classifyDayTypeKst(new Date('2026-06-26T05:00:00Z'))).toBeNull();
    spy.mockRestore();
  });
});

describe('isLineCovered', () => {
  it('mock에서 covered인 노선은 true', () => {
    expect(isLineCovered('1')).toBe(true);
    expect(isLineCovered('2')).toBe(true);
  });

  it('uncovered인 노선은 false', () => {
    expect(isLineCovered('3')).toBe(false);
    expect(isLineCovered('airport')).toBe(false);
  });
});

describe('getLastTrainTime', () => {
  it('알려진 stationId × dayType × direction', () => {
    expect(
      getLastTrainTime({ stationsJsonId: '1-001', dayType: 'weekday', direction: 'up' }),
    ).toBe('00:36');
  });

  it('데이터셋에 없는 stationId → null', () => {
    expect(
      getLastTrainTime({ stationsJsonId: '99-999', dayType: 'weekday', direction: 'up' }),
    ).toBeNull();
  });

  it('해당 dayType이 없는 station → null', () => {
    expect(
      getLastTrainTime({ stationsJsonId: '2-009', dayType: 'saturday', direction: 'up' }),
    ).toBeNull();
  });

  it('direction이 미운행(null) → null', () => {
    expect(
      getLastTrainTime({ stationsJsonId: '1-001', dayType: 'sunday', direction: 'down' }),
    ).toBeNull();
  });

  it('해당 dayType은 있지만 direction key가 없는 경우 → null', () => {
    expect(
      getLastTrainTime({ stationsJsonId: '2-009', dayType: 'weekday', direction: 'down' }),
    ).toBeNull();
  });
});

describe('minutesUntilLastTrain', () => {
  it('자정 전 막차: 23:47 - 23:30 = 17분', () => {
    // KST 23:30 = UTC 14:30
    expect(
      minutesUntilLastTrain({
        lastTrainTime: '23:47',
        now: new Date('2026-06-26T14:30:00Z'),
      }),
    ).toBe(17);
  });

  it('자정 넘어가는 막차: 00:36 - 23:50(KST) = 46분', () => {
    expect(
      minutesUntilLastTrain({
        lastTrainTime: '00:36',
        now: new Date('2026-06-26T14:50:00Z'),
      }),
    ).toBe(46);
  });

  it('자정 직후 (00:30 KST) 같은 일자 새벽 막차 00:36 = 6분', () => {
    expect(
      minutesUntilLastTrain({
        lastTrainTime: '00:36',
        now: new Date('2026-06-26T15:30:00Z'),
      }),
    ).toBe(6);
  });

  it('막차 시각이 이미 지난 경우 음수', () => {
    expect(
      minutesUntilLastTrain({
        lastTrainTime: '23:00',
        now: new Date('2026-06-26T14:30:00Z'),
      }),
    ).toBe(-30);
  });

  it('"HH:MM" 형식이 아니면 null', () => {
    expect(
      minutesUntilLastTrain({
        lastTrainTime: 'abc',
        now: new Date('2026-06-26T14:30:00Z'),
      }),
    ).toBeNull();
  });

  it('범위 밖 시:분 → null', () => {
    expect(
      minutesUntilLastTrain({
        lastTrainTime: '25:99',
        now: new Date('2026-06-26T14:30:00Z'),
      }),
    ).toBeNull();
  });

  it('Intl 실패 → null', () => {
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementationOnce(() => {
      throw new Error('hermes');
    });
    expect(
      minutesUntilLastTrain({
        lastTrainTime: '23:47',
        now: new Date('2026-06-26T14:30:00Z'),
      }),
    ).toBeNull();
    spy.mockRestore();
  });

  it('hour/minute part 누락 → null', () => {
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementationOnce(
      () =>
        ({
          formatToParts: () => [{ type: 'literal', value: '-' }],
        }) as unknown as Intl.DateTimeFormat,
    );
    expect(
      minutesUntilLastTrain({
        lastTrainTime: '23:47',
        now: new Date('2026-06-26T14:30:00Z'),
      }),
    ).toBeNull();
    spy.mockRestore();
  });

  it('NaN hour/minute (Intl가 비숫자 반환) → null', () => {
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementationOnce(
      () =>
        ({
          formatToParts: () => [
            { type: 'hour', value: 'XX' },
            { type: 'minute', value: 'YY' },
          ],
        }) as unknown as Intl.DateTimeFormat,
    );
    expect(
      minutesUntilLastTrain({
        lastTrainTime: '23:47',
        now: new Date('2026-06-26T14:30:00Z'),
      }),
    ).toBeNull();
    spy.mockRestore();
  });

  it('Intl가 hour="24"를 반환해도 0으로 정규화 (자정 처리)', () => {
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementationOnce(
      () =>
        ({
          formatToParts: () => [
            { type: 'hour', value: '24' },
            { type: 'minute', value: '00' },
          ],
        }) as unknown as Intl.DateTimeFormat,
    );
    // 자정 = 00:00 KST, 막차 = 00:30 → 30분 남음
    expect(
      minutesUntilLastTrain({
        lastTrainTime: '00:30',
        now: new Date('2026-06-26T15:00:00Z'),
      }),
    ).toBe(30);
    spy.mockRestore();
  });
});

describe('todayKstKey', () => {
  it('YYYYMMDD KST 형식', () => {
    // KST 2026-06-26 22:00 = UTC 13:00
    expect(todayKstKey(new Date('2026-06-26T13:00:00Z'))).toBe('20260626');
  });

  it('자정 직전과 직후로 일자 경계', () => {
    // KST 2026-06-27 00:30 = UTC 15:30 of 06-26
    expect(todayKstKey(new Date('2026-06-26T15:30:00Z'))).toBe('20260627');
  });

  it('Intl 실패 → 빈 문자열', () => {
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementationOnce(() => {
      throw new Error('hermes');
    });
    expect(todayKstKey(new Date('2026-06-26T13:00:00Z'))).toBe('');
    spy.mockRestore();
  });

  it('필수 part 누락 → 빈 문자열', () => {
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementationOnce(
      () =>
        ({
          formatToParts: () => [{ type: 'year', value: '2026' }],
        }) as unknown as Intl.DateTimeFormat,
    );
    expect(todayKstKey(new Date('2026-06-26T13:00:00Z'))).toBe('');
    spy.mockRestore();
  });
});
