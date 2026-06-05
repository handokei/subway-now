import { describe, expect, it, vi } from 'vitest';
import {
  KNOWN_GATE_REASONS,
  RECALL_DISTRIBUTION_LABEL_PREFIX,
  recordRecallUpload,
  validateRecallUpload,
  type RecallUpload,
} from '../recallTelemetry';
import { METRIC_KIND, MIN_RECALL_RATIO_THRESHOLD } from '../metrics';

function base(): Record<string, unknown> {
  return {
    token: 'aabbccdd11223344',
    tripStart: 1_000,
    tripEnd: 2_000,
    expectedStops: 5,
    firedStops: 4,
    recallPct: 80,
    gateSuppressionCounts: {
      'gate-accuracy': 1,
      'movement-static-position': 2,
    },
  };
}

describe('validateRecallUpload', () => {
  it('accepts a valid payload', () => {
    const result = validateRecallUpload(base());
    expect(result).not.toBeNull();
    expect(result?.expectedStops).toBe(5);
    expect(result?.firedStops).toBe(4);
    expect(result?.gateSuppressionCounts['gate-accuracy']).toBe(1);
    expect(result?.gateSuppressionCounts['movement-static-position']).toBe(2);
  });

  it('rejects non-object', () => {
    expect(validateRecallUpload(null)).toBeNull();
    expect(validateRecallUpload('x')).toBeNull();
  });

  it('rejects missing/empty token', () => {
    expect(validateRecallUpload({ ...base(), token: '' })).toBeNull();
    const noToken = base();
    delete noToken.token;
    expect(validateRecallUpload(noToken)).toBeNull();
  });

  it.each([
    ['tripStart', NaN],
    ['tripStart', 'x'],
    ['tripEnd', NaN],
    ['tripEnd', 'x'],
  ])('rejects non-finite %s (%p)', (field, value) => {
    expect(validateRecallUpload({ ...base(), [field]: value })).toBeNull();
  });

  it('rejects tripEnd < tripStart', () => {
    expect(
      validateRecallUpload({ ...base(), tripStart: 2_000, tripEnd: 1_000 }),
    ).toBeNull();
  });

  it.each([
    ['expectedStops', -1],
    ['expectedStops', 1.5],
    ['expectedStops', NaN],
    ['expectedStops', 'x'],
    ['firedStops', -1],
    ['firedStops', 1.5],
  ])('rejects non-natural %s (%p)', (field, value) => {
    expect(validateRecallUpload({ ...base(), [field]: value })).toBeNull();
  });

  it('rejects firedStops > expectedStops', () => {
    expect(
      validateRecallUpload({ ...base(), expectedStops: 2, firedStops: 3 }),
    ).toBeNull();
  });

  it.each([
    ['recallPct', -1],
    ['recallPct', 101],
    ['recallPct', 50.5],
    ['recallPct', NaN],
  ])('rejects out-of-range %s (%p)', (field, value) => {
    expect(validateRecallUpload({ ...base(), [field]: value })).toBeNull();
  });

  it('rejects missing or non-object gateSuppressionCounts', () => {
    const missing = base();
    delete missing.gateSuppressionCounts;
    expect(validateRecallUpload(missing)).toBeNull();
    expect(validateRecallUpload({ ...base(), gateSuppressionCounts: 'x' })).toBeNull();
    expect(validateRecallUpload({ ...base(), gateSuppressionCounts: null })).toBeNull();
  });

  it('rejects invalid gateSuppressionCounts value', () => {
    expect(
      validateRecallUpload({ ...base(), gateSuppressionCounts: { 'gate-accuracy': -1 } }),
    ).toBeNull();
    expect(
      validateRecallUpload({ ...base(), gateSuppressionCounts: { 'gate-accuracy': 1.5 } }),
    ).toBeNull();
  });

  it('drops unknown reason keys silently', () => {
    const result = validateRecallUpload({
      ...base(),
      gateSuppressionCounts: { 'gate-accuracy': 1, 'unknown-reason': 99 },
    });
    expect(result?.gateSuppressionCounts['gate-accuracy']).toBe(1);
    expect(
      (result?.gateSuppressionCounts as Record<string, unknown>)['unknown-reason'],
    ).toBeUndefined();
  });

  it('preserves empty gateSuppressionCounts', () => {
    const result = validateRecallUpload({ ...base(), gateSuppressionCounts: {} });
    expect(result?.gateSuppressionCounts).toEqual({});
  });

  it('accepts expectedStops=0 firedStops=0 (corner case — recall=100)', () => {
    const result = validateRecallUpload({
      ...base(),
      expectedStops: 0,
      firedStops: 0,
      recallPct: 100,
    });
    expect(result?.expectedStops).toBe(0);
    expect(result?.firedStops).toBe(0);
  });
});

