import { describe, expect, it, vi } from 'vitest';
import {
  recordDeltaVsEstimatorUpload,
  validateDeltaVsEstimatorUpload,
  type DeltaVsEstimatorUpload,
} from '../deltaVsEstimatorTelemetry';
import { METRIC_KIND, percentile, SLA_PERCENTILE } from '../metrics';

function base(): Record<string, unknown> {
  return {
    token: 'aabbccdd11223344',
    windowStart: 1_000,
    windowEnd: 2_000,
    deltaSamples: [0, 1, 2, 1, 0],
  };
}

describe('validateDeltaVsEstimatorUpload', () => {
  it('accepts a valid payload', () => {
    const result = validateDeltaVsEstimatorUpload(base());
    expect(result).not.toBeNull();
    expect(result?.deltaSamples).toEqual([0, 1, 2, 1, 0]);
  });

  it.each([
    ['null', null],
    ['string', 'x'],
  ])('rejects non-object (%s)', (_label, value) => {
    expect(validateDeltaVsEstimatorUpload(value)).toBeNull();
  });

  it('rejects missing/empty token', () => {
    expect(validateDeltaVsEstimatorUpload({ ...base(), token: '' })).toBeNull();
    const noToken = base();
    delete noToken.token;
    expect(validateDeltaVsEstimatorUpload(noToken)).toBeNull();
  });

  it.each([
    ['windowStart', Number.NaN],
    ['windowStart', 'x'],
    ['windowEnd', Number.NaN],
    ['windowEnd', 'x'],
  ])('rejects non-finite %s (%p)', (field, value) => {
    expect(validateDeltaVsEstimatorUpload({ ...base(), [field]: value })).toBeNull();
  });

  it('rejects windowEnd < windowStart', () => {
    expect(
      validateDeltaVsEstimatorUpload({ ...base(), windowStart: 2_000, windowEnd: 1_000 }),
    ).toBeNull();
  });

  it('rejects non-array deltaSamples', () => {
    expect(validateDeltaVsEstimatorUpload({ ...base(), deltaSamples: 'x' })).toBeNull();
    expect(validateDeltaVsEstimatorUpload({ ...base(), deltaSamples: 5 })).toBeNull();
  });

  it.each([
    ['negative', [0, -1, 2]],
    ['fractional', [0, 1.5, 2]],
    ['NaN', [0, Number.NaN, 2]],
    ['string', [0, 'x', 2]],
    ['Infinity', [0, Number.POSITIVE_INFINITY, 2]],
  ])('rejects non-natural sample entry (%s)', (_label, samples) => {
    expect(validateDeltaVsEstimatorUpload({ ...base(), deltaSamples: samples })).toBeNull();
  });

  it('accepts empty deltaSamples (idle window — caller decides whether to upload)', () => {
    const result = validateDeltaVsEstimatorUpload({ ...base(), deltaSamples: [] });
    expect(result).not.toBeNull();
    expect(result?.deltaSamples).toEqual([]);
  });
});

describe('recordDeltaVsEstimatorUpload', () => {
  function makeWriter() {
    return { writeDataPoint: vi.fn() };
  }

  it('writes count + mean + p95 data points for non-empty samples', () => {
    const writer = makeWriter();
    const payload: DeltaVsEstimatorUpload = {
      token: 'aabbccdd11223344',
      windowStart: 0,
      windowEnd: 1_000,
      deltaSamples: [0, 1, 2, 3, 4],
    };
    recordDeltaVsEstimatorUpload(writer, payload);
    expect(writer.writeDataPoint).toHaveBeenCalledTimes(3);
    const labels = writer.writeDataPoint.mock.calls.map((c) => c[0].blobs[0]);
    expect(labels).toContain(`phase3:${METRIC_KIND.DELTA_VS_ESTIMATOR_INDEX}:count`);
    expect(labels).toContain(`phase3:${METRIC_KIND.DELTA_VS_ESTIMATOR_INDEX}:mean`);
    const percentileLabel = `p${Math.round(SLA_PERCENTILE * 100)}`;
    expect(labels).toContain(`phase3:${METRIC_KIND.DELTA_VS_ESTIMATOR_INDEX}:${percentileLabel}`);
    // P95 reported value matches `percentile` (SSOT) — no inline magic.
    const p95Call = writer.writeDataPoint.mock.calls.find(
      (c) => c[0].blobs[0].endsWith(`:${percentileLabel}`),
    );
    expect(p95Call?.[0].doubles[0]).toBe(percentile([0, 1, 2, 3, 4], SLA_PERCENTILE));
  });

  it('skips all-zero samples (writes only count) — mean/p95 are 0', () => {
    const writer = makeWriter();
    recordDeltaVsEstimatorUpload(writer, {
      token: 'aabbccdd11223344',
      windowStart: 0,
      windowEnd: 1_000,
      deltaSamples: [0, 0, 0],
    });
    // writeMetricDataPoints skips 0 values → only count point survives.
    expect(writer.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writer.writeDataPoint.mock.calls[0][0].blobs[0]).toBe(
      `phase3:${METRIC_KIND.DELTA_VS_ESTIMATOR_INDEX}:count`,
    );
  });

  it('skips all points when samples is empty (idle window — no noise)', () => {
    const writer = makeWriter();
    recordDeltaVsEstimatorUpload(writer, {
      token: 'aabbccdd11223344',
      windowStart: 0,
      windowEnd: 1_000,
      deltaSamples: [],
    });
    expect(writer.writeDataPoint).not.toHaveBeenCalled();
  });

  it('uses 8-char token prefix for anonymous aggregate', () => {
    const writer = makeWriter();
    recordDeltaVsEstimatorUpload(writer, {
      token: 'aabbccdd11223344',
      windowStart: 0,
      windowEnd: 1_000,
      deltaSamples: [1, 2, 3],
    });
    const first = writer.writeDataPoint.mock.calls[0][0];
    expect(first.blobs[1]).toBe('aabbccdd');
    expect(first.indexes[0]).toBe('aabbccdd');
  });
});
