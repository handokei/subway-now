/**
 * perf-report (#827) — 순수 함수 + CLI smoke 검증.
 *
 * golden MetricEntry 입력 → expected 수치/Phase 4 결정 일치 확인.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  METRIC_KIND,
  SLA_LATE_THRESHOLD_MS,
  FALSE_POSITIVE_RATIO_THRESHOLD,
  MIN_SAMPLE_FOR_DECISION,
  percentile,
  mean,
  isRate,
  summarize,
  decidePhaseFour,
  validateEntry,
  validateBatch,
  buildReport,
  formatSummary,
  formatReport,
  main,
} = require('../perf-report');

describe('percentile', () => {
  it('returns 0 for empty', () => {
    expect(percentile([], 0.95)).toBe(0);
  });
  it('computes p95 on 1..100 → 95', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(samples, 0.95)).toBe(95);
  });
  it('clamps to last index when p=1', () => {
    expect(percentile([1, 2, 3], 1)).toBe(3);
  });
  it('returns 0 for out-of-range p', () => {
    expect(percentile([1, 2], -0.1)).toBe(0);
    expect(percentile([1, 2], 1.1)).toBe(0);
  });
});

describe('mean', () => {
  it('returns 0 for empty', () => {
    expect(mean([])).toBe(0);
  });
  it('averages numbers', () => {
    expect(mean([2, 4, 6])).toBe(4);
  });
});

describe('isRate', () => {
  it('detects total field', () => {
    expect(isRate({ hit: 1, total: 2 })).toBe(true);
  });
  it('histogram has no total', () => {
    expect(isRate({ samples: [] })).toBe(false);
  });
});

describe('summarize', () => {
  it('summarizes rate (0 total → 0 value)', () => {
    const result = summarize({
      kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
      hit: 0,
      total: 0,
    });
    expect(result.value).toBe(0);
    expect(result.significant).toBe(false);
  });
  it('marks rate significant beyond threshold', () => {
    const result = summarize({
      kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
      hit: 3,
      total: MIN_SAMPLE_FOR_DECISION,
    });
    expect(result.significant).toBe(true);
    expect(result.value).toBeCloseTo(3 / MIN_SAMPLE_FOR_DECISION);
  });
  it('summarizes histogram', () => {
    const samples = Array.from({ length: 40 }, (_, i) => i + 1);
    const result = summarize({
      kind: METRIC_KIND.IMMINENT_SLA_ERROR,
      samples,
    });
    expect(result.count).toBe(40);
    expect(result.p95).toBe(38);
    expect(result.significant).toBe(true);
  });
});

describe('decidePhaseFour', () => {
  const sufficient = (kind, value, p95) => ({
    kind,
    value,
    p95,
    count: MIN_SAMPLE_FOR_DECISION,
    significant: true,
  });

  it('insufficient when fp missing', () => {
    const d = decidePhaseFour([
      sufficient(METRIC_KIND.IMMINENT_SLA_ERROR, 100, 100),
    ]);
    expect(d.insufficientSamples).toBe(true);
  });

  it('insufficient when sla missing', () => {
    const d = decidePhaseFour([
      sufficient(METRIC_KIND.BOARDING_FALSE_POSITIVE, 0.01, 0),
    ]);
    expect(d.insufficientSamples).toBe(true);
  });

  it('insufficient when fp significant=false', () => {
    const d = decidePhaseFour([
      { ...sufficient(METRIC_KIND.BOARDING_FALSE_POSITIVE, 0, 0), significant: false },
      sufficient(METRIC_KIND.IMMINENT_SLA_ERROR, 100, 100),
    ]);
    expect(d.insufficientSamples).toBe(true);
  });

  it('insufficient when sla significant=false', () => {
    const d = decidePhaseFour([
      sufficient(METRIC_KIND.BOARDING_FALSE_POSITIVE, 0.01, 0),
      { ...sufficient(METRIC_KIND.IMMINENT_SLA_ERROR, 100, 100), significant: false },
    ]);
    expect(d.insufficientSamples).toBe(true);
  });

  it('skip when within thresholds', () => {
    const d = decidePhaseFour([
      sufficient(METRIC_KIND.BOARDING_FALSE_POSITIVE, FALSE_POSITIVE_RATIO_THRESHOLD, 0),
      sufficient(METRIC_KIND.IMMINENT_SLA_ERROR, 0, SLA_LATE_THRESHOLD_MS),
    ]);
    expect(d.proceed).toBe(false);
    expect(d.triggers).toEqual([]);
  });

  it('triggers on fp breach', () => {
    const d = decidePhaseFour([
      sufficient(
        METRIC_KIND.BOARDING_FALSE_POSITIVE,
        FALSE_POSITIVE_RATIO_THRESHOLD + 0.01,
        0,
      ),
      sufficient(METRIC_KIND.IMMINENT_SLA_ERROR, 0, SLA_LATE_THRESHOLD_MS),
    ]);
    expect(d.proceed).toBe(true);
    expect(d.triggers).toEqual(['falsePositive']);
  });

  it('triggers on sla breach', () => {
    const d = decidePhaseFour([
      sufficient(METRIC_KIND.BOARDING_FALSE_POSITIVE, 0, 0),
      sufficient(METRIC_KIND.IMMINENT_SLA_ERROR, 0, SLA_LATE_THRESHOLD_MS + 1),
    ]);
    expect(d.proceed).toBe(true);
    expect(d.triggers).toEqual(['imminentSla']);
  });
});

describe('validateEntry', () => {
  it('accepts rate', () => {
    expect(validateEntry({ kind: METRIC_KIND.BOARDING_FALSE_POSITIVE, hit: 1, total: 2 })).toEqual({
      kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
      hit: 1,
      total: 2,
    });
  });
  it('accepts histogram', () => {
    expect(validateEntry({ kind: METRIC_KIND.IMMINENT_SLA_ERROR, samples: [1, 2] })).toEqual({
      kind: METRIC_KIND.IMMINENT_SLA_ERROR,
      samples: [1, 2],
    });
  });
  it('rejects non-object', () => {
    expect(validateEntry(null)).toBeNull();
    expect(validateEntry('x')).toBeNull();
  });
  it('rejects unknown kind', () => {
    expect(validateEntry({ kind: 'bogus', hit: 0, total: 0 })).toBeNull();
  });
  it('rejects rate with negative count', () => {
    expect(
      validateEntry({ kind: METRIC_KIND.BOARDING_FALSE_POSITIVE, hit: -1, total: 0 }),
    ).toBeNull();
  });
  it('rejects rate with non-integer', () => {
    expect(
      validateEntry({ kind: METRIC_KIND.BOARDING_FALSE_POSITIVE, hit: 1.5, total: 2 }),
    ).toBeNull();
  });
  it('rejects rate when total < hit', () => {
    expect(
      validateEntry({ kind: METRIC_KIND.BOARDING_FALSE_POSITIVE, hit: 5, total: 2 }),
    ).toBeNull();
  });
  it('rejects rate with negative total', () => {
    expect(
      validateEntry({ kind: METRIC_KIND.BOARDING_FALSE_POSITIVE, hit: 0, total: -1 }),
    ).toBeNull();
  });
  it('rejects histogram with non-array samples', () => {
    expect(validateEntry({ kind: METRIC_KIND.IMMINENT_SLA_ERROR, samples: 'x' })).toBeNull();
  });
  it('rejects histogram with non-finite samples', () => {
    expect(
      validateEntry({ kind: METRIC_KIND.IMMINENT_SLA_ERROR, samples: [1, NaN] }),
    ).toBeNull();
    expect(
      validateEntry({ kind: METRIC_KIND.IMMINENT_SLA_ERROR, samples: [1, 'x'] }),
    ).toBeNull();
  });
});

describe('validateBatch', () => {
  it('rejects non-array', () => {
    expect(validateBatch({})).toBeNull();
  });
  it('accepts empty', () => {
    expect(validateBatch([])).toEqual([]);
  });
  it('rejects on invalid entry', () => {
    expect(
      validateBatch([
        { kind: METRIC_KIND.BOARDING_FALSE_POSITIVE, hit: 0, total: 0 },
        { kind: 'bogus' },
      ]),
    ).toBeNull();
  });
});

describe('buildReport + formatReport', () => {
  const golden = [
    {
      kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
      hit: 1,
      total: 50,
    },
    {
      kind: METRIC_KIND.IMMINENT_SLA_ERROR,
      samples: Array.from({ length: 40 }, (_, i) => 1000 + i * 100),
    },
    {
      kind: METRIC_KIND.STATION_PASSED_ACCURACY,
      hit: 48,
      total: 50,
    },
    {
      kind: METRIC_KIND.PHASE_CLASSIFICATION_ACCURACY,
      hit: 30,
      total: 40,
    },
    {
      kind: METRIC_KIND.DRIFT_RECOVERY,
      samples: [5, 10, 15],
    },
    {
      kind: METRIC_KIND.KALMAN_RESIDUAL,
      samples: [0.1, 0.2, 0.3],
    },
  ];

  it('reports summaries and SKIP decision (within thresholds)', () => {
    const report = buildReport(golden);
    expect(report.summaries).toHaveLength(6);
    expect(report.decision.insufficientSamples).toBe(false);
    expect(report.decision.proceed).toBe(false);
  });

  it('formatReport lists every summary and SKIP line', () => {
    const text = formatReport(buildReport(golden));
    expect(text).toContain(METRIC_KIND.BOARDING_FALSE_POSITIVE);
    expect(text).toContain(METRIC_KIND.IMMINENT_SLA_ERROR);
    expect(text).toContain(METRIC_KIND.STATION_PASSED_ACCURACY);
    expect(text).toContain('SKIP');
  });

  it('formatReport HOLD when insufficient samples', () => {
    const minimal = [{ kind: METRIC_KIND.BOARDING_FALSE_POSITIVE, hit: 0, total: 0 }];
    expect(formatReport(buildReport(minimal))).toContain('HOLD');
  });

  it('formatReport PROCEED when fp breach', () => {
    const breach = [
      {
        kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
        hit: MIN_SAMPLE_FOR_DECISION,
        total: MIN_SAMPLE_FOR_DECISION,
      },
      {
        kind: METRIC_KIND.IMMINENT_SLA_ERROR,
        samples: Array.from({ length: MIN_SAMPLE_FOR_DECISION }, () => 0),
      },
    ];
    expect(formatReport(buildReport(breach))).toContain('PROCEED');
  });
});

describe('formatSummary', () => {
  it('formats rate metric as percentage', () => {
    const text = formatSummary({
      kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
      value: 0.05,
      p95: 0,
      count: 100,
      significant: true,
    });
    expect(text).toContain('5.00%');
    expect(text).toContain('n=100');
  });

  it('marks insufficient samples', () => {
    const text = formatSummary({
      kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
      value: 0,
      p95: 0,
      count: 1,
      significant: false,
    });
    expect(text).toContain('insufficient');
  });

  it('formats accuracy metric as percentage', () => {
    const text = formatSummary({
      kind: METRIC_KIND.STATION_PASSED_ACCURACY,
      value: 0.98,
      p95: 0,
      count: 100,
      significant: true,
    });
    expect(text).toContain('98.00%');
  });

  it('marks insufficient on accuracy metric below threshold', () => {
    const text = formatSummary({
      kind: METRIC_KIND.PHASE_CLASSIFICATION_ACCURACY,
      value: 0,
      p95: 0,
      count: 2,
      significant: false,
    });
    expect(text).toContain('insufficient');
  });

  it('marks insufficient on histogram below threshold', () => {
    const text = formatSummary({
      kind: METRIC_KIND.DRIFT_RECOVERY,
      value: 0,
      p95: 0,
      count: 1,
      significant: false,
    });
    expect(text).toContain('insufficient');
  });

  it('formats histogram with mean and p95', () => {
    const text = formatSummary({
      kind: METRIC_KIND.IMMINENT_SLA_ERROR,
      value: 1500.5,
      p95: 2800.25,
      count: 40,
      significant: true,
    });
    expect(text).toContain('mean=1500.50');
    expect(text).toContain('p95=2800.25');
  });
});

// ───────────────────────────────────────────────────────────────
// CLI smoke.
// ───────────────────────────────────────────────────────────────

describe('main (CLI smoke)', () => {
  function makeEnv() {
    const out = [];
    const err = [];
    return {
      stdin: '[]',
      writeOut: (msg) => out.push(msg),
      writeErr: (msg) => err.push(msg),
      out,
      err,
    };
  }

  it('reads from stdin when no file arg, prints HOLD on empty batch', () => {
    const env = makeEnv();
    const code = main(['node', 'perf-report'], env);
    expect(code).toBe(0);
    expect(env.out.join('\n')).toContain('HOLD');
  });

  it('reads from file path when given', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-report-'));
    const filePath = path.join(dir, 'm.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify([
        { kind: METRIC_KIND.BOARDING_FALSE_POSITIVE, hit: 1, total: MIN_SAMPLE_FOR_DECISION },
        {
          kind: METRIC_KIND.IMMINENT_SLA_ERROR,
          samples: Array.from({ length: MIN_SAMPLE_FOR_DECISION }, () => 1000),
        },
      ]),
    );
    const env = makeEnv();
    const code = main(['node', 'perf-report', filePath], env);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(env.out.join('\n')).toContain('Phase 4 decision');
  });

  it('exits 1 on invalid JSON', () => {
    const env = makeEnv();
    env.stdin = 'not-json{';
    const code = main(['node', 'perf-report'], env);
    expect(code).toBe(1);
    expect(env.err.join('\n')).toContain('invalid JSON');
  });

  it('exits 1 on schema mismatch', () => {
    const env = makeEnv();
    env.stdin = JSON.stringify([{ kind: 'bogus' }]);
    const code = main(['node', 'perf-report'], env);
    expect(code).toBe(1);
    expect(env.err.join('\n')).toContain('schema invalid');
  });

  it('exits 1 when file read fails', () => {
    const env = makeEnv();
    const code = main(['node', 'perf-report', '/nonexistent/path-zzz.json'], env);
    expect(code).toBe(1);
    expect(env.err.join('\n')).toContain('failed to read');
  });

  it('uses default writers (process.stdout/stderr) when env omitted', () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // 인자만 주고 env는 비움 — writeOut/writeErr fallback 분기 진입.
    // file arg로 즉시 실패해 stderr 폴백을 검증, 그 외 분기는 invalid JSON로 동일 path.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-report-default-'));
    const okPath = path.join(dir, 'ok.json');
    fs.writeFileSync(okPath, '[]');
    expect(main(['node', 'perf-report', okPath])).toBe(0);
    expect(stdoutSpy).toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(main(['node', 'perf-report', '/no/such/path-yyy.json'])).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
