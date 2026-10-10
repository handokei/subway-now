import {
  getLockCorrectionMetrics,
  recordLockCorrection,
  recordPendingLockPromotion,
  resetLockCorrectionMetrics,
} from '../lockCorrectionMetrics';

describe('lockCorrectionMetrics (#1166)', () => {
  beforeEach(() => {
    resetLockCorrectionMetrics();
  });

  it('초기 상태는 fired=0, lastFiredAtMs=0', () => {
    const m = getLockCorrectionMetrics();
    expect(m.fired).toBe(0);
    expect(m.lastFiredAtMs).toBe(0);
  });

  // #2786 리뷰(항목 4, Wire-completion V/X) — PENDING→실 trainCode 승격은 recordLockCorrection의
  // "정정"(pending A ≠ confirmed B, 둘 다 사용자가 탭한 값)과 달리 pendingTrainCode/lockedTrainCode가
  // 즉시 같은 값으로 수렴해 recordLockCorrection이 스킵된다 — 승격이 실제로 발생했는지 관측할
  // 별도 채널이 없었다. 구분되는 counter를 추가한다.
  it('초기 상태는 promoted=0, lastPromotedAtMs=0', () => {
    const m = getLockCorrectionMetrics();
    expect(m.promoted).toBe(0);
    expect(m.lastPromotedAtMs).toBe(0);
  });

  it('recordPendingLockPromotion 호출 시 promoted 누적 + lastPromotedAtMs 갱신 (fired와 독립)', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      recordPendingLockPromotion('2371');
      let m = getLockCorrectionMetrics();
      expect(m.promoted).toBe(1);
      expect(m.lastPromotedAtMs).toBe(1_000_000);
      expect(m.fired).toBe(0);

      nowSpy.mockReturnValue(2_000_000);
      recordPendingLockPromotion('7302');
      m = getLockCorrectionMetrics();
      expect(m.promoted).toBe(2);
      expect(m.lastPromotedAtMs).toBe(2_000_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reset 후 promoted counter도 다시 0', () => {
    recordPendingLockPromotion('2371');
    resetLockCorrectionMetrics();
    const m = getLockCorrectionMetrics();
    expect(m.promoted).toBe(0);
    expect(m.lastPromotedAtMs).toBe(0);
  });

  it('recordLockCorrection 호출 시 fired 누적 + lastFiredAtMs 갱신', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      recordLockCorrection('A', 'B');
      let m = getLockCorrectionMetrics();
      expect(m.fired).toBe(1);
      expect(m.lastFiredAtMs).toBe(1_000_000);

      nowSpy.mockReturnValue(2_000_000);
      recordLockCorrection('B', 'C');
      m = getLockCorrectionMetrics();
      expect(m.fired).toBe(2);
      expect(m.lastFiredAtMs).toBe(2_000_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reset 후 counter는 다시 0', () => {
    recordLockCorrection('A', 'B');
    resetLockCorrectionMetrics();
    const m = getLockCorrectionMetrics();
    expect(m.fired).toBe(0);
    expect(m.lastFiredAtMs).toBe(0);
  });

  it('getLockCorrectionMetrics는 호출자가 mutate해도 내부 상태 보호 (복사본 반환)', () => {
    recordLockCorrection('A', 'B');
    const m = getLockCorrectionMetrics() as { fired: number; lastFiredAtMs: number };
    m.fired = 999;
    expect(getLockCorrectionMetrics().fired).toBe(1);
  });
});
