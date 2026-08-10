#!/usr/bin/env node
/**
 * SPIKE — throwaway analysis script, NOT for merge to dev.
 *
 * Offline analyzer for accelerometer-based subway stop/departure detection.
 * Reads a JSONL log (meta + samples + ground-truth marks) exported by the
 * device-side accelerometer logger and evaluates 3 candidate detectors
 * (C1 principal-axis integration, C2 RMS-floor bracketing, C3 CMMotionActivity
 * baseline) against ground truth, reporting precision/recall/latency.
 *
 * Usage:
 *   node tools/spike/analyzeAccelFingerprint.mjs <log.jsonl>
 *   node tools/spike/analyzeAccelFingerprint.mjs --selftest
 *
 * Pure Node, no dependencies.
 */

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Tunable parameters (exposed for iteration)
// ---------------------------------------------------------------------------
const PARAMS = {
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
  // Go/no-go gate
  gate: {
    minRecall: 0.9,
    minPrecision: 0.85,
    maxMedianLatencySec: 8,
  },
};

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

/**
 * @typedef {{ t:number, ua:[number,number,number], rr:[number,number,number],
 *   g:[number,number,number], rms:number|null, pat:string|null, cm:string|null,
 *   cmc:number|null, hpa:number|null, gps:[number,number,number]|null }} Sample
 * @typedef {{ t:number, mark:'arrive'|'depart' }} MarkEvent
 * @typedef {{ ride:string, placement:string, line:string, startedAt:number }} Meta
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
  let sum = 0;
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    if (i === 0) {
      sum = 0;
      for (let j = lo; j <= hi; j++) sum += values[j];
    } else {
      // recompute window sum directly (simple, values arrays are modest size for a spike)
      sum = 0;
      for (let j = lo; j <= hi; j++) sum += values[j];
    }
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
 * then extract the dominant horizontal axis via 2D PCA on the horizontal
 * accel samples, project onto that axis, and look for sustained
 * deceleration (arrival) / acceleration (departure) runs.
 */
function detectC1(samples) {
  if (samples.length < 3) return [];

  // Remove gravity-aligned component from ua to get horizontal-plane accel.
  const horiz = samples.map((s) => {
    const g = s.g;
    const gMag = magnitude(g) || 1;
    const gUnit = [g[0] / gMag, g[1] / gMag, g[2] / gMag];
    const ua = s.ua;
    const dot = ua[0] * gUnit[0] + ua[1] * gUnit[1] + ua[2] * gUnit[2];
    return [ua[0] - dot * gUnit[0], ua[1] - dot * gUnit[1], ua[2] - dot * gUnit[2]];
  });

  // 2D PCA on horizontal plane: build covariance from the two largest-variance
  // orthogonal components. We approximate by using the plane's natural x/y/z
  // residual — for a spike, project onto x/y/z and take covariance of the
  // 3 components restricted to the horizontal subspace (rank <=2).
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

  // Covariance matrix (3x3, symmetric)
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

  // Project horizontal accel onto principal axis -> 1D "along-track" accel.
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
        // avoid duplicate emission while the run continues
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
  let dwellStart = null; // t when rms first dropped below floor
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

const CANDIDATES = [
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

  // Sort detections by time to process deterministically.
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

// ---------------------------------------------------------------------------
// Conditioning (placement / line / underground) grouping
// ---------------------------------------------------------------------------

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
  // results: [{ condition, candidateId, candidateName, arrive, depart }]
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

function renderGoNoGo(results) {
  const { minRecall, minPrecision, maxMedianLatencySec } = PARAMS.gate;
  console.log('\n=== Go/No-Go (arrival detection: dwell = station stop) ===');
  console.log(
    `Gate: recall >= ${fmtPct(minRecall)}, precision >= ${fmtPct(minPrecision)}, median latency <= ${maxMedianLatencySec}s`
  );

  // Aggregate per-candidate across all conditions for the 'arrive' event.
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

  for (const [id, agg] of byCandidate) {
    const avgRecall = agg.recalls.length ? agg.recalls.reduce((a, b) => a + b, 0) / agg.recalls.length : NaN;
    const avgPrecision = agg.precisions.length
      ? agg.precisions.reduce((a, b) => a + b, 0) / agg.precisions.length
      : NaN;
    const avgMedianLatency = agg.latencies.length ? median(agg.latencies) : NaN;

    const pass =
      avgRecall >= minRecall && avgPrecision >= minPrecision && avgMedianLatency <= maxMedianLatencySec;

    console.log(
      `${id} (${agg.name}): recall=${fmtPct(avgRecall)} precision=${fmtPct(avgPrecision)} medianLatency=${fmtSec(
        avgMedianLatency
      )} -> ${pass ? 'GO' : 'NO-GO'}`
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
// Synthetic test data generator (for --selftest)
// ---------------------------------------------------------------------------

function generateSyntheticLog({ cycles = 4, hz = 20, seed = 42 } = {}) {
  // simple deterministic PRNG (mulberry32) so selftest is reproducible
  let state = seed;
  function rand() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function noise(scale) {
    return (rand() - 0.5) * 2 * scale;
  }

  const dtMs = 1000 / hz;
  const samples = [];
  const marks = [];
  let t = 0;
  const g = [0, 0, -9.81];

  // Cycle shape: accelerate (depart) -> cruise -> decelerate (arrive) -> dwell -> repeat
  const departSec = 15;
  const cruiseSec = 40;
  const arriveSec = 15;
  const dwellSec = 25;

  for (let cycle = 0; cycle < cycles; cycle++) {
    // depart: accel along principal axis rises, cm automotive
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

    // cruise: low-magnitude noise, moving
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

    // arrive: sustained deceleration
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
    const arriveMarkT = t; // mark arrival at the point dwell begins
    marks.push({ t: arriveMarkT, mark: 'arrive' });

    // dwell: near-zero accel, stationary
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

  const meta = { ride: 'synthetic', placement: 'pocket', line: '2', startedAt: 0 };
  return { meta, samples, marks };
}

function selftest() {
  console.log('Running --selftest with synthetic data (4 stop cycles, 20Hz, seeded RNG)...\n');
  const { meta, samples, marks } = generateSyntheticLog({ cycles: 4 });
  console.log(`Synthetic log: ${samples.length} samples, ${marks.length} ground-truth marks`);
  console.log(`Duration: ${((samples[samples.length - 1].t - samples[0].t) / 1000).toFixed(0)}s\n`);

  const results = analyzeRide(meta, samples, marks);
  renderReport(results);
  renderGoNoGo(results);

  // Minimal self-check assertions: script must actually produce detections
  // and match at least some ground truth for each candidate (sanity, not a
  // quality bar — this is a spike, not a unit test).
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
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    selftest();
    return;
  }

  const logPath = args[0];
  if (!logPath) {
    console.error('Usage: node tools/spike/analyzeAccelFingerprint.mjs <log.jsonl>');
    console.error('       node tools/spike/analyzeAccelFingerprint.mjs --selftest');
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
  renderGoNoGo(results);
}

main();
