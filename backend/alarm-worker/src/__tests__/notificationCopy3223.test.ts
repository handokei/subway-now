/**
 * #3223 후속 — 사용자 확정 알림 문구(2026-10-29). 예시: 용마산(7)→건대입구 환승(2)→뚝섬.
 * 스펙(확정 문구 표)만 보고 작성한 test-first 케이스. 소리/interruption/버튼은 무변경이라 여기서 다루지 않는다.
 */
import { describe, expect, it } from 'vitest';
import { buildAlertContent, buildTripEndedAlertContent } from '../alertContent';
import { sleepAlarmContent, t } from '../i18n';
import { buildStationNotifContent } from '../scheduled';
import type { Trip, Waypoint } from '../types';

const wp = (stationName: string, line: string, kind: Waypoint['kind']): Waypoint =>
  ({ stationName, line, kind }) as Waypoint;

// 중곡(7) → 건대입구(7, 환승) → 성수(2) → 뚝섬(2, 도착)
const MID = wp('중곡', '7', 'intermediate');
const TRANSFER = wp('건대입구', '7', 'transfer');
const AFTER = wp('성수', '2', 'intermediate');
const DEST = wp('뚝섬', '2', 'destination');
const tripOf = (waypoints: Waypoint[]): Trip => ({ waypoints }) as unknown as Trip;

describe('매역(intermediate) — 제목 유지, 본문 환승/도착 분기', () => {
  it('ko: target이 환승역이면 "{역} 환승까지 N정거장" (제목 그대로)', () => {
    const trip = tripOf([MID, TRANSFER, AFTER, DEST]);
    expect(buildStationNotifContent(trip, MID, 'ko')).toEqual({
      title: '중곡역 도착',
      body: '건대입구 환승까지 1정거장',
    });
  });

  it('ko: target이 목적지면 "{역}까지 N정거장 남음" 유지', () => {
    const trip = tripOf([AFTER, DEST]);
    expect(buildStationNotifContent(trip, AFTER, 'ko')).toEqual({
      title: '성수역 도착',
      body: '뚝섬까지 1정거장 남음',
    });
  });

  it('ko: 카운트 정보 없으면 "도착" 폴백', () => {
    expect(t('ko').stationNotifBody('intermediate', '중곡')).toBe('도착');
  });

  it.each([
    ['en', '3 stops to transfer at 건대입구'],
    ['ja', '건대입구乗換まで残り3駅'],
    ['zh', '距换乘站건대입구还有3站'],
  ] as const)('%s: 환승 target 문구', (lc, expected) => {
    expect(
      t(lc).stationNotifBody('intermediate', '중곡', { targetName: '건대입구', count: 3, targetKind: 'transfer' }),
    ).toBe(expected);
  });

  it('en: 환승 target 1정거장은 단수', () => {
    expect(
      t('en').stationNotifBody('intermediate', '중곡', { targetName: '건대입구', count: 1, targetKind: 'transfer' }),
    ).toBe('1 stop to transfer at 건대입구');
  });
});

describe('환승역(transfer) 알림', () => {
  it('ko: 다음 노선+방면이 waypoint에서 얻어지면 전체 문구', () => {
    const trip = tripOf([TRANSFER, AFTER, DEST]);
    expect(buildStationNotifContent(trip, TRANSFER, 'ko')).toEqual({
      title: '건대입구 환승',
      body: '이번 역에서 내려 2호선 성수 방면으로 갈아타세요',
    });
  });

  it('ko: 폴백 — 노선만 / 아무것도 없음', () => {
    const s = t('ko');
    expect(s.stationNotifBody('transfer', '건대입구', { nextLine: '2' })).toBe(
      '이번 역에서 내려 2호선으로 갈아타세요',
    );
    expect(s.stationNotifBody('transfer', '건대입구')).toBe('이번 역에서 내려 갈아타세요');
  });

  it('ko: 환승 waypoint가 trip에 없으면(indexOf -1) 갈아타세요 폴백', () => {
    const trip = tripOf([AFTER, DEST]);
    expect(buildStationNotifContent(trip, TRANSFER, 'ko').body).toBe('이번 역에서 내려 갈아타세요');
  });

  it.each([
    ['en', 'Transfer at 건대입구', 'Get off here and take line 2 toward 성수'],
    ['ja', '건대입구で乗換', 'この駅で降りて2号線 성수方面に乗り換えてください'],
    ['zh', '在건대입구换乘', '请在本站下车,换乘2号线 성수方向'],
  ] as const)('%s: 제목+본문', (lc, title, body) => {
    const s = t(lc);
    expect(s.stationNotifTitle('transfer', '건대입구')).toBe(title);
    expect(s.stationNotifBody('transfer', '건대입구', { nextLine: '2', nextStation: '성수' })).toBe(body);
  });
});

