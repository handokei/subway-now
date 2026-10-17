import { describe, expect, it } from 'vitest';
import {
  buildAlertContent,
  TRIP_ENDED_ALERT_BODY,
  TRIP_ENDED_ALERT_TITLE,
} from '../alertContent';
import type { AlarmPhase } from '../alarm';

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
      title: '도착 임박',
      body: '곧 시청에 도착합니다. 하차 준비하세요!',
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
      title: '환승 임박',
      body: '곧 왕십리에 도착합니다. 환승 준비하세요!',
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
      title: '도착 임박',
      body: '곧 Apgujeong에 도착합니다. 하차 준비하세요!',
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
