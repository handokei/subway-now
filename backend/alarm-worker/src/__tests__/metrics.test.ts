import { describe, expect, it, vi } from 'vitest';
import {
  decidePhaseFour,
  FALSE_POSITIVE_RATIO_THRESHOLD,
  isRateMetric,
  mean,
  METRIC_KIND,
  MIN_SAMPLE_FOR_DECISION,
  percentile,
  rate,
  SLA_LATE_THRESHOLD_MS,
  summarizeMetric,
  validateMetricBatch,
  validateMetricEntry,
  writeMetricDataPoints,
  type HistogramMetric,
  type MetricSummary,
  type RateMetric,
} from '../metrics';

// ───────────────────────────────────────────────────────────────
// 통계 헬퍼.
// ───────────────────────────────────────────────────────────────

describe('percentile', () => {
  it('returns 0 for empty array', () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  it('returns p95 for known sample', () => {
    // 1..100 정렬 → ceil(0.95 * 100) - 1 = 94 → 95
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(samples, 0.95)).toBe(95);
  });

  it('handles p=0 → smallest', () => {
    expect(percentile([5, 1, 3], 0)).toBe(1);
  });

  it('returns 0 for out-of-range p', () => {
    expect(percentile([1, 2, 3], -0.1)).toBe(0);
    expect(percentile([1, 2, 3], 1.1)).toBe(0);
  });

  it('clamps to last index when p=1', () => {
    expect(percentile([1, 2, 3], 1)).toBe(3);
  });
});

describe('mean', () => {
  it('returns 0 for empty array', () => {
    expect(mean([])).toBe(0);
  });

  it('computes mean', () => {
    expect(mean([2, 4, 6])).toBe(4);
  });
});

describe('rate', () => {
  it('returns 0 when total is 0', () => {
    expect(rate({ kind: METRIC_KIND.BOARDING_FALSE_POSITIVE, hit: 0, total: 0 })).toBe(0);
  });

  it('computes ratio', () => {
    expect(rate({ kind: METRIC_KIND.BOARDING_FALSE_POSITIVE, hit: 1, total: 4 })).toBe(0.25);
  });
});

