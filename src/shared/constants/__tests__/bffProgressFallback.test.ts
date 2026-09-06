import {
  BACKOFF_BASE_MS,
  BACKOFF_FACTOR,
  BACKOFF_MAX_MS,
  FAILURE_THRESHOLD,
} from '../bffProgressFallback';

describe('bffProgressFallback constants', () => {
  it('FAILURE_THRESHOLD는 1 이상이다 (down 판정에 최소 1회 실패 필요)', () => {
    expect(FAILURE_THRESHOLD).toBeGreaterThanOrEqual(1);
  });

  it('BACKOFF_BASE_MS < BACKOFF_MAX_MS (지수 증가 여지 확보)', () => {
    expect(BACKOFF_BASE_MS).toBeLessThan(BACKOFF_MAX_MS);
  });

  it('BACKOFF_FACTOR는 1보다 크다 (지수 증가)', () => {
    expect(BACKOFF_FACTOR).toBeGreaterThan(1);
  });
});
