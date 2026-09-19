/**
 * #1875 — Phase 6.1 fixture chain runner 확장 테스트.
 *
 * 검증 범위:
 * 1. 기존 6 stages 회귀 zero (morning-trip.txt → allPassed, stage 순서 유지)
 * 2. Phase 6.1 full chain (cold-start-full-chain.txt) — 5 stages 모두 판정 가능
 * 3. cold-start-detected only (detected=yes, candidates=0) — stuck at candidates-extracted
 * 4. mismatch-detected pass (alarmLog.cold-start-mismatch >= 1)
 * 5. fallback 파생 (## Cold Start 섹션 없음 → gpsAccuracy + environment 필드로 cold-start-detected 평가)
 * 6. stages 배열 총 12개 (기존 6 + Phase 6.1 6개)
 * 7. undefined 필드 graceful (Phase 6.1 stages → false + evidence 확인)
 * 8. 매트릭스 테스트 — cold start stages × pass / stuck cases
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDumpFixture } from '../dumpParser';
import { runChainFromDump } from '../fixtureChainRunner';
import { CHAIN_STAGE_IDS } from '../chainReport';
import type { DumpFixture } from '../dumpParser';

const DAY2_DIR = join(__dirname, '../fixtures/day2');
const PHASE61_DIR = join(__dirname, '../fixtures/phase61');

function loadAndRun(dir: string, filename: string) {
  const text = readFileSync(join(dir, filename), 'utf-8');
  return runChainFromDump(parseDumpFixture(text));
}

// ─── 1. 기존 6 stages 회귀 zero ───────────────────────────────────────────────

describe('regression: 기존 6 stages 회귀 zero — morning-trip allPassed + 순서 유지', () => {
  const report = loadAndRun(DAY2_DIR, 'morning-trip.txt');

  it('allPassed=true (기존 6 stages 전부 통과)', () => {
    // Phase 6.1 stages는 cold-start 섹션 없음 → false. allPassed는 전체 stages 기준.
    // morning-trip에는 cold start 섹션 없으므로 Phase 6.1 stages는 false → allPassed=false.
    // 회귀 guard: 기존 6 stages가 여전히 pass인지만 확인한다.
    const existingSix = report.stages.slice(0, 6);
    for (const s of existingSix) {
      expect(s.passed).toBe(true);
    }
  });

  it('CHAIN_STAGE_IDS 총 14개 (기존 6 + Phase 6.1 6 + #2068 mode-aware 2)', () => {
    expect(CHAIN_STAGE_IDS).toHaveLength(14);
  });

  it('stages 배열 총 14개', () => {
    expect(report.stages).toHaveLength(14);
  });

  it('stages[0].stage=trip-registered (기존 순서 유지)', () => {
    expect(report.stages[0].stage).toBe('trip-registered');
  });

  it('stages[5].stage=station-passed-fired (기존 순서 유지)', () => {
    expect(report.stages[5].stage).toBe('station-passed-fired');
  });

  it('stages[6].stage=cold-start-detected (Phase 6.1 첫 stage)', () => {
    expect(report.stages[6].stage).toBe('cold-start-detected');
  });

  it('stages[11].stage=mismatch-detected (Phase 6.1 마지막 stage, #2068 mode-aware 앞)', () => {
    expect(report.stages[11].stage).toBe('mismatch-detected');
  });
});

// ─── 2. Phase 6.1 full chain ──────────────────────────────────────────────────

describe('Phase 6.1 full chain: cold-start-full-chain.txt — 모든 cold start stages pass', () => {
  const report = loadAndRun(PHASE61_DIR, 'cold-start-full-chain.txt');

  it('cold-start-detected pass', () => {
    const stage = report.stages.find((s) => s.stage === 'cold-start-detected');
    expect(stage?.passed).toBe(true);
    expect(stage?.evidence).toContain('coldStart.detected=true');
  });

  it('candidates-extracted pass (candidatesCount=3)', () => {
    const stage = report.stages.find((s) => s.stage === 'candidates-extracted');
    expect(stage?.passed).toBe(true);
    expect(stage?.evidence).toContain('candidatesCount=3');
  });

  it('weighted-narrowed pass (weightedCount=3)', () => {
    const stage = report.stages.find((s) => s.stage === 'weighted-narrowed');
    expect(stage?.passed).toBe(true);
    expect(stage?.evidence).toContain('weightedCount=3');
  });

  it('picker-shown pass', () => {
    const stage = report.stages.find((s) => s.stage === 'picker-shown');
    expect(stage?.passed).toBe(true);
    expect(stage?.evidence).toContain('pickerShown=true');
  });

  it('user-selected pass', () => {
    const stage = report.stages.find((s) => s.stage === 'user-selected');
    expect(stage?.passed).toBe(true);
    expect(stage?.evidence).toContain('userSelected=true');
  });

  it('mismatch-detected false (cold-start-mismatch=0 — 정상 trip)', () => {
    const stage = report.stages.find((s) => s.stage === 'mismatch-detected');
    expect(stage?.passed).toBe(false);
    expect(stage?.evidence).toContain('cold-start-mismatch=0');
  });
});

// ─── 3. cold-start-detected only (candidates=0) ────────────────────────────

describe('Phase 6.1: cold-start-detected-only.txt — detected=yes but candidates=0', () => {
  const report = loadAndRun(PHASE61_DIR, 'cold-start-detected-only.txt');

  it('cold-start-detected pass', () => {
    const stage = report.stages.find((s) => s.stage === 'cold-start-detected');
    expect(stage?.passed).toBe(true);
  });

  it('candidates-extracted false (candidatesCount=0)', () => {
    const stage = report.stages.find((s) => s.stage === 'candidates-extracted');
    expect(stage?.passed).toBe(false);
    expect(stage?.evidence).toContain('candidatesCount=0');
  });

  it('weighted-narrowed false (weightedCount=0)', () => {
    const stage = report.stages.find((s) => s.stage === 'weighted-narrowed');
    expect(stage?.passed).toBe(false);
  });

  it('picker-shown false', () => {
    const stage = report.stages.find((s) => s.stage === 'picker-shown');
    expect(stage?.passed).toBe(false);
  });

  it('user-selected false', () => {
    const stage = report.stages.find((s) => s.stage === 'user-selected');
    expect(stage?.passed).toBe(false);
  });
});

// ─── 4. mismatch-detected pass ────────────────────────────────────────────────

describe('Phase 6.1: cold-start-mismatch.txt — mismatch-detected pass', () => {
  const report = loadAndRun(PHASE61_DIR, 'cold-start-mismatch.txt');

  it('mismatch-detected pass (cold-start-mismatch=1)', () => {
    const stage = report.stages.find((s) => s.stage === 'mismatch-detected');
    expect(stage?.passed).toBe(true);
    expect(stage?.evidence).toContain('cold-start-mismatch=1');
  });

  it('cold-start-detected pass (coldStart.detected=yes)', () => {
    const stage = report.stages.find((s) => s.stage === 'cold-start-detected');
    expect(stage?.passed).toBe(true);
  });

  it('user-selected pass (sectionに userSelected=yes)', () => {
    const stage = report.stages.find((s) => s.stage === 'user-selected');
    expect(stage?.passed).toBe(true);
  });
});

// ─── 5. fallback 파생 (## Cold Start 섹션 없음) ─────────────────────────────

describe('Phase 6.1 fallback: cold-start-fallback-derived.txt — 섹션 없이 파생', () => {
  const report = loadAndRun(PHASE61_DIR, 'cold-start-fallback-derived.txt');

  it('cold-start-detected pass (accuracy=600m > 50 + subsurface=true + no trip)', () => {
    const stage = report.stages.find((s) => s.stage === 'cold-start-detected');
    expect(stage?.passed).toBe(true);
    // fallback evidence에는 accuracy와 env가 표시됨
    expect(stage?.evidence).toContain('accuracy=');
    expect(stage?.evidence).toContain('env=');
  });

  it('candidates-extracted false (coldStart section absent)', () => {
    const stage = report.stages.find((s) => s.stage === 'candidates-extracted');
    expect(stage?.passed).toBe(false);
    expect(stage?.evidence).toContain('coldStart section absent');
  });

  it('weighted-narrowed false (coldStart section absent)', () => {
    const stage = report.stages.find((s) => s.stage === 'weighted-narrowed');
    expect(stage?.passed).toBe(false);
    expect(stage?.evidence).toContain('coldStart section absent');
  });

  it('picker-shown false (coldStart section absent)', () => {
    const stage = report.stages.find((s) => s.stage === 'picker-shown');
    expect(stage?.passed).toBe(false);
  });

  it('user-selected false (coldStart section absent)', () => {
    const stage = report.stages.find((s) => s.stage === 'user-selected');
    expect(stage?.passed).toBe(false);
  });
});

// ─── 6. undefined 필드 graceful (branch coverage) ────────────────────────────

describe('Phase 6.1 graceful: 모든 필드 undefined → cold start stages false', () => {
  const baseFixture: DumpFixture = {
    capturedAt: undefined,
    tripStartedAt: undefined,
    lifecyclePhase: undefined,
    fusionConfidence: undefined,
    subsurface: undefined,
    gpsAccuracy: undefined,
    environment: undefined,
    silentPushReceived: undefined,
    silentPushFired: undefined,
    boardingLockActive: undefined,
    sleepMode: undefined,
    alarmLogSources: {},
    notificationsFiredCount: undefined,
    notificationKinds: [],
    coldStart: undefined,
  };

  it('cold-start-detected false (accuracy undefined)', () => {
    const report = runChainFromDump(baseFixture);
    const stage = report.stages.find((s) => s.stage === 'cold-start-detected');
    expect(stage?.passed).toBe(false);
    expect(stage?.evidence).toContain('accuracy=?');
  });

  it('candidates-extracted false + evidence에 "absent" 포함', () => {
    const report = runChainFromDump(baseFixture);
    const stage = report.stages.find((s) => s.stage === 'candidates-extracted');
    expect(stage?.passed).toBe(false);
    expect(stage?.evidence).toContain('absent');
  });

  it('weighted-narrowed false', () => {
    const report = runChainFromDump(baseFixture);
    const stage = report.stages.find((s) => s.stage === 'weighted-narrowed');
    expect(stage?.passed).toBe(false);
  });

  it('picker-shown false', () => {
    const report = runChainFromDump(baseFixture);
    const stage = report.stages.find((s) => s.stage === 'picker-shown');
    expect(stage?.passed).toBe(false);
  });

  it('user-selected false', () => {
    const report = runChainFromDump(baseFixture);
    const stage = report.stages.find((s) => s.stage === 'user-selected');
    expect(stage?.passed).toBe(false);
  });

  it('mismatch-detected false (no cold-start-mismatch log)', () => {
    const report = runChainFromDump(baseFixture);
    const stage = report.stages.find((s) => s.stage === 'mismatch-detected');
    expect(stage?.passed).toBe(false);
    expect(stage?.evidence).toContain('cold-start-mismatch=0');
  });
});

// ─── 7. 매트릭스 테스트 — cold start stages × pass / stuck cases ──────────────

describe('매트릭스: cold start section 존재 시 각 필드 독립 판정', () => {
  const makeColdStartFixture = (
    overrides: Partial<DumpFixture['coldStart']>,
  ): DumpFixture => ({
    capturedAt: undefined,
    tripStartedAt: undefined,
    lifecyclePhase: 'none',
    fusionConfidence: undefined,
    subsurface: undefined,
    gpsAccuracy: undefined,
    environment: undefined,
    silentPushReceived: undefined,
    silentPushFired: undefined,
    boardingLockActive: undefined,
    sleepMode: undefined,
    alarmLogSources: {},
    notificationsFiredCount: undefined,
    notificationKinds: [],
    coldStart: {
      detected: false,
      candidatesCount: 0,
      weightedCount: 0,
      pickerShown: false,
      userSelected: false,
      ...overrides,
    },
  });

  it.each([
    ['detected=false → cold-start-detected false', { detected: false }, 'cold-start-detected', false],
    ['detected=true → cold-start-detected pass', { detected: true }, 'cold-start-detected', true],
    ['candidatesCount=0 → candidates-extracted false', { candidatesCount: 0 }, 'candidates-extracted', false],
    ['candidatesCount=5 → candidates-extracted pass', { candidatesCount: 5 }, 'candidates-extracted', true],
    ['weightedCount=0 → weighted-narrowed false', { weightedCount: 0 }, 'weighted-narrowed', false],
    ['weightedCount=2 → weighted-narrowed pass', { weightedCount: 2 }, 'weighted-narrowed', true],
    ['pickerShown=false → picker-shown false', { pickerShown: false }, 'picker-shown', false],
    ['pickerShown=true → picker-shown pass', { pickerShown: true }, 'picker-shown', true],
    ['userSelected=false → user-selected false', { userSelected: false }, 'user-selected', false],
    ['userSelected=true → user-selected pass', { userSelected: true }, 'user-selected', true],
  ] as const)('%s', (_label, coldStartOverride, stageId, expectedPassed) => {
    const fixture = makeColdStartFixture(coldStartOverride);
    const report = runChainFromDump(fixture);
    const stage = report.stages.find((s) => s.stage === stageId);
    expect(stage?.passed).toBe(expectedPassed);
  });

  it.each([
    ['cold-start-mismatch=0 → mismatch-detected false', {}, false, 0],
    ['cold-start-mismatch=1 → mismatch-detected pass', {}, true, 1],
    ['cold-start-mismatch=3 → mismatch-detected pass', {}, true, 3],
  ] as const)('%s', (_label, coldStartOverride, expectedPassed, mismatchCount) => {
    const fixture: DumpFixture = {
      ...makeColdStartFixture(coldStartOverride),
      alarmLogSources: mismatchCount > 0 ? { 'cold-start-mismatch': mismatchCount } : {},
    };
    const report = runChainFromDump(fixture);
    const stage = report.stages.find((s) => s.stage === 'mismatch-detected');
    expect(stage?.passed).toBe(expectedPassed);
  });
});

// ─── 8. cold-start-detected fallback 파생 매트릭스 ─────────────────────────────

describe('매트릭스: cold-start-detected fallback 파생 (## Cold Start 섹션 없음)', () => {
  const makeNoSectionFixture = (
    gpsAccuracy: number | undefined,
    environment: DumpFixture['environment'],
    lifecyclePhase: string | undefined,
  ): DumpFixture => ({
    capturedAt: undefined,
    tripStartedAt: undefined,
    lifecyclePhase,
    fusionConfidence: undefined,
    subsurface: undefined,
    gpsAccuracy,
    environment,
    silentPushReceived: undefined,
    silentPushFired: undefined,
    boardingLockActive: undefined,
    sleepMode: undefined,
    alarmLogSources: {},
    notificationsFiredCount: undefined,
    notificationKinds: [],
    coldStart: undefined,
  });

  it.each([
    // [description, accuracy, environment, lifecyclePhase, expectedPassed]
    ['accuracy>50 + underground + no trip → pass', 350, 'underground', 'none', true],
    ['accuracy>50 + unknown + no trip → pass', 100, 'unknown', 'none', true],
    ['accuracy=50 (boundary) + underground + no trip → false', 50, 'underground', 'none', false],
    ['accuracy=25 (< 50) + underground + no trip → false', 25, 'underground', 'none', false],
    ['accuracy>50 + surface + no trip → false', 200, 'surface', 'none', false],
    ['accuracy>50 + underground + trip active → false', 300, 'underground', 'active', false],
    ['accuracy undefined + underground + no trip → false', undefined, 'underground', 'none', false],
    ['accuracy>50 + environment undefined → false', 200, undefined, 'none', false],
  ] as const)('%s', (_desc, accuracy, environment, lifecyclePhase, expectedPassed) => {
    const fixture = makeNoSectionFixture(accuracy, environment, lifecyclePhase);
    const report = runChainFromDump(fixture);
    const stage = report.stages.find((s) => s.stage === 'cold-start-detected');
    expect(stage?.passed).toBe(expectedPassed);
  });
});
