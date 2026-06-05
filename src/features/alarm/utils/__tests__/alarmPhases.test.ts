import { ALARM_PHASES, type AlarmContext } from '../alarmPhases';

function ctx(partial: Partial<AlarmContext>): AlarmContext {
  return {
    remainingStops: partial.remainingStops ?? 99,
    etaSeconds: partial.etaSeconds ?? null,
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
});
