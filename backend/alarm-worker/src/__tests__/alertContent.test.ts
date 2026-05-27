import { describe, expect, it } from 'vitest';
import { buildAlertContent } from '../alertContent';

describe('buildAlertContent (#570 P2d)', () => {
  describe('destination', () => {
    it('early — "하차 알림" / "다음 역 X에서 하차하세요!"', () => {
      expect(buildAlertContent({ kind: 'destination', phase: 'early', stationName: '강남' })).toEqual({
        title: '하차 알림',
        body: '다음 역 강남에서 하차하세요!',
      });
    });

    it('imminent — "도착 임박" / "곧 X에 도착합니다. 하차 준비하세요!"', () => {
      expect(
        buildAlertContent({ kind: 'destination', phase: 'imminent', stationName: '시청' }),
      ).toEqual({
        title: '도착 임박',
        body: '곧 시청에 도착합니다. 하차 준비하세요!',
      });
    });
  });

  describe('transfer', () => {
    it('early — "환승 알림" / "다음 역 X에서 환승하세요!"', () => {
      expect(buildAlertContent({ kind: 'transfer', phase: 'early', stationName: '신도림' })).toEqual({
        title: '환승 알림',
        body: '다음 역 신도림에서 환승하세요!',
      });
    });

    it('imminent — "환승 임박" / "곧 X에 도착합니다. 환승 준비하세요!"', () => {
      expect(
        buildAlertContent({ kind: 'transfer', phase: 'imminent', stationName: '왕십리' }),
      ).toEqual({
        title: '환승 임박',
        body: '곧 왕십리에 도착합니다. 환승 준비하세요!',
      });
    });
  });

  describe('intermediate', () => {
    it('phase 인자 없이 단일 본문 — "역 통과" / "X역을 지나고 있어요"', () => {
      expect(buildAlertContent({ kind: 'intermediate', stationName: '중곡' })).toEqual({
        title: '역 통과',
        body: '중곡역을 지나고 있어요',
      });
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
