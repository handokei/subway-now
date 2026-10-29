/**
 * #3223 후속 — 사용자 확정 알림 문구(2026-10-29) device 쌍. backend `i18n.ts`/`alertContent.ts`와
 * 같은 문장이어야 한다(byte-identical 계약). 스펙 표만 보고 작성한 test-first 케이스.
 */
import i18next from 'i18next';
import { buildAlarmContent, buildStationPassedContent } from '../stationNotification';
import ko from '../../../../shared/i18n/locales/ko.json';
import en from '../../../../shared/i18n/locales/en.json';
import ja from '../../../../shared/i18n/locales/ja.json';
import zh from '../../../../shared/i18n/locales/zh.json';

jest.mock('expo-notifications');

afterEach(async () => {
  await i18next.changeLanguage('ko');
});

describe('ko — 로컬 알람/알림 확정 문구', () => {
  it('imminent destination: "{역} 도착" / "이번 역에서 내리세요"', () => {
    expect(buildAlarmContent({ phaseId: 'imminent', type: 'destination', stationName: '강남' })).toEqual({
      title: '강남 도착',
      body: '이번 역에서 내리세요',
    });
  });

  it('imminent transfer: "{역} 환승" / 노선 정보가 없으므로 "이번 역에서 내려 갈아타세요"', () => {
    expect(buildAlarmContent({ phaseId: 'imminent', type: 'transfer', stationName: '시청' })).toEqual({
      title: '시청 환승',
      body: '이번 역에서 내려 갈아타세요',
    });
  });

  it('취침 N역 전 band: 역명이 제목으로, 본문은 일어나서 준비', () => {
    expect(buildAlarmContent({ phaseId: 'early', type: 'transfer', stationName: '시청', band: 2 })).toEqual({
      title: '시청 환승까지 2정거장',
      body: '일어나서 환승 준비하세요',
    });
    expect(buildAlarmContent({ phaseId: 'early', type: 'destination', stationName: '강남', band: 3 })).toEqual({
      title: '강남 도착까지 3정거장',
      body: '일어나서 하차 준비하세요',
    });
  });

  it('1역 전 early(band 없음)은 무변경', () => {
    expect(buildAlarmContent({ phaseId: 'early', type: 'destination', stationName: '강남' }).body).toBe(
      '다음 역 강남에서 하차하세요!',
    );
  });

  it('매역 환승 target: "{역} 환승까지 N정거장" / 목적지 target은 "남음" 유지', () => {
    expect(buildStationPassedContent('중곡', 3, 'transfer', '홍대입구')).toEqual({
      title: '중곡역 도착',
      body: '홍대입구 환승까지 3정거장',
    });
    expect(buildStationPassedContent('중곡', 3, 'destination', '강남').body).toBe('강남까지 3정거장 남음');
  });
});

describe('en/ja/zh — 같은 의미(backend와 동일 문장)', () => {
  it.each([
    ['en', en, 'Transfer at {{station}}', 'Arriving at {{station}}', 'Get off here and transfer', 'Get off at this stop'],
    ['ja', ja, '{{station}}で乗換', '{{station}}に到着', 'この駅で降りて乗り換えてください', 'この駅で降りてください'],
    ['zh', zh, '在{{station}}换乘', '到达{{station}}', '请在本站下车换乘', '请在本站下车'],
  ] as const)('%s imminent', (_lc, json, tTitle, aTitle, tBody, aBody) => {
    expect(json.notifications.transferImminentTitle).toBe(tTitle);
    expect(json.notifications.arrivalImminentTitle).toBe(aTitle);
    expect(json.alarms.imminentTransferBody).toBe(tBody);
    expect(json.alarms.imminentArrivalBody).toBe(aBody);
  });

  it.each([
    ['en', en, '{{stops}} stops until transfer at {{station}}', 'Wake up and get ready to transfer'],
    ['ja', ja, '{{station}}乗換まであと{{stops}}駅', '起きて乗換の準備をしてください'],
    ['zh', zh, '距{{station}}换乘还有{{stops}}站', '请醒来准备换乘'],
  ] as const)('%s band transfer', (_lc, json, title, body) => {
    expect(json.alarms.bandTransferTitle).toBe(title);
    expect(json.alarms.bandTransferBody).toBe(body);
  });

  it('en: 환승 target 단/복수', async () => {
    await i18next.changeLanguage('en');
    expect(i18next.t('route.stopsRemainingToTransfer', { count: 1, destination: 'X' })).toBe('1 stop to transfer at X');
    expect(i18next.t('route.stopsRemainingToTransfer', { count: 3, destination: 'X' })).toBe('3 stops to transfer at X');
  });

  it('ko json 계약', () => {
    expect(ko.notifications.transferImminentTitle).toBe('{{station}} 환승');
    expect(ko.notifications.arrivalImminentTitle).toBe('{{station}} 도착');
  });
});

describe('device 자동 종료 알림(arrived) — 목적지명 있을 때 확정 문구', () => {
  it('ko json: 제목/본문 키', () => {
    const route = ko.route as Record<string, string>;
    expect(route.tripEndedArrivedNamedTitle).toBe('{{name}} 도착 · 안내 종료');
    expect(route.tripEndedArrivedBody).toBe('목적지에 도착해 경로 안내를 마쳤어요');
  });
});
