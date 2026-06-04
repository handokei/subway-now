import { buildFallbackSequenceLabel } from '../labels';

describe('buildFallbackSequenceLabel (#855)', () => {
  describe('arrivalSeconds > 0 — "(약 M분 후)" 결합', () => {
    it.each<[number, number, string]>([
      // [index, arrivalSeconds, expected]
      [0, 60, '약 1정거장 전 (약 1분 후)'],
      [0, 180, '약 1정거장 전 (약 3분 후)'],
      [1, 180, '약 2정거장 전 (약 3분 후)'],
      [2, 300, '약 3정거장 전 (약 5분 후)'],
      [9, 600, '약 10정거장 전 (약 10분 후)'],
    ])('index=%i arrivalSeconds=%i → %s', (index, seconds, expected) => {
      expect(buildFallbackSequenceLabel(index, seconds)).toBe(expected);
    });

    it('60초 미만은 1분으로 라운드(0분 후 같은 무의미 라벨 방지)', () => {
      // Math.round(29/60)=0 이지만 Math.max(1, …)로 1분 보장.
      expect(buildFallbackSequenceLabel(0, 29)).toBe('약 1정거장 전 (약 1분 후)');
      // 90초는 round(1.5)=2 분.
      expect(buildFallbackSequenceLabel(0, 90)).toBe('약 1정거장 전 (약 2분 후)');
    });
  });

  describe('arrivalSeconds 미전달/0/음수 — 분 라벨 생략', () => {
    it('arrivalSeconds 미전달이면 "약 N정거장 전"만', () => {
      expect(buildFallbackSequenceLabel(0)).toBe('약 1정거장 전');
      expect(buildFallbackSequenceLabel(4)).toBe('약 5정거장 전');
    });

    it('arrivalSeconds=0이면 분 라벨 생략', () => {
      expect(buildFallbackSequenceLabel(0, 0)).toBe('약 1정거장 전');
    });

    it('arrivalSeconds 음수면 분 라벨 생략 (이론상 발생 안하지만 가드)', () => {
      expect(buildFallbackSequenceLabel(1, -10)).toBe('약 2정거장 전');
    });
  });
});
