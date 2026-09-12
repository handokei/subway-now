import { StaticTimetableProvider } from '../StaticTimetableProvider';

describe('StaticTimetableProvider', () => {
  const provider = new StaticTimetableProvider();
  const KST_WEEKDAY_NOON = new Date('2026-06-09T03:00:00.000Z');

  it('exposes source="static"', () => {
    expect(provider.source).toBe('static');
  });

  it('getBoardableDepartureSync returns ok for supported lookup', () => {
    const result = provider.getBoardableDepartureSync({
      stationName: '시청',
      line: '1',
      direction: 'up',
      from: KST_WEEKDAY_NOON,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.departure.departureLabel).toMatch(/^\d{2}:\d{2}$/);
  });

  it('getBoardableDepartureSync returns no-timetable for bundang', () => {
    const result = provider.getBoardableDepartureSync({
      stationName: '왕십리',
      line: 'bundang',
      direction: 'up',
      from: KST_WEEKDAY_NOON,
    });
    expect(result.status).toBe('no-timetable');
  });

  it('getBoardableDeparture async returns identical result to sync', async () => {
    const params = {
      stationName: '시청',
      line: '1' as const,
      direction: 'up' as const,
      from: KST_WEEKDAY_NOON,
    };
    const syncResult = provider.getBoardableDepartureSync(params);
    const asyncResult = await provider.getBoardableDeparture(params);
    expect(asyncResult).toEqual(syncResult);
  });

  it('returns station-missing failure shape', () => {
    const result = provider.getBoardableDepartureSync({
      stationName: '없는역',
      line: '1',
      direction: 'up',
      from: KST_WEEKDAY_NOON,
    });
    expect(result.status).toBe('station-missing');
  });
});
