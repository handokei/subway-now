import {
  getLockCorrectionMetrics,
  recordLockCorrection,
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
