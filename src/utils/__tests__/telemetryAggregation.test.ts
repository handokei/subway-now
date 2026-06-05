import {
  aggregateSilentPushEntries,
  isEmptyTelemetry,
} from '../telemetryAggregation';
import type { AlarmLogEntry } from '../../features/alarm/utils/alarmLog';

function entry(partial: Partial<AlarmLogEntry> & Pick<AlarmLogEntry, 'ts' | 'source' | 'outcome'>): AlarmLogEntry {
  return { ...partial };
}

describe('aggregateSilentPushEntries', () => {
  const entries: AlarmLogEntry[] = [
    entry({ ts: 50, source: 'silent-push-received', outcome: 'received' }),
    entry({ ts: 100, source: 'silent-push-received', outcome: 'received' }),
    entry({ ts: 150, source: 'silent-push-fired', outcome: 'fired' }),
    entry({
      ts: 200,
      source: 'silent-push-skipped',
      outcome: 'suppressed',
      reason: 'gate-out-of-range',
    }),
    entry({
      ts: 210,
      source: 'silent-push-skipped',
      outcome: 'suppressed',
      reason: 'gate-out-of-range',
    }),
    entry({
      ts: 220,
      source: 'silent-push-skipped',
      outcome: 'suppressed',
      reason: 'payload-missing-kind',
    }),
    entry({ ts: 230, source: 'silent-push-skipped', outcome: 'suppressed' }),
    // non silent-push 항목은 무시
    entry({ ts: 240, source: 'fg', outcome: 'fired' }),
    entry({ ts: 250, source: 'bg', outcome: 'suppressed', reason: 'gate-age' }),
  ];

  it('counts entries by source and skip reason', () => {
    const payload = aggregateSilentPushEntries(entries, 0, 300);
    expect(payload.received).toBe(2);
    expect(payload.fired).toBe(1);
    expect(payload.skipped).toBe(4);
    expect(payload.skipReasons['gate-out-of-range']).toBe(2);
    expect(payload.skipReasons['payload-missing-kind']).toBe(1);
  });

  it('respects since (exclusive) and until (inclusive)', () => {
    const payload = aggregateSilentPushEntries(entries, 100, 210);
    // ts > 100 && ts <= 210: 150,200,210
    expect(payload.received).toBe(0);
    expect(payload.fired).toBe(1);
    expect(payload.skipped).toBe(2);
  });

  it('ignores non silent-push entries (default case)', () => {
    const payload = aggregateSilentPushEntries(entries, 235, 300);
    expect(payload.received).toBe(0);
    expect(payload.fired).toBe(0);
    expect(payload.skipped).toBe(0);
  });

  it('handles empty entries', () => {
    const payload = aggregateSilentPushEntries([], 0, 1000);
    expect(payload).toEqual({
      since: 0,
      until: 1000,
      received: 0,
      fired: 0,
      skipped: 0,
      skipReasons: {},
    });
  });

  it('skipReasons omits keys for skip entries without reason', () => {
    const payload = aggregateSilentPushEntries(
      [entry({ ts: 1, source: 'silent-push-skipped', outcome: 'suppressed' })],
      0,
      10,
    );
    expect(payload.skipped).toBe(1);
    expect(Object.keys(payload.skipReasons)).toHaveLength(0);
  });
});

describe('isEmptyTelemetry', () => {
  it('true when all zero', () => {
    expect(
      isEmptyTelemetry({
        since: 0,
        until: 1,
        received: 0,
        fired: 0,
        skipped: 0,
        skipReasons: {},
      }),
    ).toBe(true);
  });

  it('false when any counter non-zero', () => {
    expect(
      isEmptyTelemetry({
        since: 0,
        until: 1,
        received: 0,
        fired: 0,
        skipped: 1,
        skipReasons: {},
      }),
    ).toBe(false);
  });
});
