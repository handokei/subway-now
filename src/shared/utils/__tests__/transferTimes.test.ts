import {
  getTransferSeconds,
  getTransferSecondsOrNull,
} from '../transferTimes';
import { TRANSFER_WALKING_BUFFER_SECONDS } from '../../constants/boardingLock';

describe('transferTimes', () => {
  describe('getTransferSeconds', () => {
    // 주요 환승역 표본(공공데이터포털 15044419 기준) — ADR-015 §6 acceptance.
    // 데이터셋 자체가 회귀로 변경되지 않도록 양수 + 합리적 범위(0 < s ≤ 1800)로만 단언.
    it.each([
      // 1~8호선 핵심 환승역 양방향
      ['2', '5', '왕십리'],
      ['5', '2', '왕십리'],
      ['1', '2', '시청'],
      ['1', '2', '신도림'],
      ['1', '3', '종로3가'],
      ['1', '4', '동대문'],
      ['2', '4', '사당'],
      ['2', '8', '잠실'],
      ['3', '4', '충무로'],
      ['2', '3', '교대'],
      // #1459: 신규 CSV 1024 row 적용으로 채워진 호선쌍 — 회귀 가드.
      ['1', '6', '석계'],
      ['6', '1', '석계'],
      ['9', 'airport', '김포공항'],
      ['airport', '9', '김포공항'],
      ['bundang', 'sinbundang', '정자'],
    ] as const)('returns positive seconds for %s↔%s @ %s', (fromLine, toLine, station) => {
      const seconds = getTransferSeconds(fromLine, toLine, station);
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(1800);
    });

    it('falls back to TRANSFER_WALKING_BUFFER_SECONDS for unknown line pair', () => {
      expect(getTransferSeconds('1', '2', '존재하지않는역')).toBe(
        TRANSFER_WALKING_BUFFER_SECONDS,
      );
    });

    it('normalizes station name with parentheses subtitle', () => {
      // "왕십리(성동구청)" → "왕십리" 로 정규화되어 동일 값 반환.
      const plain = getTransferSeconds('2', '5', '왕십리');
      const withSubtitle = getTransferSeconds('2', '5', '왕십리(성동구청)');
      expect(withSubtitle).toBe(plain);
    });

    it('applies station alias (e.g. 총신대입구 → 이수)', () => {
      // 4호선/7호선 환승역 — 공식 표기 차이 alias 적용.
      const v1 = getTransferSeconds('4', '7', '이수');
      const v2 = getTransferSeconds('4', '7', '총신대입구');
      expect(v1).toBe(v2);
      expect(v1).toBeGreaterThan(0);
    });
  });

  describe('getTransferSecondsOrNull', () => {
    it('returns undefined for unknown pair', () => {
      expect(getTransferSecondsOrNull('1', '2', '존재하지않는역')).toBeUndefined();
    });

    it('returns the same value as getTransferSeconds when known', () => {
      expect(getTransferSecondsOrNull('2', '5', '왕십리')).toBe(
        getTransferSeconds('2', '5', '왕십리'),
      );
    });
  });
});