describe('recordRecallUpload', () => {
  function makeWriter() {
    return { writeDataPoint: vi.fn() };
  }

  const payload: RecallUpload = {
    token: 'aabbccdd11223344',
    tripStart: 0,
    tripEnd: 1,
    expectedStops: 10,
    firedStops: 8,
    recallPct: 80,
    gateSuppressionCounts: {
      'gate-accuracy': 1,
      'movement-static-position': 1,
    },
  };

  it('writes perStationAlarmRecall hit+total + one point per non-zero reason', () => {
    const writer = makeWriter();
    recordRecallUpload(writer, payload);
    // rate metric: hit + total = 2 points (firedStops=8, expectedStops=10 — both >0)
    // distribution: 2 reasons with count > 0 = 2 points
    expect(writer.writeDataPoint).toHaveBeenCalledTimes(4);
    const labels = writer.writeDataPoint.mock.calls.map((c) => c[0].blobs[0]);
    expect(labels).toContain(`phase3:${METRIC_KIND.PER_STATION_ALARM_RECALL}:hit`);
    expect(labels).toContain(`phase3:${METRIC_KIND.PER_STATION_ALARM_RECALL}:total`);
    expect(labels).toContain(`${RECALL_DISTRIBUTION_LABEL_PREFIX}:gate-accuracy`);
    expect(labels).toContain(`${RECALL_DISTRIBUTION_LABEL_PREFIX}:movement-static-position`);
  });

  it('skips zero count reasons (only writes rate points)', () => {
    const writer = makeWriter();
    recordRecallUpload(writer, {
      ...payload,
      gateSuppressionCounts: {},
    });
    // only rate hit+total
    expect(writer.writeDataPoint).toHaveBeenCalledTimes(2);
  });

  it('skips zero firedStops in rate (still writes total)', () => {
    const writer = makeWriter();
    recordRecallUpload(writer, {
      ...payload,
      firedStops: 0,
      gateSuppressionCounts: {},
    });
    // 0 hit skipped, total still written
    expect(writer.writeDataPoint).toHaveBeenCalledTimes(1);
    const first = writer.writeDataPoint.mock.calls[0][0];
    expect(first.blobs[0]).toBe(`phase3:${METRIC_KIND.PER_STATION_ALARM_RECALL}:total`);
  });

  it('writes nothing when both rate and counts are zero', () => {
    const writer = makeWriter();
    recordRecallUpload(writer, {
      ...payload,
      expectedStops: 0,
      firedStops: 0,
      gateSuppressionCounts: {},
    });
    expect(writer.writeDataPoint).not.toHaveBeenCalled();
  });

  it('uses 8-char token prefix in blobs/indexes', () => {
    const writer = makeWriter();
    recordRecallUpload(writer, payload);
    const distributionCall = writer.writeDataPoint.mock.calls.find((c) =>
      (c[0].blobs[0] as string).startsWith(RECALL_DISTRIBUTION_LABEL_PREFIX),
    );
    expect(distributionCall).toBeDefined();
    const point = distributionCall![0];
    expect(point.blobs[1]).toBe('aabbccdd');
    expect(point.indexes[0]).toBe('aabbccdd');
    expect(point.doubles[0]).toBeGreaterThan(0);
  });
});

describe('catalog + reason SSOT', () => {
  it('exposes MIN_RECALL_RATIO_THRESHOLD via metrics module', () => {
    expect(MIN_RECALL_RATIO_THRESHOLD).toBe(0.95);
  });

  it('exposes perStationAlarmRecall + gateSuppressionDistribution METRIC_KIND', () => {
    expect(METRIC_KIND.PER_STATION_ALARM_RECALL).toBe('perStationAlarmRecall');
    expect(METRIC_KIND.GATE_SUPPRESSION_DISTRIBUTION).toBe('gateSuppressionDistribution');
  });

  it('KNOWN_GATE_REASONS excludes dedup-station / dedup-alarm (정상 동작)', () => {
    // dedup은 *이미 발화된* 알람의 재발화 차단이라 게이트 분포에 포함되면 신호 오염.
    // client GATE_SUPPRESSION_REASONS와 양방향 SSOT — 같은 정책.
    const reasons = new Set<string>(KNOWN_GATE_REASONS);
    expect(reasons.has('dedup-station')).toBe(false);
    expect(reasons.has('dedup-alarm')).toBe(false);
  });

  it('KNOWN_GATE_REASONS covers core gates (accuracy/movement/silence/lock)', () => {
    const reasons = new Set<string>(KNOWN_GATE_REASONS);
    expect(reasons.has('gate-accuracy')).toBe(true);
    expect(reasons.has('movement-static-position')).toBe(true);
    expect(reasons.has('dismiss-silence')).toBe(true);
    expect(reasons.has('lock-line-mismatch')).toBe(true);
  });
});
