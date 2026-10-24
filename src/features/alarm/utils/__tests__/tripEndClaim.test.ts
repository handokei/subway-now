const mockGetCorrId = jest.fn<string | null, []>();
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: () => mockGetCorrId(),
}));
const mockGetStartedAt = jest.fn<Promise<number | null>, []>();
jest.mock('../tripStartStorage', () => ({ getTripStartedAt: () => mockGetStartedAt() }));

import {
  claimTripEnd,
  claimTripEndAction,
  resolveTripEndIdentity,
  __resetTripEndClaimsForTests__,
} from '../tripEndClaim';

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

describe('resolveTripEndIdentity / claimTripEndAction (PR-2: 9h force-end 경쟁)', () => {
  beforeEach(() => {
    __resetTripEndClaimsForTests__();
    mockGetCorrId.mockReturnValue('corr-1');
    mockGetStartedAt.mockResolvedValue(1_700_000_000_000);
  });

  it('identity: corrId 우선 -> start -> null', async () => {
    await expect(resolveTripEndIdentity()).resolves.toBe('corr-1');
    mockGetCorrId.mockReturnValue(null);
    await expect(resolveTripEndIdentity()).resolves.toBe('start:1700000000000');
    mockGetStartedAt.mockResolvedValue(null);
    await expect(resolveTripEndIdentity()).resolves.toBeNull();
    mockGetStartedAt.mockRejectedValue(new Error('io'));
    await expect(resolveTripEndIdentity()).resolves.toBeNull();
  });

  it('같은 종료에 대한 두 번째 action claim은 실패한다', async () => {
    const first = await claimTripEndAction();
    const second = await claimTripEndAction();
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
  });

  it('action claim 네임스페이스는 알림 claim과 분리돼 있다(알림이 action을 막지 않는다)', async () => {
    expect(claimTripEnd('corr-1')).toBe(true);
    expect((await claimTripEndAction()).claimed).toBe(true);
  });

  it('release하면 다시 claim할 수 있다(실패한 종료의 재시도)', async () => {
    const first = await claimTripEndAction();
    first.release();
    expect((await claimTripEndAction()).claimed).toBe(true);
  });

  it('선점하지 못한 쪽의 release는 선점자의 claim을 풀지 않는다', async () => {
    const winner = await claimTripEndAction();
    const loser = await claimTripEndAction();
    loser.release();
    expect((await claimTripEndAction()).claimed).toBe(false);
    winner.release();
    expect((await claimTripEndAction()).claimed).toBe(true);
  });

  it('identity를 알 수 없으면(종료할 트립 없음) 조정할 대상이 없으므로 claimed=true', async () => {
    mockGetCorrId.mockReturnValue(null);
    mockGetStartedAt.mockResolvedValue(null);
    const a = await claimTripEndAction();
    const b = await claimTripEndAction();
    expect([a.claimed, b.claimed]).toEqual([true, true]);
    expect(() => a.release()).not.toThrow();
  });
});
