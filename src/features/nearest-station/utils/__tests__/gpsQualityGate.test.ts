import {
  isGpsQualityGateAcceptable,
  gpsQualityDropReason,
  isGpsQualityJumpDegraded,
  isGpsQualityAbsenceDegraded,
  isGpsQualityDegradedTransition,
} from '../gpsQualityGate';

describe('isGpsQualityGateAcceptable — #2070 경계값 (accuracy 99/100/101m x age 14/15/16s)', () => {
  it.each([
    [99, 14_000, true],
    [99, 15_000, false],
    [99, 16_000, false],
    [100, 14_000, false],
    [100, 15_000, false],
    [100, 16_000, false],
    [101, 14_000, false],
    [101, 15_000, false],
    [101, 16_000, false],
  ])('accuracy=%dm age=%dms → %s', (accuracy, ageMs, expected) => {
    expect(isGpsQualityGateAcceptable(accuracy, ageMs)).toBe(expected);
  });

  it('accuracy=null → false (미측정은 통과 불가)', () => {
    expect(isGpsQualityGateAcceptable(null, 0)).toBe(false);
  });

  it('accuracy=undefined → false', () => {
    expect(isGpsQualityGateAcceptable(undefined, 0)).toBe(false);
  });
});

describe('gpsQualityDropReason', () => {
  it('accuracy=null → accuracy', () => {
    expect(gpsQualityDropReason(null, 0)).toBe('accuracy');
  });

  it('accuracy=100(임계 이상) → accuracy', () => {
    expect(gpsQualityDropReason(100, 0)).toBe('accuracy');
  });

  it('accuracy 통과 + age=15000(임계 이상) → stale', () => {
    expect(gpsQualityDropReason(50, 15_000)).toBe('stale');
  });

  it('accuracy 통과 + age 통과(전제 위반 방어) → stale fallback', () => {
    expect(gpsQualityDropReason(50, 1_000)).toBe('stale');
  });
});

describe('isGpsQualityJumpDegraded', () => {
  it('직전 통과 기록 없음 → false', () => {
    expect(isGpsQualityJumpDegraded(null, 300)).toBe(false);
  });

  it('현재 accuracy 없음 → false', () => {
    expect(isGpsQualityJumpDegraded(50, null)).toBe(false);
    expect(isGpsQualityJumpDegraded(50, undefined)).toBe(false);
  });

  it('급락 100m 초과 → true', () => {
    expect(isGpsQualityJumpDegraded(50, 151)).toBe(true);
  });

  it('급락 정확히 100m(경계) → false (초과만 인정)', () => {
    expect(isGpsQualityJumpDegraded(50, 150)).toBe(false);
  });

  it('급락 100m 미만 → false', () => {
    expect(isGpsQualityJumpDegraded(50, 100)).toBe(false);
  });
});

describe('isGpsQualityAbsenceDegraded', () => {
  it('통과 기록 없음(콜드스타트) → false', () => {
    expect(isGpsQualityAbsenceDegraded(null, 100_000)).toBe(false);
  });

  it('30s 미만 경과 → false', () => {
    expect(isGpsQualityAbsenceDegraded(0, 29_999)).toBe(false);
  });

  it('정확히 30s 경과(경계) → true', () => {
    expect(isGpsQualityAbsenceDegraded(0, 30_000)).toBe(true);
  });

  it('30s 초과 경과 → true', () => {
    expect(isGpsQualityAbsenceDegraded(0, 30_001)).toBe(true);
  });
});

describe('isGpsQualityDegradedTransition — #2070 급락/부재 발생·미발생', () => {
  it('급락만 발생 → true', () => {
    expect(isGpsQualityDegradedTransition(50, 0, 200, 1_000)).toBe(true);
  });

  it('부재만 발생 → true', () => {
    expect(isGpsQualityDegradedTransition(50, 0, 60, 30_000)).toBe(true);
  });

  it('둘 다 발생 → true', () => {
    expect(isGpsQualityDegradedTransition(50, 0, 300, 40_000)).toBe(true);
  });

  it('둘 다 미발생 → false', () => {
    expect(isGpsQualityDegradedTransition(50, 29_000, 80, 30_000)).toBe(false);
  });

  it('콜드스타트(통과 기록 없음) + 짧은 경과 → false', () => {
    expect(isGpsQualityDegradedTransition(null, null, 300, 1_000)).toBe(false);
  });
});
