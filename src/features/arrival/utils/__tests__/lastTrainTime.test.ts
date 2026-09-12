import { getLastTrainTime } from '../lastTrainTime';

describe('getLastTrainTime', () => {
  // 평일 KST 정오 — dayType=weekday 분기.
  const KST_WEEKDAY_NOON = new Date('2026-06-10T03:00:00.000Z'); // 화요일 12:00 KST
  const KST_SATURDAY_NOON = new Date('2026-06-13T03:00:00.000Z'); // 토요일 12:00 KST
  const KST_SUNDAY_NOON = new Date('2026-06-14T03:00:00.000Z'); // 일요일 12:00 KST

  it('1호선 소요산 weekday up: 마지막 entry "2436" → "00:36"', () => {
    const time = getLastTrainTime({
      stationName: '소요산',
      line: '1',
      direction: 'up',
      now: KST_WEEKDAY_NOON,
    });
    expect(time).toBe('00:36');
  });

  it('1호선 소요산 weekday down: 마지막 entry "2347" → "23:47"', () => {
    const time = getLastTrainTime({
      stationName: '소요산',
      line: '1',
      direction: 'down',
      now: KST_WEEKDAY_NOON,
    });
    expect(time).toBe('23:47');
  });

  it('토요일은 saturday timetable 분기를 사용', () => {
    expect(
      getLastTrainTime({ stationName: '소요산', line: '1', direction: 'up', now: KST_SATURDAY_NOON }),
    ).toMatch(/^\d{2}:\d{2}$/);
  });

  it('일요일은 sunday timetable 분기를 사용', () => {
    expect(
      getLastTrainTime({ stationName: '소요산', line: '1', direction: 'down', now: KST_SUNDAY_NOON }),
    ).toMatch(/^\d{2}:\d{2}$/);
  });

  it('timetable 없는 노선(공항철도)은 null', () => {
    expect(
      getLastTrainTime({ stationName: '서울역', line: 'airport', direction: 'up', now: KST_WEEKDAY_NOON }),
    ).toBeNull();
  });

  it('timetable에 없는 역은 null', () => {
    expect(
      getLastTrainTime({ stationName: '존재하지않는역', line: '1', direction: 'up', now: KST_WEEKDAY_NOON }),
    ).toBeNull();
  });

  it('#1088: weekday part 누락(Hermes 회귀) 시 null로 graceful degrade', () => {
    const spy = jest
      .spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
      .mockImplementationOnce(() => [{ type: 'literal', value: '' }]);
    expect(
      getLastTrainTime({ stationName: '소요산', line: '1', direction: 'up', now: KST_WEEKDAY_NOON }),
    ).toBeNull();
    spy.mockRestore();
  });
});
