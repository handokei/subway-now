import { claimTripEnd, __resetTripEndClaimsForTests__ } from '../tripEndClaim';

describe('claimTripEnd — 동기 check-and-set', () => {
  beforeEach(() => __resetTripEndClaimsForTests__());

  it('같은 키는 첫 호출만 true', () => {
    expect(claimTripEnd('corr-1')).toBe(true);
    expect(claimTripEnd('corr-1')).toBe(false);
  });

  it('다른 키는 독립이다', () => {
    expect(claimTripEnd('corr-1')).toBe(true);
    expect(claimTripEnd('corr-2')).toBe(true);
  });

  it('await 없이 연달아 부른 두 호출 중 정확히 하나만 선점한다(동기 원자성)', () => {
    const results = [claimTripEnd('k'), claimTripEnd('k')];
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('오래된 claim이 무한히 쌓이지 않는다(상한 초과 시 가장 오래된 키부터 제거)', () => {
    for (let i = 0; i < 40; i++) claimTripEnd(`k-${i}`);
    // 최신 키는 여전히 claim 상태
    expect(claimTripEnd('k-39')).toBe(false);
    // 가장 오래된 키는 밀려나 다시 claim 가능
    expect(claimTripEnd('k-0')).toBe(true);
  });
});
