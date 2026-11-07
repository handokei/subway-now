import { describe, expect, it } from 'vitest';
import {
  buildAlertContent,
  buildTripEndedAlertContent,
  TRIP_ENDED_ALERT_BODY,
  TRIP_ENDED_ALERT_TITLE,
} from '../alertContent';
import type { AlarmPhase } from '../alarm';
import { findStationById } from '../../../../src/shared/utils/stationLookup';

describe('buildAlertContent (#570 P2d)', () => {
  // kind × phase 매트릭스. 새 케이스가 늘면 행 한 줄만 추가하면 됨 (글로벌 룰 #3 데이터 주도).
  it.each<{
    kind: 'destination' | 'transfer';
    phase: AlarmPhase;
    station: string;
    title: string;
    body: string;
  }>([
    {
      kind: 'destination',
      phase: 'early',
      station: '강남',
      title: '하차 알림',
      body: '다음 역 강남에서 하차하세요!',
    },
    {
      kind: 'destination',
      phase: 'imminent',
      station: '시청',
      title: '시청 도착',
      body: '이번 역에서 내리세요',
    },
    {
      kind: 'transfer',
      phase: 'early',
      station: '신도림',
      title: '환승 알림',
      body: '다음 역 신도림에서 환승하세요!',
    },
    {
      kind: 'transfer',
      phase: 'imminent',
      station: '왕십리',
      title: '왕십리 환승',
      body: '이번 역에서 내려 갈아타세요',
    },
  ])('$kind/$phase → $title', ({ kind, phase, station, title, body }) => {
    expect(buildAlertContent({ kind, phase, stationName: station })).toEqual({ title, body });
  });

  it('intermediate: phase 인자 없이 단일 본문 — "역 통과" / "X역을 지나고 있어요"', () => {
    expect(buildAlertContent({ kind: 'intermediate', stationName: '중곡' })).toEqual({
      title: '역 통과',
      body: '중곡역을 지나고 있어요',
    });
  });

  it('한글 외 stationName도 그대로 치환된다 (escape 없음)', () => {
    expect(
      buildAlertContent({ kind: 'destination', phase: 'imminent', stationName: 'Apgujeong' }),
    ).toEqual({
      title: 'Apgujeong 도착',
      body: '이번 역에서 내리세요',
    });
  });
});

// #1337 — trip-ended alert push 본문 상수. 디바이스 ko.json과 byte-identical 보장.
// 어긋나면 banner에 silent push 시점 본문과 다른 문구가 떠 운영 사고 직결.
describe('TRIP_ENDED_ALERT_* 상수 (#1337)', () => {
  it('TRIP_ENDED_ALERT_TITLE === ko.json route.tripEndedTitle', () => {
    expect(TRIP_ENDED_ALERT_TITLE).toBe('안내 종료');
  });
  it('TRIP_ENDED_ALERT_BODY === ko.json route.tripEndedBody', () => {
    expect(TRIP_ENDED_ALERT_BODY).toBe('경로 안내를 종료했어요');
  });
});

// #3342 — 도착 종료 알림 제목에 역 id("7-015 도착")가 노출되던 회귀. trip.destination은 device가 보낸 역 id다.
describe('buildTripEndedAlertContent 목적지 표시명 (#3342)', () => {
  const ID_PATTERN = /\d-\d{3}/;
  // 실측 사례(D1 trip_events id 2243 / 2288)의 id. 기대 표시명은 stations.json 조회로 산출한다(하드코딩 금지).
  it.each(['7-015', '5-025'])('목적지가 역 id(%s)여도 제목에 사람이 읽는 역명이 들어가고 id는 없다', (id) => {
    const expectedName = findStationById(id)?.name;
    expect(expectedName).toBeTruthy();
    const { title } = buildTripEndedAlertContent('destination-arrived', id, 'ko');
    expect(title).toContain(expectedName as string);
    expect(title).not.toMatch(ID_PATTERN);
  });

  it('이미 역명인 목적지(레거시 trip)는 그대로 쓴다', () => {
    const { title } = buildTripEndedAlertContent('destination-arrived', '뚝섬', 'ko');
    expect(title).toBe('뚝섬 도착 · 안내 종료');
  });

  it('거부: 해석 불가한 id는 id를 노출하지 않고 일반 제목/본문으로 폴백한다', () => {
    const content = buildTripEndedAlertContent('destination-arrived', '7-999', 'ko');
    expect(content).toEqual({ title: TRIP_ENDED_ALERT_TITLE, body: TRIP_ENDED_ALERT_BODY });
    expect(JSON.stringify(content)).not.toMatch(ID_PATTERN);
  });
});