describe('목적지(destination) 알림', () => {
  it('ko: 제목/본문', () => {
    expect(buildStationNotifContent(tripOf([DEST]), DEST, 'ko')).toEqual({
      title: '뚝섬 도착',
      body: '이번 역에서 내리세요',
    });
  });

  it.each([
    ['en', 'Arriving at 뚝섬', 'Get off at this stop'],
    ['ja', '뚝섬に到着', 'この駅で降りてください'],
    ['zh', '到达뚝섬', '请在本站下车'],
  ] as const)('%s', (lc, title, body) => {
    expect(t(lc).stationNotifTitle('destination', '뚝섬')).toBe(title);
    expect(t(lc).stationNotifBody('destination', '뚝섬')).toBe(body);
  });
});

describe('alertContent fallback(byte-identical ko) — imminent', () => {
  it('destination/transfer imminent: 역명이 제목에, 본문은 노선 정보 없는 폴백', () => {
    expect(buildAlertContent({ kind: 'destination', phase: 'imminent', stationName: '뚝섬' })).toEqual({
      title: '뚝섬 도착',
      body: '이번 역에서 내리세요',
    });
    expect(buildAlertContent({ kind: 'transfer', phase: 'imminent', stationName: '건대입구' })).toEqual({
      title: '건대입구 환승',
      body: '이번 역에서 내려 갈아타세요',
    });
  });

  it('early phase는 무변경', () => {
    expect(buildAlertContent({ kind: 'transfer', phase: 'early', stationName: '건대입구' })).toEqual({
      title: '환승 알림',
      body: '다음 역 건대입구에서 환승하세요!',
    });
  });
});

describe('탑승 질문(boardingPrompt)', () => {
  const ARGS = {
    originStation: '용마산',
    line: '7',
    nextStation: '중곡',
    etaTimeStr: '06:27',
    destinationStation: '장암',
  };

  it('ko: 전체', () => {
    expect(t('ko').boardingPromptTitle).toBe('탑승하셨나요?');
    expect(t('ko').boardingPromptBody(ARGS)).toBe('용마산 7호선 · 06:27 중곡 방면 장암행 열차');
  });

  it('ko: 시각/종착역 없음 폴백은 해당 조각만 생략', () => {
    expect(t('ko').boardingPromptBody({ ...ARGS, etaTimeStr: null })).toBe('용마산 7호선 · 중곡 방면 장암행 열차');
    expect(t('ko').boardingPromptBody({ ...ARGS, destinationStation: null })).toBe('용마산 7호선 · 06:27 중곡 방면 열차');
    expect(t('ko').boardingPromptBody({ ...ARGS, nextStation: null })).toBe('7 · 용마산');
  });

  it.each([
    ['en', '용마산 line 7 · 06:27 toward 중곡, bound for 장암'],
    ['ja', '용마산 7号線 · 06:27 중곡方面 장암行きの列車'],
    ['zh', '용마산 7号线 · 06:27 중곡方向,开往장암的列车'],
  ] as const)('%s', (lc, expected) => {
    expect(t(lc).boardingPromptBody(ARGS)).toBe(expected);
  });
});

