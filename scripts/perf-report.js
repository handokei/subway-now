/**
 * Phase 3 fusion baseline 지표 리포트 CLI (#827).
 *
 * 입력: JSON MetricEntry 배열 (file path 인자 또는 stdin).
 *   [{ kind, hit, total } | { kind, samples: [...] }, ...]
 *
 * 출력: 사람이 읽을 수 있는 요약 + Phase 4 결정 판정.
 *
 * 사용:
 *   node scripts/perf-report.js metrics.json
 *   cat metrics.json | node scripts/perf-report.js
 *   npm run perf:report -- metrics.json
 *
 * backend `metrics.ts`와 schema 호환 — wrangler tail 또는 Analytics Engine query 결과를
 * 그대로 입력 가능. 외부 의존성 없음 — node fs / process만 사용.
 */

'use strict';

const fs = require('node:fs');

// ───────────────────────────────────────────────────────────────
// Phase 4 결정 임계 — backend metrics.ts와 동기화 (CONST source of truth).
// ───────────────────────────────────────────────────────────────

const SLA_LATE_THRESHOLD_MS = 30_000;
const FALSE_POSITIVE_RATIO_THRESHOLD = 0.05;
const MIN_SAMPLE_FOR_DECISION = 30;

// 지표 카탈로그 — 새 지표 추가 시 키 1개만 늘리면 perf-report 흐름 무수정.
const METRIC_KIND = {
  BOARDING_FALSE_POSITIVE: 'boardingFalsePositiveRate',
  IMMINENT_SLA_ERROR: 'imminentSlaErrorMs',
  STATION_PASSED_ACCURACY: 'stationPassedAccuracy',
  PHASE_CLASSIFICATION_ACCURACY: 'phaseClassificationAccuracy',
  DRIFT_RECOVERY: 'driftRecoveryMeters',
  KALMAN_RESIDUAL: 'kalmanResidual',
};
const KNOWN_KINDS = new Set(Object.values(METRIC_KIND));

// ───────────────────────────────────────────────────────────────
// 통계.
// ───────────────────────────────────────────────────────────────

function percentile(samples, p) {
  if (samples.length === 0) return 0;
  if (p < 0 || p > 1) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[idx];
}

function mean(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const v of samples) sum += v;
  return sum / samples.length;
}

function isRate(entry) {
  return Object.prototype.hasOwnProperty.call(entry, 'total');
}

function summarize(entry) {
  if (isRate(entry)) {
    const value = entry.total === 0 ? 0 : entry.hit / entry.total;
    return {
      kind: entry.kind,
      value,
      p95: 0,
      count: entry.total,
      significant: entry.total >= MIN_SAMPLE_FOR_DECISION,
    };
  }
  return {
    kind: entry.kind,
    value: mean(entry.samples),
    p95: percentile(entry.samples, 0.95),
    count: entry.samples.length,
    significant: entry.samples.length >= MIN_SAMPLE_FOR_DECISION,
  };
}

// ───────────────────────────────────────────────────────────────
// 결정.
// ───────────────────────────────────────────────────────────────

function decidePhaseFour(summaries) {
  const fp = summaries.find((s) => s.kind === METRIC_KIND.BOARDING_FALSE_POSITIVE);
  const sla = summaries.find((s) => s.kind === METRIC_KIND.IMMINENT_SLA_ERROR);
  if (!fp || !sla) {
    return { proceed: false, insufficientSamples: true, triggers: [] };
  }
  if (!fp.significant || !sla.significant) {
    return { proceed: false, insufficientSamples: true, triggers: [] };
  }
  const triggers = [];
  if (fp.value > FALSE_POSITIVE_RATIO_THRESHOLD) triggers.push('falsePositive');
  if (sla.p95 > SLA_LATE_THRESHOLD_MS) triggers.push('imminentSla');
  return { proceed: triggers.length > 0, insufficientSamples: false, triggers };
}

// ───────────────────────────────────────────────────────────────
// 입력 검증.
// ───────────────────────────────────────────────────────────────

function validateEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!KNOWN_KINDS.has(raw.kind)) return null;
  if ('total' in raw) {
    const { hit, total } = raw;
    if (!Number.isInteger(hit) || hit < 0) return null;
    if (!Number.isInteger(total) || total < 0) return null;
    if (hit > total) return null;
    return { kind: raw.kind, hit, total };
  }
  if (!Array.isArray(raw.samples)) return null;
  for (const v of raw.samples) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  }
  return { kind: raw.kind, samples: raw.samples };
}

function validateBatch(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw) {
    const v = validateEntry(entry);
    if (!v) return null;
    out.push(v);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────
// 리포트 빌드 — 순수 함수, IO 없음. CLI smoke 테스트 진입점.
// ───────────────────────────────────────────────────────────────

function buildReport(entries) {
  const summaries = entries.map(summarize);
  const decision = decidePhaseFour(summaries);
  return { summaries, decision };
}

function formatSummary(summary) {
  const pct = (n) => `${(n * 100).toFixed(2)}%`;
  if (summary.kind === METRIC_KIND.BOARDING_FALSE_POSITIVE) {
    return `  ${summary.kind}: ${pct(summary.value)} (n=${summary.count}${summary.significant ? '' : ', insufficient'})`;
  }
  if (
    summary.kind === METRIC_KIND.STATION_PASSED_ACCURACY ||
    summary.kind === METRIC_KIND.PHASE_CLASSIFICATION_ACCURACY
  ) {
    return `  ${summary.kind}: ${pct(summary.value)} (n=${summary.count}${summary.significant ? '' : ', insufficient'})`;
  }
  return `  ${summary.kind}: mean=${summary.value.toFixed(2)} p95=${summary.p95.toFixed(2)} (n=${summary.count}${summary.significant ? '' : ', insufficient'})`;
}

function formatReport(report) {
  const lines = ['Phase 3 fusion metrics report', '----------------------------'];
  for (const s of report.summaries) {
    lines.push(formatSummary(s));
  }
  lines.push('');
  lines.push('Phase 4 decision');
  lines.push('----------------');
  if (report.decision.insufficientSamples) {
    lines.push(
      `  HOLD — insufficient samples (need >= ${MIN_SAMPLE_FOR_DECISION} each)`,
    );
  } else if (report.decision.proceed) {
    lines.push(
      `  PROCEED — review Phase 4 (Particle filter). triggers: ${report.decision.triggers.join(', ')}`,
    );
  } else {
    lines.push('  SKIP — within thresholds. stamp ADR.');
  }
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────
// IO — CLI entry.
// ───────────────────────────────────────────────────────────────

/* istanbul ignore next — fd 0 동기 read는 단위 테스트에서 안전히 호출 불가. main()에서 env.stdin 주입으로 우회. */
function readStdinSync() {
  return fs.readFileSync(0, 'utf8');
}

function parseInput(argv, env) {
  // 인자 우선, 없으면 env.stdin(테스트 주입), 그 외 process stdin.
  const file = argv[2];
  if (file) return fs.readFileSync(file, 'utf8');
  /* istanbul ignore else — non-string stdin은 단위 테스트에서 fd 0 read와 동일 분기. */
  if (typeof env.stdin === 'string') return env.stdin;
  /* istanbul ignore next — readStdinSync 분기는 IO 부수효과로 테스트 불가. */
  return readStdinSync();
}

function main(argv, env = {}) {
  const writeOut = env.writeOut || ((msg) => process.stdout.write(`${msg}\n`));
  const writeErr = env.writeErr || ((msg) => process.stderr.write(`${msg}\n`));
  let raw;
  try {
    raw = parseInput(argv, env);
  } catch (e) {
    writeErr(`perf-report: failed to read input — ${e.message}`);
    return 1;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    writeErr(`perf-report: invalid JSON — ${e.message}`);
    return 1;
  }
  const batch = validateBatch(parsed);
  if (!batch) {
    writeErr('perf-report: payload schema invalid');
    return 1;
  }
  const report = buildReport(batch);
  writeOut(formatReport(report));
  return 0;
}

module.exports = {
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
};

// CLI 진입 — require로 import 시는 실행 안 함.
/* istanbul ignore if — require.main 분기는 단위 테스트 환경에서 진입 안 함. */
if (require.main === module) {
  process.exit(main(process.argv));
}
