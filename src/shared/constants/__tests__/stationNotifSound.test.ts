import { resolveStationNotifSoundFields, STATION_NOTIF_SOUND_FIELDS } from '../stationNotifSound';

// #2822 — device 로컬 station 알림 kind별 sound 매핑. backend `stationNotifSoundFields`
// (scheduled.ts:2679)와 동일 정책: intermediate=무음, transfer/destination=sound+timeSensitive.
describe('resolveStationNotifSoundFields', () => {
  it('intermediate(매역 통과)는 무음 — 매 역 소리 금지(회귀 안전)', () => {
    expect(resolveStationNotifSoundFields('intermediate')).toEqual({
      sound: false,
      timeSensitive: false,
    });
  });

  it('transfer(환승 준비)는 sound + timeSensitive', () => {
    expect(resolveStationNotifSoundFields('transfer')).toEqual({
      sound: true,
      timeSensitive: true,
    });
  });

  it('destination(도착 준비)는 sound + timeSensitive', () => {
    expect(resolveStationNotifSoundFields('destination')).toEqual({
      sound: true,
      timeSensitive: true,
    });
  });

  it('STATION_NOTIF_SOUND_FIELDS Record가 StationWaypointKind 3종을 전부 커버한다', () => {
    expect(Object.keys(STATION_NOTIF_SOUND_FIELDS).sort()).toEqual(
      ['destination', 'intermediate', 'transfer'].sort(),
    );
  });
});