describe('환승 하차 질문(hop-end)', () => {
  const ARGS = { transferStation: '건대입구', line: '7', nextLine: '2', nextStation: '성수' };

  it('ko: 제목/본문', () => {
    expect(t('ko').hopEndPromptTitle({ transferStation: '건대입구' })).toBe('건대입구에서 내리셨나요?');
    expect(t('ko').hopEndPromptBody(ARGS)).toBe('2호선 성수 방면으로 갈아타세요');
  });

  it('ko: 폴백 — 방면 없음(노선만) / 다음 노선 없음(목적지 하차 확인은 기존 문장 유지)', () => {
    expect(t('ko').hopEndPromptBody({ ...ARGS, nextStation: null })).toBe('2호선으로 갈아타세요');
    expect(t('ko').hopEndPromptBody({ ...ARGS, nextLine: null, nextStation: null })).toBe(
      '7호선 건대입구에서 내려주세요.',
    );
  });

  it.each([
    ['en', 'Did you get off at 건대입구?', 'Transfer to line 2 toward 성수'],
    ['ja', '건대입구で降りましたか?', '2号線 성수方面に乗り換えてください'],
    ['zh', '您在건대입구下车了吗?', '请换乘2号线 성수方向'],
  ] as const)('%s', (lc, title, body) => {
    expect(t(lc).hopEndPromptTitle({ transferStation: '건대입구' })).toBe(title);
    expect(t(lc).hopEndPromptBody(ARGS)).toBe(body);
  });
});

describe('취침 알람 N역 전(1역 전 칸은 무변경)', () => {
  it('ko: 환승/도착', () => {
    expect(sleepAlarmContent('ko', 'transfer', '건대입구', 3)).toEqual({
      title: '건대입구 환승까지 3정거장',
      body: '일어나서 환승 준비하세요',
    });
    expect(sleepAlarmContent('ko', 'destination', '뚝섬', 2)).toEqual({
      title: '뚝섬 도착까지 2정거장',
      body: '일어나서 하차 준비하세요',
    });
  });

  it.each([
    ['en', 'transfer', '3 stops until transfer at 건대입구', 'Wake up and get ready to transfer'],
    ['ja', 'destination', '뚝섬到着まであと3駅', '起きて下車の準備をしてください'],
    ['zh', 'transfer', '距건대입구换乘还有3站', '请醒来准备换乘'],
  ] as const)('%s %s', (lc, kind, title, body) => {
    const station = kind === 'transfer' ? '건대입구' : '뚝섬';
    expect(sleepAlarmContent(lc, kind, station, 3)).toEqual({ title, body });
  });
});

describe('안내 종료 / 15분 정지', () => {
  it('ko: 목적지 도착 종료는 목적지명 포함', () => {
    expect(buildTripEndedAlertContent('destination-arrived', '뚝섬', 'ko')).toEqual({
      title: '뚝섬 도착 · 안내 종료',
      body: '목적지에 도착해 경로 안내를 마쳤어요',
    });
  });

  it('목적지명 없음 / 도착이 아닌 사유는 기존 "안내 종료" 유지', () => {
    const legacy = { title: '안내 종료', body: '경로 안내를 종료했어요' };
    expect(buildTripEndedAlertContent('destination-arrived', undefined, 'ko')).toEqual(legacy);
    expect(buildTripEndedAlertContent('expired', '뚝섬', 'ko')).toEqual(legacy);
  });

  it.each([
    ['en', 'Arrived at 뚝섬 · Guidance ended', 'You reached your destination and guidance has ended'],
    ['ja', '뚝섬に到着 · 案内終了', '目的地に到着したため、ルート案内を終了しました'],
    ['zh', '已到达뚝섬 · 导航结束', '已到达目的地,路线导航已结束'],
  ] as const)('%s', (lc, title, body) => {
    expect(buildTripEndedAlertContent('destination-arrived', '뚝섬', lc)).toEqual({ title, body });
  });

  it('15분 정지: ko 제목 유지 + 본문', () => {
    expect(t('ko').endPromptTitle).toBe('안내를 종료할까요?');
    expect(t('ko').endPromptBody({ destinationStation: '뚝섬' })).toBe('15분째 움직임이 없어요 · 뚝섬까지 안내 중');
    expect(t('ko').endPromptBody({})).toBe('15분째 움직임이 없어요');
  });

  it.each([
    ['en', 'No movement for 15 minutes · Guiding to 뚝섬'],
    ['ja', '15分間動きがありません · 뚝섬まで案内中'],
    ['zh', '已 15 分钟未移动 · 导航至 뚝섬'],
  ] as const)('15분 정지 %s', (lc, expected) => {
    expect(t(lc).endPromptBody({ destinationStation: '뚝섬' })).toBe(expected);
  });
});
