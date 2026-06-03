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
 * 카탈로그 SSOT:
 *   `backend/alarm-worker/src/metrics.catalog.json` — backend metrics.ts와 공유.
 *   새 지표/임계 추가 시 JSON 1곳만 수정하면 양쪽이 동일하게 반영된다.
 *
 * 외부 의존성 없음 — node fs / process만 사용.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ───────────────────────────────────────────────────────────────
// 카탈로그 — backend metrics.ts와 단일 JSON SSOT 공유.
// ───────────────────────────────────────────────────────────────

const CATALOG_PATH = path.resolve(
  __dirname,
  '..',
  'backend',
  'alarm-worker',
  'src',
  'metrics.catalog.json',
);

/* istanbul ignore next — catalog 로드 실패는 빌드/배포 사고이고 단위 테스트로 재현 불가. */
function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}

const CATALOG = loadCatalog();

const SLA_LATE_THRESHOLD_MS = CATALOG.constants.SLA_LATE_THRESHOLD_MS;
const FALSE_POSITIVE_RATIO_THRESHOLD = CATALOG.constants.FALSE_POSITIVE_RATIO_THRESHOLD;
const MIN_SAMPLE_FOR_DECISION = CATALOG.constants.MIN_SAMPLE_FOR_DECISION;
const SLA_PERCENTILE = CATALOG.constants.SLA_PERCENTILE;

// 카탈로그의 constantName → key 매핑 — 기존 호출자 호환.
const METRIC_KIND = Object.freeze(
  CATALOG.metrics.reduce((acc, m) => {
    acc[m.constantName] = m.key;
    return acc;
  }, {}),
);

const KNOWN_KINDS = new Set(CATALOG.metrics.map((m) => m.key));
const METRIC_BY_KEY = new Map(CATALOG.metrics.map((m) => [m.key, m]));

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
    p95: percentile(entry.samples, SLA_PERCENTILE),
    count: entry.samples.length,
    significant: entry.samples.length >= MIN_SAMPLE_FOR_DECISION,
  };
}

// ───────────────────────────────────────────────────────────────
// 결정 — 카탈로그의 gate 메타를 순회. 새 게이트 추가 시 분기 무수정.
// ───────────────────────────────────────────────────────────────

function gatedEntries() {
  return CATALOG.metrics.filter((m) => m.gate);
}

function gateValue(summary, gate) {
  return gate.field === 'p95' ? summary.p95 : summary.value;
}

function gateThreshold(gate) {
  return CATALOG.constants[gate.thresholdConst];
}

function gateBreached(summary, gate) {
  const threshold = gateThreshold(gate);
  const v = gateValue(summary, gate);
  // 현재 op는 '>'만 지원 — 카탈로그 확장 시 분기 추가.
  return gate.op === '>' && v > threshold;
}

function decidePhaseFour(summaries) {
  const byKind = new Map(summaries.map((s) => [s.kind, s]));
  const gates = gatedEntries();
  for (const entry of gates) {
    const s = byKind.get(entry.key);
    if (!s || !s.significant) {
      return { proceed: false, insufficientSamples: true, triggers: [] };
    }
  }
  const triggers = [];
  for (const entry of gates) {
    const s = byKind.get(entry.key);
    if (gateBreached(s, entry.gate)) triggers.push(entry.gate.triggerName);
  }
  return { proceed: triggers.length > 0, insufficientSamples: false, triggers };
}

// ───────────────────────────────────────────────────────────────
// 입력 검증 — 카탈로그 format에 따라 분기.
// ───────────────────────────────────────────────────────────────

function validateEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!KNOWN_KINDS.has(raw.kind)) return null;
  const meta = METRIC_BY_KEY.get(raw.kind);
  if (meta && meta.format === 'rate') {
    const { hit, total } = raw;
    if (!Number.isInteger(hit) || hit < 0) return null;
    if (!Number.isInteger(total) || total < 0) return null;
    if (hit > total) return null;
    return { kind: raw.kind, hit, total };
  }
  // histogram (or unknown — safety net으로 histogram 처리)
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
// 카탈로그 display에 따라 포맷 분기 (percentage / numeric). if 체인 없음.
// ───────────────────────────────────────────────────────────────

function buildReport(entries) {
  const summaries = entries.map(summarize);
  const decision = decidePhaseFour(summaries);
  return { summaries, decision };
}

const PERCENTILE_LABEL = `p${Math.round(SLA_PERCENTILE * 100)}`;

function formatSummary(summary) {
  const meta = METRIC_BY_KEY.get(summary.kind);
  const sampleTag = `n=${summary.count}${summary.significant ? '' : ', insufficient'}`;
  // display 메타가 누락된 경우는 안전 폴백으로 numeric.
  const display = meta ? meta.display : 'numeric';
  if (display === 'percentage') {
    const pct = `${(summary.value * 100).toFixed(2)}%`;
    return `  ${summary.kind}: ${pct} (${sampleTag})`;
  }
  // numeric / histogram
  return `  ${summary.kind}: mean=${summary.value.toFixed(2)} ${PERCENTILE_LABEL}=${summary.p95.toFixed(2)} (${sampleTag})`;
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
  METRIC_CATALOG: CATALOG.metrics,
  SLA_LATE_THRESHOLD_MS,
  FALSE_POSITIVE_RATIO_THRESHOLD,
  MIN_SAMPLE_FOR_DECISION,
  SLA_PERCENTILE,
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

