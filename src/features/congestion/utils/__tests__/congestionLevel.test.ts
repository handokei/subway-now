import { CONGESTION_THRESHOLDS, classifyCongestion } from '../congestionLevel';

describe('classifyCongestion', () => {
  it('80 미만은 low', () => {
    expect(classifyCongestion(0)).toBe('low');
    expect(classifyCongestion(79.9)).toBe('low');
  });

  it('80 ≤ x < 130 은 medium (경계 포함)', () => {
    expect(classifyCongestion(CONGESTION_THRESHOLDS.medium)).toBe('medium');
    expect(classifyCongestion(129)).toBe('medium');
  });

  it('130 ≤ x < 150 은 high (경계 포함)', () => {
    expect(classifyCongestion(CONGESTION_THRESHOLDS.high)).toBe('high');
    expect(classifyCongestion(149)).toBe('high');
  });

  it('150 이상은 veryHigh', () => {
    expect(classifyCongestion(CONGESTION_THRESHOLDS.veryHigh)).toBe('veryHigh');
    expect(classifyCongestion(200)).toBe('veryHigh');
  });
});
