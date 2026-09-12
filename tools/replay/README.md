# Fixture Replay Harness

Reusable regression harness for accelerometer-based subway stop/departure
detection (`replayHarness.mjs`). Promoted from the throwaway spike
(`spike/accel-fingerprint-analysis`, PR #2271,
`tools/spike/analyzeAccelFingerprint.mjs`) — see #2268.

**What this is not**: this is not a GO/NO-GO call on the detection
algorithm itself. That call already happened once in the spike, against
real ride captures the spike author collected manually. This harness's job
is different — replay a fixed set of committed JSONL fixtures through the
detectors on every PR and fail CI if code changes regress detection quality
below a gate. It's infrastructure, not a verdict.

**No real device captures exist yet.** All committed fixtures under
`fixtures/` are synthetic (deterministic generator baked into
`replayHarness.mjs`). Real captures drop in later as additional
`fixtures/*.jsonl` files — no code change required. See "Adding a real
capture" below.

## Usage

```bash
# Analyze one log (ad-hoc, no CI exit code)
node tools/replay/replayHarness.mjs path/to/capture.jsonl

# Replay every committed fixture, exit 1 on regression (CI entry point)
node tools/replay/replayHarness.mjs --ci

# In-memory synthetic smoke test (no fixture files touched)
node tools/replay/replayHarness.mjs --selftest

# (Re)generate the committed synthetic fixtures under fixtures/
node tools/replay/replayHarness.mjs --gen-fixtures
```

Pure Node (`.mjs`), no dependencies.

## What `--ci` checks

For each fixture, all 3 candidate detectors (C1 principal-axis integration,
C2 RMS-floor bracketing, C3 CMMotionActivity baseline) run against the
fixture's ground-truth marks. The gate (`THRESHOLDS` in
`replayHarness.mjs`) is: recall >= 90%, precision >= 85%, median latency <=
8s, evaluated on the `arrive` event.

**Pass condition**: at least one candidate clears the gate on every
fixture. We don't require every candidate to pass — C1 is a known weaker
baseline kept around for comparison against C2/C3, and that comparison is
the point of running multiple candidates side by side. If the strongest
candidate on a fixture drops below gate, that's the real regression signal
and `--ci` exits 1.

This CI job is **informational (non-required)** — it does not block PR
merges and branch protection is untouched. See
`.github/workflows/ci.yml` job `fixture-replay`.

## Fixture schema

Each fixture is a JSONL file: one JSON object per line, in any order (the
harness sorts by `t` after parsing). Three line shapes:

```jsonc
// 1. Meta (exactly one line, anywhere in the file)
{ "meta": { "ride": "string", "placement": "pocket|bag|...", "line": "2", "startedAt": 0, "schemaVersion": 1 } }

// 2. Ground-truth mark (one per real arrive/depart event)
{ "t": 15000, "mark": "arrive" }   // or "depart"

// 3. Sample (accelerometer + context, one per tick)
{
  "t": 15100,                       // ms, monotonic within a ride
  "ua": [0.1, -0.05, 0.02],         // user acceleration (gravity removed), m/s^2
  "rr": [0.01, 0.0, -0.01],         // rotation rate, rad/s
  "g": [0, 0, -9.81],               // gravity vector, m/s^2
  "rms": 0.15,                      // precomputed RMS magnitude (nullable — falls back to |ua|)
  "pat": null,                      // reserved (device pattern classifier, unused by any candidate yet)
  "cm": "automotive",               // CMMotionActivity confidence class: "automotive" | "stationary" | ... | null
  "cmc": 3,                         // CMMotionActivity confidence (0-3), nullable
  "hpa": null,                      // reserved (barometric pressure), unused by any candidate yet
  "gps": null                       // reserved ([lat, lng, accuracy]), unused by any candidate yet
}
```

`meta.schemaVersion` must match `FIXTURE_SCHEMA_VERSION` at the top of
`replayHarness.mjs`. `--ci` warns (does not fail) on a mismatch — bump both
together when the sample/mark/meta shape changes, and note the change in
this section.

## Adding a real-capture fixture

1. Export the device-side accelerometer logger's JSONL output for one ride.
2. Make sure it has: exactly one `meta` line, ground-truth `mark` lines
   placed by hand (or from a companion log) at the true arrive/depart
   instants, and `t` in the same clock as the samples.
3. Set `meta.schemaVersion` to the current `FIXTURE_SCHEMA_VERSION`.
4. Drop the file in `fixtures/` with a descriptive name:
   `<line>-<placement>-<short-desc>.jsonl` (matches the synthetic naming
   convention already in this directory).
5. Run `node tools/replay/replayHarness.mjs --ci` locally — confirm it
   parses and at least one candidate produces a report line for the new
   fixture (it doesn't need to pass the gate yet; a real capture failing
   the gate is exactly the signal that drives threshold tuning, see below).
6. Commit. No code changes needed — `--ci` picks up every `fixtures/*.jsonl`
   file automatically.

Real fixtures don't replace the synthetic ones — they're additive. Keep the
synthetic fixtures as a fast, ground-truth-guaranteed regression floor even
after real captures land.

## Tuning thresholds

Two places, both at the top of `replayHarness.mjs`:

- `PARAMS` — per-candidate detection parameters (e.g. `c1.decelThreshold`,
  `c2.dwellFloor`, `matchWindowSec`). These are placeholders carried over
  from the spike, tuned against synthetic data only.
- `THRESHOLDS` — the go/no-go gate applied in `--ci` (`minRecall`,
  `minPrecision`, `maxMedianLatencySec`).

**Re-tune both after the first batch of real captures lands.** Synthetic
fixtures are clean-signal by construction (deterministic PRNG noise on top
of an idealized accel/decel/dwell cycle) — they validate that the pipeline
and CI wiring work, not that the thresholds are correct for a real phone in
a real pocket on a real train.

## Regenerating synthetic fixtures

`node tools/replay/replayHarness.mjs --gen-fixtures` rewrites all 3
committed synthetic fixtures from `generateSyntheticLog()` (deterministic
mulberry32 PRNG — same seed always produces the same file byte-for-byte).
Edit the `defs` array in the `genFixtures()` function to add/remove/reseed
synthetic conditions.
