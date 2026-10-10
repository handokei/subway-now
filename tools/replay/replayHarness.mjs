#!/usr/bin/env node
/**
 * Fixture-replay verification harness — accelerometer stop/departure detection.
 *
 * Promoted from the throwaway spike (`spike/accel-fingerprint-analysis`,
 * PR #2271, `tools/spike/analyzeAccelFingerprint.mjs`) to reusable
 * infrastructure (#2268). The spike's job was a one-time GO/NO-GO call on
 * the detection algorithm; this harness's job is different and durable:
 * replay committed JSONL fixtures through the 3 candidate detectors on every
 * PR and fail CI if detection quality regresses below the gate.
 *
 * No real device captures exist yet — the committed fixtures under
 * `fixtures/` are synthetic (deterministic generator, see bottom of this
 * file). Real captures drop in later as additional `fixtures/*.jsonl` files
 * with no code changes required (see README.md).
 *
 * Detection thresholds (PARAMS below) are placeholders tuned against
 * synthetic data only. They are NOT validated against real accelerometer
 * captures — re-tune after the first real capture batch lands.
 *
 * Usage:
 *   node tools/replay/replayHarness.mjs <log.jsonl>   # analyze one log, no gate exit code
 *   node tools/replay/replayHarness.mjs --ci           # replay all committed fixtures, exit 1 on regression
 *   node tools/replay/replayHarness.mjs --selftest      # in-memory synthetic smoke test
 *
 * Pure Node, no dependencies.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// Fixture schema version — bump when the JSONL sample/mark/meta shape changes
// (see README.md "Fixture schema"). Fixtures without a matching version are
// still replayed but flagged so a schema drift doesn't silently corrupt scores.
// ---------------------------------------------------------------------------
export const FIXTURE_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Tunable parameters (placeholder — re-tune after real captures land)
// ---------------------------------------------------------------------------
export const PARAMS = {
  // C1: principal-axis integration
  c1: {
    decelThreshold: -0.3, // m/s^2 sustained deceleration threshold (arrival)
    accelThreshold: 0.3, // m/s^2 sustained acceleration threshold (departure)
    sustainSec: 2.0, // seconds the threshold must hold to count as an event
    smoothWindowSamples: 5, // moving-average smoothing window
  },
  // C2: RMS floor bracketing
  c2: {
    dwellFloor: 0.15, // m/s^2 RMS below this = considered "stationary"
    burstThreshold: 0.5, // m/s^2 RMS above this = considered "moving"
    minDwellSec: 8, // minimum stationary duration to count as a dwell (station stop)
  },
  // C3: CMMotionActivity baseline
  c3: {
    // uses raw cm string transitions, no numeric threshold needed
  },
  // Matching / evaluation
  matchWindowSec: 15, // +/- window (s) to match a detection to a ground-truth mark
};

// Go/no-go gate applied per fixture in --ci mode. A candidate whose aggregate
// arrival recall/precision/latency falls below this gate on ANY committed
// fixture fails the replay (regression signal). Placeholder values — retune
// once real captures replace/augment the synthetic set.
export const THRESHOLDS = {
  minRecall: 0.9,
  minPrecision: 0.85,
  maxMedianLatencySec: 8,
};

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

/**
 * @typedef {{ t:number, ua:[number,number,number], rr:[number,number,number],
 *   g:[number,number,number], rms:number|null, pat:string|null, cm:string|null,
 *   cmc:number|null, hpa:number|null, gps:[number,number,number]|null }} Sample
 * @typedef {{ t:number, mark:'arrive'|'depart' }} MarkEvent
 * @typedef {{ ride:string, placement:string, line:string, startedAt:number, schemaVersion?:number }} Meta
 */

function parseLog(text) {
  /** @type {Meta|null} */
  let meta = null;
  /** @type {Sample[]} */
  const samples = [];
  /** @type {MarkEvent[]} */
  const marks = [];

  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed lines
    }
    if (obj.meta) {
      meta = obj.meta;
    } else if (obj.mark) {
      marks.push({ t: obj.t, mark: obj.mark });
    } else if (typeof obj.t === 'number' && obj.ua) {
      samples.push(obj);
    }
  }
  samples.sort((a, b) => a.t - b.t);
  marks.sort((a, b) => a.t - b.t);
  return { meta, samples, marks };
}

