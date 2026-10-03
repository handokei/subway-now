import { ALARM_PHASES, IMMINENT_LEAD_MS, type AlarmContext } from '../alarmPhases';

function ctx(partial: Partial<AlarmContext>): AlarmContext {
  return {
    remainingStops: partial.remainingStops ?? 99,
    etaSeconds: partial.etaSeconds ?? null,
    departed: partial.departed,
  };
}

const earlyPhase = ALARM_PHASES.find((p) => p.id === 'early')!;
const imminentPhase = ALARM_PHASES.find((p) => p.id === 'imminent')!;

describe('ALARM_PHASES', () => {
  it('exposes early and imminent in order', () => {
    expect(ALARM_PHASES.map((p) => p.id)).toEqual(['early', 'imminent']);
  });

  describe('early phase', () => {
    it('fires when remainingStops <= 1', () => {
      expect(earlyPhase.evaluate(ctx({ remainingStops: 1 }))).toBe(true);
      expect(earlyPhase.evaluate(ctx({ remainingStops: 0 }))).toBe(true);
    });

    it('does not fire when remainingStops > 1', () => {
      expect(earlyPhase.evaluate(ctx({ remainingStops: 2 }))).toBe(false);
      expect(earlyPhase.evaluate(ctx({ remainingStops: 5 }))).toBe(false);
    });

    // #2688 — 승차역 미출발(departed=false) 상태에서는 remainingStops<=1이어도 보류한다.
    describe('departure gate (#2688)', () => {
      it('does not fire when departed is explicitly false, even if remainingStops <= 1', () => {
        expect(earlyPhase.evaluate(ctx({ remainingStops: 1, departed: false }))).toBe(false);
        expect(earlyPhase.evaluate(ctx({ remainingStops: 0, departed: false }))).toBe(false);
      });

      it('fires when departed is true', () => {
        expect(earlyPhase.evaluate(ctx({ remainingStops: 1, departed: true }))).toBe(true);
      });

      it('fires when departed is undefined (no signal — conservative fallback, existing behavior)', () => {
        expect(earlyPhase.evaluate(ctx({ remainingStops: 1 }))).toBe(true);
      });
    });
  });

  describe('imminent phase', () => {
    it('does not fire when remainingStops > 1, regardless of eta', () => {
      expect(imminentPhase.evaluate(ctx({ remainingStops: 2, etaSeconds: 5 }))).toBe(false);
      expect(imminentPhase.evaluate(ctx({ remainingStops: 3, etaSeconds: 1 }))).toBe(false);
    });

    it('fires when etaSeconds <= 10 within approach', () => {
      expect(imminentPhase.evaluate(ctx({ remainingStops: 1, etaSeconds: 10 }))).toBe(true);
      expect(imminentPhase.evaluate(ctx({ remainingStops: 1, etaSeconds: 5 }))).toBe(true);
      expect(imminentPhase.evaluate(ctx({ remainingStops: 0, etaSeconds: 1 }))).toBe(true);
    });

    it('does not fire when etaSeconds > 10', () => {
      expect(imminentPhase.evaluate(ctx({ remainingStops: 1, etaSeconds: 11 }))).toBe(false);
      expect(imminentPhase.evaluate(ctx({ remainingStops: 1, etaSeconds: 60 }))).toBe(false);
    });

    it('does not fire when eta is null', () => {
      expect(imminentPhase.evaluate(ctx({ remainingStops: 1, etaSeconds: null }))).toBe(false);
    });
  });

  describe('getLeadMs (#1194)', () => {
    it('early returns hopMs as-is (variable lead)', () => {
      expect(earlyPhase.getLeadMs(15_000)).toBe(15_000);
      expect(earlyPhase.getLeadMs(60_000)).toBe(60_000);
      expect(earlyPhase.getLeadMs(0)).toBe(0);
    });

    it('imminent returns fixed IMMINENT_LEAD_MS regardless of hopMs', () => {
      expect(imminentPhase.getLeadMs(15_000)).toBe(IMMINENT_LEAD_MS);
      expect(imminentPhase.getLeadMs(60_000)).toBe(IMMINENT_LEAD_MS);
      expect(imminentPhase.getLeadMs(0)).toBe(IMMINENT_LEAD_MS);
    });

    it('IMMINENT_LEAD_MS is 10 seconds', () => {
      expect(IMMINENT_LEAD_MS).toBe(10_000);
    });
  });
});