describe('isRateMetric', () => {
  it('classifies rate by total field', () => {
    expect(
      isRateMetric({ kind: METRIC_KIND.BOARDING_FALSE_POSITIVE, hit: 0, total: 1 }),
    ).toBe(true);
  });

  it('classifies histogram absent of total', () => {
    expect(isRateMetric({ kind: METRIC_KIND.IMMINENT_SLA_ERROR, samples: [] })).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────
// summary.
// ───────────────────────────────────────────────────────────────

describe('summarizeMetric', () => {
  it('summarizes a rate metric', () => {
    const result = summarizeMetric({
      kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
      hit: 5,
      total: 100,
    });
    expect(result.value).toBe(0.05);
    expect(result.p95).toBe(0);
    expect(result.count).toBe(100);
    expect(result.significant).toBe(true);
  });

  it('marks rate metric insignificant when below threshold', () => {
    const result = summarizeMetric({
      kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
      hit: 1,
      total: MIN_SAMPLE_FOR_DECISION - 1,
    });
    expect(result.significant).toBe(false);
  });

  it('summarizes a histogram metric (mean/p95/count)', () => {
    const samples = Array.from({ length: 50 }, (_, i) => i + 1);
    const result = summarizeMetric({
      kind: METRIC_KIND.IMMINENT_SLA_ERROR,
      samples,
    });
    expect(result.count).toBe(50);
    expect(result.value).toBeCloseTo(25.5);
    expect(result.p95).toBe(48);
    expect(result.significant).toBe(true);
  });

  it('marks histogram insignificant when sample count low', () => {
    const result = summarizeMetric({
      kind: METRIC_KIND.IMMINENT_SLA_ERROR,
      samples: [10, 20, 30],
    });
    expect(result.significant).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────
// Phase 4 결정.
// ───────────────────────────────────────────────────────────────

function makeSummary(
  partial: Partial<MetricSummary> & Pick<MetricSummary, 'kind'>,
): MetricSummary {
  return {
    value: 0,
    p95: 0,
    count: MIN_SAMPLE_FOR_DECISION,
    significant: true,
    ...partial,
  };
}

describe('decidePhaseFour', () => {
  it('holds decision when falsePositive samples insufficient', () => {
    const decision = decidePhaseFour({
      falsePositive: makeSummary({
        kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
        significant: false,
        count: 5,
      }),
      imminentSla: makeSummary({ kind: METRIC_KIND.IMMINENT_SLA_ERROR }),
    });
    expect(decision.proceed).toBe(false);
    expect(decision.insufficientSamples).toBe(true);
    expect(decision.triggers).toEqual([]);
  });

  it('holds decision when imminentSla samples insufficient', () => {
    const decision = decidePhaseFour({
      falsePositive: makeSummary({ kind: METRIC_KIND.BOARDING_FALSE_POSITIVE }),
      imminentSla: makeSummary({
        kind: METRIC_KIND.IMMINENT_SLA_ERROR,
        significant: false,
        count: 2,
      }),
    });
    expect(decision.proceed).toBe(false);
    expect(decision.insufficientSamples).toBe(true);
  });

  it('skips Phase 4 when both within threshold', () => {
    const decision = decidePhaseFour({
      falsePositive: makeSummary({
        kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
        value: FALSE_POSITIVE_RATIO_THRESHOLD,
      }),
      imminentSla: makeSummary({
        kind: METRIC_KIND.IMMINENT_SLA_ERROR,
        p95: SLA_LATE_THRESHOLD_MS,
      }),
    });
    expect(decision.proceed).toBe(false);
    expect(decision.insufficientSamples).toBe(false);
    expect(decision.triggers).toEqual([]);
  });

  it('triggers on false-positive breach', () => {
    const decision = decidePhaseFour({
      falsePositive: makeSummary({
        kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
        value: FALSE_POSITIVE_RATIO_THRESHOLD + 0.01,
      }),
      imminentSla: makeSummary({ kind: METRIC_KIND.IMMINENT_SLA_ERROR }),
    });
    expect(decision.proceed).toBe(true);
    expect(decision.triggers).toContain('falsePositive');
    expect(decision.triggers).not.toContain('imminentSla');
  });

  it('triggers on imminentSla breach', () => {
    const decision = decidePhaseFour({
      falsePositive: makeSummary({ kind: METRIC_KIND.BOARDING_FALSE_POSITIVE }),
      imminentSla: makeSummary({
        kind: METRIC_KIND.IMMINENT_SLA_ERROR,
        p95: SLA_LATE_THRESHOLD_MS + 1,
      }),
    });
    expect(decision.proceed).toBe(true);
    expect(decision.triggers).toContain('imminentSla');
  });

  it('aggregates multiple triggers', () => {
    const decision = decidePhaseFour({
      falsePositive: makeSummary({
        kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
        value: 0.3,
      }),
      imminentSla: makeSummary({
        kind: METRIC_KIND.IMMINENT_SLA_ERROR,
        p95: SLA_LATE_THRESHOLD_MS + 1000,
      }),
    });
    expect(decision.proceed).toBe(true);
    expect(decision.triggers).toEqual(['falsePositive', 'imminentSla']);
  });
});

// ───────────────────────────────────────────────────────────────
// AE 적재.
// ───────────────────────────────────────────────────────────────

describe('writeMetricDataPoints', () => {
  function makeWriter() {
    return { writeDataPoint: vi.fn() };
  }

  it('writes hit + total points for rate metric (skips zero hit)', () => {
    const writer = makeWriter();
    writeMetricDataPoints(writer, 'aabbccdd11223344', {
      kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
      hit: 0,
      total: 10,
    });
    expect(writer.writeDataPoint).toHaveBeenCalledTimes(1);
    const labels = writer.writeDataPoint.mock.calls.map((c) => c[0].blobs[0]);
    expect(labels).toContain('phase3:boardingFalsePositiveRate:total');
  });

  it('writes hit + total when both > 0', () => {
    const writer = makeWriter();
    writeMetricDataPoints(writer, 'aabbccdd11223344', {
      kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
      hit: 3,
      total: 10,
    });
    expect(writer.writeDataPoint).toHaveBeenCalledTimes(2);
  });

  it('includes token prefix in blobs/indexes', () => {
    const writer = makeWriter();
    writeMetricDataPoints(writer, 'aabbccdd11223344', {
      kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
      hit: 1,
      total: 1,
    });
    const first = writer.writeDataPoint.mock.calls[0][0];
    expect(first.blobs[1]).toBe('aabbccdd');
    expect(first.indexes[0]).toBe('aabbccdd');
  });

  it('writes count/mean/p95 for histogram with non-zero values', () => {
    const writer = makeWriter();
    const hist: HistogramMetric = {
      kind: METRIC_KIND.IMMINENT_SLA_ERROR,
      samples: [10, 20, 30, 40, 50],
    };
    writeMetricDataPoints(writer, 'aabbccdd11223344', hist);
    const labels = writer.writeDataPoint.mock.calls.map((c) => c[0].blobs[0]);
    expect(labels).toContain('phase3:imminentSlaErrorMs:count');
    expect(labels).toContain('phase3:imminentSlaErrorMs:mean');
    expect(labels).toContain('phase3:imminentSlaErrorMs:p95');
  });

  it('skips zero histogram values (empty samples writes nothing)', () => {
    const writer = makeWriter();
    writeMetricDataPoints(writer, 'aabbccdd11223344', {
      kind: METRIC_KIND.IMMINENT_SLA_ERROR,
      samples: [],
    });
    expect(writer.writeDataPoint).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────
// validation.
// ───────────────────────────────────────────────────────────────

describe('validateMetricEntry', () => {
  it('accepts a valid rate metric', () => {
    const entry: RateMetric = {
      kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
      hit: 2,
      total: 5,
    };
    expect(validateMetricEntry(entry)).toEqual(entry);
  });

  it('accepts a valid histogram metric', () => {
    const entry: HistogramMetric = {
      kind: METRIC_KIND.IMMINENT_SLA_ERROR,
      samples: [10, 20, 30],
    };
    expect(validateMetricEntry(entry)).toEqual(entry);
  });

  it('rejects non-object', () => {
    expect(validateMetricEntry(null)).toBeNull();
    expect(validateMetricEntry('x')).toBeNull();
  });

  it('rejects unknown kind', () => {
    expect(
      validateMetricEntry({ kind: 'bogus', hit: 1, total: 2 }),
    ).toBeNull();
  });

  it('rejects rate with non-integer counts', () => {
    expect(
      validateMetricEntry({
        kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
        hit: 1.5,
        total: 2,
      }),
    ).toBeNull();
    expect(
      validateMetricEntry({
        kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
        hit: -1,
        total: 2,
      }),
    ).toBeNull();
  });

  it('rejects rate when hit > total', () => {
    expect(
      validateMetricEntry({
        kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
        hit: 5,
        total: 2,
      }),
    ).toBeNull();
  });

  it('rejects histogram with non-finite samples', () => {
    expect(
      validateMetricEntry({
        kind: METRIC_KIND.IMMINENT_SLA_ERROR,
        samples: [10, Number.NaN, 30],
      }),
    ).toBeNull();
    expect(
      validateMetricEntry({
        kind: METRIC_KIND.IMMINENT_SLA_ERROR,
        samples: [10, 'x', 30],
      }),
    ).toBeNull();
  });

  it('rejects histogram when samples not array', () => {
    expect(
      validateMetricEntry({
        kind: METRIC_KIND.IMMINENT_SLA_ERROR,
        samples: 'bogus',
      }),
    ).toBeNull();
  });

  it('rejects rate when total missing detection path falls through', () => {
    // total field 자체가 없으면 histogram 분기로 가서 samples 없음 → null
    expect(
      validateMetricEntry({ kind: METRIC_KIND.BOARDING_FALSE_POSITIVE }),
    ).toBeNull();
  });
});

describe('validateMetricBatch', () => {
  it('rejects non-array', () => {
    expect(validateMetricBatch({})).toBeNull();
  });

  it('accepts empty array', () => {
    expect(validateMetricBatch([])).toEqual([]);
  });

  it('accepts mixed valid entries', () => {
    const batch = [
      { kind: METRIC_KIND.BOARDING_FALSE_POSITIVE, hit: 1, total: 2 },
      { kind: METRIC_KIND.IMMINENT_SLA_ERROR, samples: [10, 20] },
    ];
    expect(validateMetricBatch(batch)).toHaveLength(2);
  });

  it('rejects on any invalid entry', () => {
    expect(
      validateMetricBatch([
        { kind: METRIC_KIND.BOARDING_FALSE_POSITIVE, hit: 1, total: 2 },
        { kind: 'bogus', hit: 0, total: 0 },
      ]),
    ).toBeNull();
  });
});
