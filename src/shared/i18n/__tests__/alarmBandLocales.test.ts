/**
 * #3100 — N역 전 칸 문구 키(4 locale). 백엔드 `i18n.ts`의 sleepAlarmTitle/Body와 같은 의미·같은 문장이어야
 * 기기 로컬 경로(안전망 알림 / 오버레이 / Live Activity)와 백엔드 push가 칸마다 같은 말을 한다.
 * 보간 변수는 `stops` (i18next `count`는 복수형 처리와 충돌하므로 쓰지 않는다).
 */
import ko from '../locales/ko.json';
import en from '../locales/en.json';
import ja from '../locales/ja.json';
import zh from '../locales/zh.json';

type Alarms = Record<string, string>;
const LOCALES: Record<string, { alarms: Alarms; alarmOverlay: Alarms }> = { ko, en, ja, zh };

const BAND_ALARM_KEYS = ['bandTransferTitle', 'bandArrivalTitle', 'bandTransferBody', 'bandArrivalBody'];

describe('N역 전 band 문구 키', () => {
  describe.each(Object.keys(LOCALES))('%s', (code) => {
    const { alarms, alarmOverlay } = LOCALES[code];

    it.each(BAND_ALARM_KEYS)('alarms.%s 가 있고 {{stops}}를 쓴다', (key) => {
      expect(typeof alarms[key]).toBe('string');
      expect(alarms[key]).toContain('{{stops}}');
    });

    it.each(['bandTransferBody', 'bandArrivalBody'])('alarms.%s 는 {{station}}도 쓴다', (key) => {
      expect(alarms[key]).toContain('{{station}}');
    });

    it('alarmOverlay.bandMessage 가 {{station}}·{{stops}}를 쓴다', () => {
      expect(alarmOverlay.bandMessage).toContain('{{station}}');
      expect(alarmOverlay.bandMessage).toContain('{{stops}}');
    });

    it('i18next count 변수는 쓰지 않는다 (복수형 규칙과 충돌)', () => {
      const all = [...BAND_ALARM_KEYS.map((k) => alarms[k]), alarmOverlay.bandMessage];
      for (const text of all) expect(text).not.toContain('{{count}}');
    });
  });

  it('ko 문장이 백엔드 sleepAlarmTitle/Body와 동일', () => {
    expect(ko.alarms.bandTransferTitle).toBe('환승 {{stops}}정거장 전');
    expect(ko.alarms.bandArrivalTitle).toBe('도착 {{stops}}정거장 전');
    expect(ko.alarms.bandTransferBody).toBe('{{station}}까지 {{stops}}정거장 남았습니다. 환승 준비하세요!');
    expect(ko.alarms.bandArrivalBody).toBe('{{station}}까지 {{stops}}정거장 남았습니다. 하차 준비하세요!');
  });

  it('en/ja/zh 문장이 백엔드와 동일', () => {
    expect(en.alarms.bandTransferTitle).toBe('Transfer in {{stops}} stops');
    expect(en.alarms.bandArrivalTitle).toBe('Arrival in {{stops}} stops');
    expect(en.alarms.bandTransferBody).toBe('{{stops}} stops to {{station}} — get ready to transfer!');
    expect(en.alarms.bandArrivalBody).toBe('{{stops}} stops to {{station}} — get ready to exit!');
    expect(ja.alarms.bandTransferTitle).toBe('乗換まであと{{stops}}駅');
    expect(ja.alarms.bandArrivalTitle).toBe('到着まであと{{stops}}駅');
    expect(ja.alarms.bandTransferBody).toBe('{{station}}まであと{{stops}}駅です。乗換の準備をしてください!');
    expect(ja.alarms.bandArrivalBody).toBe('{{station}}まであと{{stops}}駅です。下車の準備をしてください!');
    expect(zh.alarms.bandTransferTitle).toBe('距换乘还有{{stops}}站');
    expect(zh.alarms.bandArrivalTitle).toBe('距到达还有{{stops}}站');
    expect(zh.alarms.bandTransferBody).toBe('距{{station}}还有{{stops}}站。请准备换乘!');
    expect(zh.alarms.bandArrivalBody).toBe('距{{station}}还有{{stops}}站。请准备下车!');
  });
});