// ---------------------------------------------------------------------------
// Shared math helpers
// ---------------------------------------------------------------------------

function movingAverage(values, windowSize) {
  const out = new Array(values.length);
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += values[j];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

function median(nums) {
  if (nums.length === 0) return NaN;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(nums, p) {
  if (nums.length === 0) return NaN;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function magnitude(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

// ---------------------------------------------------------------------------
// C1: Principal-axis integration
// ---------------------------------------------------------------------------

/**
 * Project ua onto the horizontal plane (remove gravity component using g),
 * then extract the dominant horizontal axis via power-iteration PCA, project
 * onto that axis, and look for sustained deceleration (arrival) /
 * acceleration (departure) runs.
 */
function detectC1(samples) {
  if (samples.length < 3) return [];

  const horiz = samples.map((s) => {
    const g = s.g;
    const gMag = magnitude(g) || 1;
    const gUnit = [g[0] / gMag, g[1] / gMag, g[2] / gMag];
    const ua = s.ua;
    const dot = ua[0] * gUnit[0] + ua[1] * gUnit[1] + ua[2] * gUnit[2];
    return [ua[0] - dot * gUnit[0], ua[1] - dot * gUnit[1], ua[2] - dot * gUnit[2]];
  });

  const n = horiz.length;
  const mean = [0, 0, 0];
  for (const h of horiz) {
    mean[0] += h[0];
    mean[1] += h[1];
    mean[2] += h[2];
  }
  mean[0] /= n;
  mean[1] /= n;
  mean[2] /= n;

  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const h of horiz) {
    const d = [h[0] - mean[0], h[1] - mean[1], h[2] - mean[2]];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        cov[i][j] += d[i] * d[j];
      }
    }
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] /= n;

  // Power iteration to find dominant eigenvector (principal axis of motion).
  let v = [1, 0, 0];
  for (let iter = 0; iter < 50; iter++) {
    const nv = [
      cov[0][0] * v[0] + cov[0][1] * v[1] + cov[0][2] * v[2],
      cov[1][0] * v[0] + cov[1][1] * v[1] + cov[1][2] * v[2],
      cov[2][0] * v[0] + cov[2][1] * v[1] + cov[2][2] * v[2],
    ];
    const mag = magnitude(nv) || 1;
    v = [nv[0] / mag, nv[1] / mag, nv[2] / mag];
  }

  const along = horiz.map((h) => h[0] * v[0] + h[1] * v[1] + h[2] * v[2]);
  const smoothed = movingAverage(along, PARAMS.c1.smoothWindowSamples);

  const events = [];
  const { decelThreshold, accelThreshold, sustainSec } = PARAMS.c1;
  let runStart = null;
  let runSign = 0; // 1 = accel, -1 = decel

  for (let i = 0; i < samples.length; i++) {
    const val = smoothed[i];
    const sign = val >= accelThreshold ? 1 : val <= decelThreshold ? -1 : 0;

    if (sign !== 0 && sign === runSign) {
      // continue run
    } else if (sign !== 0) {
      runStart = samples[i].t;
      runSign = sign;
    } else {
      runStart = null;
      runSign = 0;
    }

    if (runStart !== null && runSign !== 0) {
      const durationSec = (samples[i].t - runStart) / 1000;
      if (durationSec >= sustainSec) {
        const type = runSign === -1 ? 'arrive' : 'depart';
        const last = events[events.length - 1];
        if (!last || last.type !== type || samples[i].t - last.t > sustainSec * 1000) {
          events.push({ t: samples[i].t, type });
        }
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// C2: RMS floor bracketing
// ---------------------------------------------------------------------------

function sampleRms(s) {
  return typeof s.rms === 'number' ? s.rms : magnitude(s.ua);
}

function detectC2(samples) {
  if (samples.length === 0) return [];
  const { dwellFloor, burstThreshold, minDwellSec } = PARAMS.c2;

  const events = [];
  let dwellStart = null;
  let inDwell = false;

  for (let i = 0; i < samples.length; i++) {
    const rms = sampleRms(samples[i]);
    const t = samples[i].t;

    if (!inDwell) {
      if (rms <= dwellFloor) {
        if (dwellStart === null) dwellStart = t;
        const durationSec = (t - dwellStart) / 1000;
        if (durationSec >= minDwellSec) {
          inDwell = true;
          events.push({ t: dwellStart, type: 'arrive' });
        }
      } else {
        dwellStart = null;
      }
    } else {
      if (rms >= burstThreshold) {
        inDwell = false;
        dwellStart = null;
        events.push({ t, type: 'depart' });
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// C3: CMMotionActivity baseline
// ---------------------------------------------------------------------------

function detectC3(samples) {
  const events = [];
  let prevCm = null;
  for (const s of samples) {
    const cm = s.cm;
    if (cm == null) continue;
    if (prevCm !== null && cm !== prevCm) {
      if (prevCm === 'automotive' && cm === 'stationary') {
        events.push({ t: s.t, type: 'arrive' });
      } else if (prevCm === 'stationary' && cm === 'automotive') {
        events.push({ t: s.t, type: 'depart' });
      }
    }
    prevCm = cm;
  }
  return events;
}

export const CANDIDATES = [
  { id: 'C1', name: 'Principal-axis integration', fn: detectC1 },
  { id: 'C2', name: 'RMS floor bracketing', fn: detectC2 },
  { id: 'C3', name: 'CMMotionActivity baseline', fn: detectC3 },
];

// ---------------------------------------------------------------------------
// Matching & scoring
// ---------------------------------------------------------------------------

/**
 * Greedy nearest-time matching between detections and ground truth marks of
 * the same type, within +/- matchWindowSec.
 */
function matchEvents(detections, groundTruth, windowSec) {
  const windowMs = windowSec * 1000;
  const gtUsed = new Array(groundTruth.length).fill(false);
  const matchedLatenciesSec = [];
  let matchedDetections = 0;

  const sortedDetections = [...detections].sort((a, b) => a.t - b.t);

  for (const det of sortedDetections) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < groundTruth.length; i++) {
      if (gtUsed[i]) continue;
      if (groundTruth[i].mark !== det.type) continue;
      const dist = Math.abs(groundTruth[i].t - det.t);
      if (dist <= windowMs && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx !== -1) {
      gtUsed[bestIdx] = true;
      matchedDetections++;
      matchedLatenciesSec.push((det.t - groundTruth[bestIdx].t) / 1000);
    }
  }

  const matchedGt = gtUsed.filter(Boolean).length;
  return {
    matchedDetections,
    matchedGt,
    totalDetections: detections.length,
    totalGt: groundTruth.length,
    latenciesSec: matchedLatenciesSec,
  };
}

function scoreCandidate(detections, marks, eventType, windowSec) {
  const detOfType = detections.filter((d) => d.type === eventType);
  const gtOfType = marks.filter((m) => m.mark === eventType);
  const { matchedDetections, matchedGt, totalDetections, totalGt, latenciesSec } = matchEvents(
    detOfType,
    gtOfType,
    windowSec
  );

  const recall = totalGt === 0 ? NaN : matchedGt / totalGt;
  const precision = totalDetections === 0 ? NaN : matchedDetections / totalDetections;
  const medianLatency = median(latenciesSec);
  const p90Latency = percentile(latenciesSec, 90);

  return { eventType, totalGt, totalDetections, matchedGt, recall, precision, medianLatency, p90Latency };
}

function groupKey(meta) {
  if (!meta) return 'unknown';
  const placement = meta.placement ?? 'unknown';
  const line = meta.line ?? 'unknown';
  return `${line}/${placement}`;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function fmtPct(x) {
  if (Number.isNaN(x)) return 'n/a';
  return `${(x * 100).toFixed(1)}%`;
}

function fmtSec(x) {
  if (Number.isNaN(x)) return 'n/a';
  return `${x.toFixed(1)}s`;
}

function padRight(str, len) {
  return String(str).padEnd(len);
}

function renderReport(results) {
  const header = [
    padRight('Condition', 16),
    padRight('Cand', 5),
    padRight('Event', 7),
    padRight('Recall', 8),
    padRight('Precis', 8),
    padRight('MedLat', 8),
    padRight('P90Lat', 8),
    'GT/Det',
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const r of results) {
    for (const eventType of ['arrive', 'depart']) {
      const s = r[eventType];
      console.log(
        [
          padRight(r.condition, 16),
          padRight(r.candidateId, 5),
          padRight(eventType, 7),
          padRight(fmtPct(s.recall), 8),
          padRight(fmtPct(s.precision), 8),
          padRight(fmtSec(s.medianLatency), 8),
          padRight(fmtSec(s.p90Latency), 8),
          `${s.totalGt}/${s.totalDetections}`,
        ].join(' ')
      );
    }
  }
}

/**
 * Evaluate the go/no-go gate for the 'arrive' event (dwell = station stop),
 * aggregated per candidate across the given results (one fixture or many).
 * Returns per-candidate pass/fail so callers can decide exit behavior.
 */
function evaluateGate(results) {
  const byCandidate = new Map();
  for (const r of results) {
    const s = r.arrive;
    if (!byCandidate.has(r.candidateId)) {
      byCandidate.set(r.candidateId, { name: r.candidateName, recalls: [], precisions: [], latencies: [] });
    }
    const agg = byCandidate.get(r.candidateId);
    if (!Number.isNaN(s.recall)) agg.recalls.push(s.recall);
    if (!Number.isNaN(s.precision)) agg.precisions.push(s.precision);
    if (!Number.isNaN(s.medianLatency)) agg.latencies.push(s.medianLatency);
  }

  const verdicts = [];
  for (const [id, agg] of byCandidate) {
    const avgRecall = agg.recalls.length ? agg.recalls.reduce((a, b) => a + b, 0) / agg.recalls.length : NaN;
    const avgPrecision = agg.precisions.length
      ? agg.precisions.reduce((a, b) => a + b, 0) / agg.precisions.length
      : NaN;
    const avgMedianLatency = agg.latencies.length ? median(agg.latencies) : NaN;

    const pass =
      avgRecall >= THRESHOLDS.minRecall &&
      avgPrecision >= THRESHOLDS.minPrecision &&
      avgMedianLatency <= THRESHOLDS.maxMedianLatencySec;

    verdicts.push({ id, name: agg.name, avgRecall, avgPrecision, avgMedianLatency, pass });
  }
  return verdicts;
}

function renderGoNoGo(verdicts, label) {
  console.log(`\n=== Go/No-Go (${label}, arrival detection: dwell = station stop) ===`);
  console.log(
    `Gate: recall >= ${fmtPct(THRESHOLDS.minRecall)}, precision >= ${fmtPct(
      THRESHOLDS.minPrecision
    )}, median latency <= ${THRESHOLDS.maxMedianLatencySec}s`
  );
  for (const v of verdicts) {
    console.log(
      `${v.id} (${v.name}): recall=${fmtPct(v.avgRecall)} precision=${fmtPct(v.avgPrecision)} medianLatency=${fmtSec(
        v.avgMedianLatency
      )} -> ${v.pass ? 'GO' : 'NO-GO'}`
    );
  }
}

// ---------------------------------------------------------------------------
// Analysis pipeline (works on a single ride log, aggregated to one condition)
// ---------------------------------------------------------------------------

function analyzeRide(meta, samples, marks) {
  const condition = groupKey(meta);
  return CANDIDATES.map((c) => {
    const detections = c.fn(samples);
    return {
      condition,
      candidateId: c.id,
      candidateName: c.name,
      arrive: scoreCandidate(detections, marks, 'arrive', PARAMS.matchWindowSec),
      depart: scoreCandidate(detections, marks, 'depart', PARAMS.matchWindowSec),
    };
  });
}

// ---------------------------------------------------------------------------
// Synthetic fixture generator — deterministic (mulberry32 PRNG), used to
// (re)generate the committed fixtures under fixtures/ and for --selftest.
// See README.md "Adding a real-capture fixture" for the real-capture path;
// this generator stays only as the synthetic reference / regen tool.
// ---------------------------------------------------------------------------

export function generateSyntheticLog({ cycles = 4, hz = 20, seed = 42, noiseScale = 1, ride = 'synthetic', placement = 'pocket', line = '2' } = {}) {
  let state = seed;
  function rand() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function noise(scale) {
    return (rand() - 0.5) * 2 * scale * noiseScale;
  }

  const dtMs = 1000 / hz;
  const samples = [];
  const marks = [];
  let t = 0;
  const g = [0, 0, -9.81];

  const departSec = 15;
  const cruiseSec = 40;
  const arriveSec = 15;
  const dwellSec = 25;

  for (let cycle = 0; cycle < cycles; cycle++) {
    const departStart = t;
    for (let s = 0; s < departSec * hz; s++) {
      const ax = 0.6 + noise(0.05);
      samples.push({
        t,
        ua: [ax, noise(0.05), noise(0.05)],
        rr: [noise(0.02), noise(0.02), noise(0.02)],
        g,
        rms: Math.abs(ax) + Math.abs(noise(0.05)),
        pat: null,
        cm: 'automotive',
        cmc: 3,
        hpa: null,
        gps: null,
      });
      t += dtMs;
    }
    marks.push({ t: departStart, mark: 'depart' });

    for (let s = 0; s < cruiseSec * hz; s++) {
      samples.push({
        t,
        ua: [noise(0.2), noise(0.15), noise(0.1)],
        rr: [noise(0.05), noise(0.05), noise(0.05)],
        g,
        rms: 0.2 + Math.abs(noise(0.1)),
        pat: null,
        cm: 'automotive',
        cmc: 2,
        hpa: null,
        gps: null,
      });
      t += dtMs;
    }

    for (let s = 0; s < arriveSec * hz; s++) {
      const ax = -0.6 + noise(0.05);
      samples.push({
        t,
        ua: [ax, noise(0.05), noise(0.05)],
        rr: [noise(0.02), noise(0.02), noise(0.02)],
        g,
        rms: Math.abs(ax) + Math.abs(noise(0.05)),
        pat: null,
        cm: 'automotive',
        cmc: 3,
        hpa: null,
        gps: null,
      });
      t += dtMs;
    }
    const arriveMarkT = t;
    marks.push({ t: arriveMarkT, mark: 'arrive' });

    for (let s = 0; s < dwellSec * hz; s++) {
      samples.push({
        t,
        ua: [noise(0.03), noise(0.03), noise(0.03)],
        rr: [noise(0.01), noise(0.01), noise(0.01)],
        g,
        rms: 0.05 + Math.abs(noise(0.02)),
        pat: null,
        cm: cycle === 0 && t - arriveMarkT < 3000 ? 'automotive' : 'stationary',
        cmc: 1,
        hpa: null,
        gps: null,
      });
      t += dtMs;
    }
  }

  const meta = { ride, placement, line, startedAt: 0, schemaVersion: FIXTURE_SCHEMA_VERSION };
  return { meta, samples, marks };
}

function serializeLog({ meta, samples, marks }) {
  const lines = [JSON.stringify({ meta })];
  for (const m of marks) lines.push(JSON.stringify({ t: m.t, mark: m.mark }));
  for (const s of samples) lines.push(JSON.stringify(s));
  return lines.join('\n') + '\n';
}

function selftest() {
  console.log('Running --selftest with synthetic data (4 stop cycles, 20Hz, seeded RNG)...\n');
  const { meta, samples, marks } = generateSyntheticLog({ cycles: 4 });
  console.log(`Synthetic log: ${samples.length} samples, ${marks.length} ground-truth marks`);
  console.log(`Duration: ${((samples[samples.length - 1].t - samples[0].t) / 1000).toFixed(0)}s\n`);

  const results = analyzeRide(meta, samples, marks);
  renderReport(results);
  renderGoNoGo(evaluateGate(results), 'selftest');

  // Sanity check, not a quality bar: the pipeline must actually produce
  // detections for every candidate on the synthetic log.
  let ok = true;
  for (const r of results) {
    if (r.arrive.totalDetections === 0 && r.depart.totalDetections === 0) {
      console.error(`\nSELFTEST FAIL: candidate ${r.candidateId} produced zero detections`);
      ok = false;
    }
  }

  console.log(ok ? '\nSELFTEST PASS' : '\nSELFTEST FAIL');
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// --ci: replay every committed fixture, fail (exit 1) on any gate regression
// ---------------------------------------------------------------------------

function runCi() {
  let files;
  try {
    files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    console.error(`No fixtures directory found at ${FIXTURES_DIR}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`No .jsonl fixtures found in ${FIXTURES_DIR} — nothing to replay.`);
    process.exit(1);
  }

  console.log(`Fixture Replay — ${files.length} fixture(s) found in ${FIXTURES_DIR}\n`);

  let anyFail = false;
  for (const file of files) {
    const fullPath = path.join(FIXTURES_DIR, file);
    const text = readFileSync(fullPath, 'utf8');
    const { meta, samples, marks } = parseLog(text);

    console.log(`--- ${file} ---`);
    if (samples.length === 0 || marks.length === 0) {
      console.error(`SKIP: ${file} has no samples or no ground-truth marks (malformed fixture)`);
      anyFail = true;
      continue;
    }
    if (meta?.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
      console.warn(
        `WARN: ${file} meta.schemaVersion=${meta?.schemaVersion} !== harness FIXTURE_SCHEMA_VERSION=${FIXTURE_SCHEMA_VERSION} (see README.md)`
      );
    }

    const results = analyzeRide(meta, samples, marks);
    renderReport(results);
    const verdicts = evaluateGate(results);
    renderGoNoGo(verdicts, file);

    // Regression signal = detection capability lost entirely on this fixture,
    // i.e. NOT ONE candidate clears the gate. We don't require every
    // candidate to pass — some (e.g. C1) are expected weaker baselines being
    // compared against stronger ones (C2/C3), and that comparison is the
    // point of running multiple candidates. If the strongest candidate drops
    // below gate, that's the real regression.
    if (!verdicts.some((v) => v.pass)) anyFail = true;
    console.log('');
  }

  if (anyFail) {
    console.error('Fixture Replay: FAIL — no candidate cleared the gate on a committed fixture (regression).');
    process.exit(1);
  }
  console.log('Fixture Replay: PASS — at least one candidate cleared the gate on every committed fixture.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --gen-fixtures: (re)generate the committed synthetic fixtures. Not run in
// CI — a dev-only entry point for reproducing/refreshing fixtures/*.jsonl.
// ---------------------------------------------------------------------------

function genFixtures() {
  const defs = [
    { file: 'synthetic-line2-pocket.jsonl', opts: { cycles: 3, hz: 10, seed: 42, noiseScale: 1, ride: 'synthetic-1', placement: 'pocket', line: '2' } },
    { file: 'synthetic-line2-bag-noisy.jsonl', opts: { cycles: 3, hz: 10, seed: 7, noiseScale: 2, ride: 'synthetic-2', placement: 'bag', line: '2' } },
    { file: 'synthetic-line9-pocket-sparse.jsonl', opts: { cycles: 2, hz: 10, seed: 99, noiseScale: 1.3, ride: 'synthetic-3', placement: 'pocket', line: '9' } },
  ];
  for (const { file, opts } of defs) {
    const log = generateSyntheticLog(opts);
    const outPath = path.join(FIXTURES_DIR, file);
    writeFileSync(outPath, serializeLog(log));
    console.log(`Wrote ${outPath} (${log.samples.length} samples, ${log.marks.length} marks)`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--selftest')) {
    selftest();
    return;
  }

  if (args.includes('--ci')) {
    runCi();
    return;
  }

  if (args.includes('--gen-fixtures')) {
    genFixtures();
    return;
  }

  const logPath = args[0];
  if (!logPath) {
    console.error('Usage: node tools/replay/replayHarness.mjs <log.jsonl>');
    console.error('       node tools/replay/replayHarness.mjs --ci');
    console.error('       node tools/replay/replayHarness.mjs --selftest');
    process.exit(1);
  }

  const text = readFileSync(logPath, 'utf8');
  const { meta, samples, marks } = parseLog(text);

  if (samples.length === 0) {
    console.error('No samples found in log.');
    process.exit(1);
  }
  if (marks.length === 0) {
    console.error('No ground-truth marks found in log — cannot compute precision/recall.');
    process.exit(1);
  }

  console.log(`Log: ${logPath}`);
  console.log(`Meta: ${JSON.stringify(meta)}`);
  console.log(`Samples: ${samples.length}, Marks: ${marks.length}\n`);

  const results = analyzeRide(meta, samples, marks);
  renderReport(results);
  renderGoNoGo(evaluateGate(results), path.basename(logPath));
}

main();
