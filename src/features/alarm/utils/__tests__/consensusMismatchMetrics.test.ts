import {
  getConsensusMismatchMetrics,
  recordConsensusMismatch,
  resetConsensusMismatchMetrics,
} from '../consensusMismatchMetrics';

describe('consensusMismatchMetrics (#2330, design SSoT #2323 (3))', () => {
  beforeEach(() => {
    resetConsensusMismatchMetrics();
  });

  it('초기 상태는 fired=0, lastFiredAtMs=0', () => {
    const m = getConsensusMismatchMetrics();
    expect(m.fired).toBe(0);
    expect(m.lastFiredAtMs).toBe(0);
  });

  it('recordConsensusMismatch 호출 시 fired 누적 + lastFiredAtMs 갱신', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      recordConsensusMismatch('A', 'B');
      let m = getConsensusMismatchMetrics();
      expect(m.fired).toBe(1);
      expect(m.lastFiredAtMs).toBe(1_000_000);

      nowSpy.mockReturnValue(2_000_000);
      recordConsensusMismatch('B', 'C');
      m = getConsensusMismatchMetrics();
      expect(m.fired).toBe(2);
      expect(m.lastFiredAtMs).toBe(2_000_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reset 후 counter는 다시 0', () => {
    recordConsensusMismatch('A', 'B');
    resetConsensusMismatchMetrics();
    const m = getConsensusMismatchMetrics();
    expect(m.fired).toBe(0);
    expect(m.lastFiredAtMs).toBe(0);
  });

  it('getConsensusMismatchMetrics는 호출자가 mutate해도 내부 상태 보호 (복사본 반환)', () => {
    recordConsensusMismatch('A', 'B');
    const m = getConsensusMismatchMetrics() as { fired: number; lastFiredAtMs: number };
    m.fired = 999;
    expect(getConsensusMismatchMetrics().fired).toBe(1);
  });
});
