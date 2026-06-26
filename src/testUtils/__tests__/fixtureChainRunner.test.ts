/**
 * #1833 — fixtureChainRunner acceptance 테스트 5건.
 *
 * Day 2 evidence:
 *   - 오전 trip: received=6, boardingLock active=yes, station-passed fired=1 → chain complete
 *   - 오후 dump: received=0, trip=none → chain stuck at trip-registered
 *
 * Regression guard scenarios (paradigm shift fix 효과 시뮬):
 *   1. lockless + 의향 없음 → chain stuck at lock-attach (#1819 guard)
 *   2. boardingPrompt=0 → chain stuck at boardingPrompt-displayed (#1822 효과)
 *   3. environment=unknown (gps-only, subsurface=false) → chain stuck at environment-classified (#1823 효과)
 *   4. silent push received=0 (오후 dump) → chain stuck at silent-push-received (#1832 audit)
 *   5. 오전 trip (fix 적용 결과) → chain.allPassed=true
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDumpFixture } from '../dumpParser';
import { runChainFromDump } from '../fixtureChainRunner';

const FIXTURES_DIR = join(__dirname, '../fixtures/day2');

function loadAndRun(filename: string) {
  const text = readFileSync(join(FIXTURES_DIR, filename), 'utf-8');
  return runChainFromDump(parseDumpFixture(text));
}

describe('acceptance 1: lockless trip + 의향 없음 → boardingPrompt/lock 둘 다 없어 chain stuck', () => {
  // #1819 guard: lock=null → lockless-no-user-intent → station-passed 0건
  // 지상(subsurface=false) + boarding-prompt=0 → environment-classified OR boardingPrompt-displayed에서 막힘
  const report = loadAndRun('regression-lockless-no-intent.txt');

  it('chain이 멈춘다 (allPassed=false)', () => {
    expect(report.allPassed).toBe(false);
  });

  it('boardingPrompt-displayed와 lock-attach 둘 다 실패한다', () => {
    const stuckStages = report.stages.filter((s) => !s.passed).map((s) => s.stage);
    expect(stuckStages).toContain('boardingPrompt-displayed');
    expect(stuckStages).toContain('lock-attach');
  });

  it('station-passed-fired=false (#1819 guard 작동 검증)', () => {
    const stationPassed = report.stages.find((s) => s.stage === 'station-passed-fired');
    expect(stationPassed?.passed).toBe(false);
  });

  it('trip-registered는 pass이다 (trip이 등록됨)', () => {
    const tripStage = report.stages.find((s) => s.stage === 'trip-registered');
    expect(tripStage?.passed).toBe(true);
  });
});

describe('acceptance 2: boardingPrompt=0 → chain stuck at boardingPrompt-displayed', () => {
  // #1822 효과: boardingPrompt blocked → lock 없음 → chain 전파 불가
  const report = loadAndRun('regression-boarding-prompt-blocked.txt');

  it('firstStuck이 boardingPrompt-displayed이거나 lock-attach이다', () => {
    // boarding-prompt=0이면 boardingPrompt-displayed에서 막힘
    // environment도 미분류 시 environment-classified에서 먼저 막힐 수 있음
    expect(report.allPassed).toBe(false);
    const stuck = report.firstStuck;
    expect([
      'environment-classified',
      'boardingPrompt-displayed',
      'lock-attach',
    ]).toContain(stuck);
  });

  it('boardingPrompt-displayed stage는 실패한다', () => {
    const bpStage = report.stages.find((s) => s.stage === 'boardingPrompt-displayed');
    expect(bpStage?.passed).toBe(false);
    expect(bpStage?.evidence).toContain('boarding-prompt=0');
  });

  it('station-passed-fired는 false', () => {
    const sp = report.stages.find((s) => s.stage === 'station-passed-fired');
    expect(sp?.passed).toBe(false);
  });
});

describe('acceptance 3: environment=unknown (subsurface=false, gps-only) → chain stuck at environment-classified', () => {
  // #1823 효과: environment unknown → underground consensus 미형성 → lock 없음
  const report = loadAndRun('regression-environment-unknown.txt');

  it('environment-classified stage가 실패한다', () => {
    const envStage = report.stages.find((s) => s.stage === 'environment-classified');
    expect(envStage?.passed).toBe(false);
  });

  it('firstStuck이 environment-classified 이하이다', () => {
    expect(report.allPassed).toBe(false);
    const stuckIdx = report.stages.findIndex((s) => s.stage === report.firstStuck);
    const envIdx = report.stages.findIndex((s) => s.stage === 'environment-classified');
    // environment-classified 이후부터 막힘
    expect(stuckIdx).toBeGreaterThanOrEqual(envIdx);
  });

  it('evidence에 confidence=gps-only가 포함된다', () => {
    const envStage = report.stages.find((s) => s.stage === 'environment-classified');
    expect(envStage?.evidence).toContain('gps-only');
  });
});

describe('acceptance 4: silent push received=0 (오후 dump) → chain stuck at silent-push-received', () => {
  // #1832 audit 연계: received=0 → station-passed 0건
  const report = loadAndRun('afternoon-debug.txt');

  it('trip-registered가 실패한다 (trip=none)', () => {
    const tripStage = report.stages.find((s) => s.stage === 'trip-registered');
    expect(tripStage?.passed).toBe(false);
  });

  it('firstStuck=trip-registered (trip도 없음)', () => {
    expect(report.firstStuck).toBe('trip-registered');
  });

  it('silent-push-received stage evidence에 received=0이 포함된다', () => {
    const spStage = report.stages.find((s) => s.stage === 'silent-push-received');
    expect(spStage?.evidence).toContain('received=0');
    expect(spStage?.passed).toBe(false);
  });
});

describe('acceptance 5: Day 2 오전 trip (fix 적용 결과) → 기존 6 stages 모두 pass', () => {
  // boarding-prompt=1, lock=yes, received=6, station-passed fired
  // Phase 6.1 stages는 cold-start 섹션 없음 → false. 기존 6 stages만 pass 확인.
  const report = loadAndRun('morning-trip.txt');

  it('기존 6 stages 모두 pass이다', () => {
    const existingSix = report.stages.slice(0, 6);
    for (const s of existingSix) {
      expect(s.passed).toBe(true);
    }
  });

  it('firstStuck이 Phase 6.1 stage이다 (cold-start 섹션 없어 cold-start-detected가 막힘)', () => {
    // Phase 6.1 stages는 섹션 없음 → false. firstStuck은 cold-start-detected.
    expect(report.firstStuck).toBe('cold-start-detected');
  });

  it('모든 stage evidence가 채워져 있다', () => {
    for (const stage of report.stages) {
      expect(stage.evidence).toBeTruthy();
    }
  });

  it('station-passed-fired stage가 pass이다', () => {
    const sp = report.stages.find((s) => s.stage === 'station-passed-fired');
    expect(sp?.passed).toBe(true);
  });

  it('lock-attach stage가 pass이다', () => {
    const lock = report.stages.find((s) => s.stage === 'lock-attach');
    expect(lock?.passed).toBe(true);
  });

  it('silent-push-received stage가 pass이다 (received=6)', () => {
    const sp = report.stages.find((s) => s.stage === 'silent-push-received');
    expect(sp?.passed).toBe(true);
    expect(sp?.evidence).toContain('received=6');
  });
});

describe('runChainFromDump — stages 배열 길이 및 순서', () => {
  const report = loadAndRun('morning-trip.txt');

  it('stages 배열이 CHAIN_STAGE_IDS 개수와 동일 (기존 6 + Phase 6.1 6 = 12)', () => {
    expect(report.stages).toHaveLength(12);
  });

  it('stages[0].stage=trip-registered', () => {
    expect(report.stages[0].stage).toBe('trip-registered');
  });

  it('stages[5].stage=station-passed-fired (기존 6번째 = 인덱스 5)', () => {
    expect(report.stages[5].stage).toBe('station-passed-fired');
  });

  it('stages[6].stage=cold-start-detected (Phase 6.1 첫 stage)', () => {
    expect(report.stages[6].stage).toBe('cold-start-detected');
  });

  it('stages[11].stage=mismatch-detected (Phase 6.1 마지막 stage)', () => {
    expect(report.stages[11].stage).toBe('mismatch-detected');
  });
});

describe('runChainFromDump — undefined 필드 graceful (branch coverage)', () => {
  it('모든 필드 undefined fixture → trip-registered에서 stuck, evidence에 ? 포함', () => {
    const report = runChainFromDump({
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
      alarmLogSources: {},
      notificationsFiredCount: undefined,
      notificationKinds: [],
      coldStart: undefined,
    });
    expect(report.allPassed).toBe(false);
    const tripStage = report.stages.find((s) => s.stage === 'trip-registered');
    expect(tripStage?.passed).toBe(false);
    expect(tripStage?.evidence).toContain('?');
  });

  it('subsurface=true → environment-classified pass (underground 신호)', () => {
    const report = runChainFromDump({
      capturedAt: undefined,
      tripStartedAt: '10:00:00',
      lifecyclePhase: 'active',
      fusionConfidence: 'gps-only-underground',
      subsurface: true,
      gpsAccuracy: undefined,
      environment: undefined,
      silentPushReceived: 0,
      silentPushFired: 0,
      boardingLockActive: false,
      alarmLogSources: {},
      notificationsFiredCount: 0,
      notificationKinds: [],
      coldStart: undefined,
    });
    const envStage = report.stages.find((s) => s.stage === 'environment-classified');
    expect(envStage?.passed).toBe(true);
  });

  it('fusionConfidence에 underground 포함 → environment-classified pass', () => {
    const report = runChainFromDump({
      capturedAt: undefined,
      tripStartedAt: '10:00:00',
      lifecyclePhase: 'active',
      fusionConfidence: 'gps-only-underground',
      subsurface: false,
      gpsAccuracy: undefined,
      environment: undefined,
      silentPushReceived: 0,
      silentPushFired: 0,
      boardingLockActive: false,
      alarmLogSources: {},
      notificationsFiredCount: 0,
      notificationKinds: [],
      coldStart: undefined,
    });
    const envStage = report.stages.find((s) => s.stage === 'environment-classified');
    expect(envStage?.passed).toBe(true);
  });

  it('boardingLockActive=undefined → lock-attach evidence에 ? 포함', () => {
    const report = runChainFromDump({
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
      alarmLogSources: {},
      notificationsFiredCount: undefined,
      notificationKinds: [],
      coldStart: undefined,
    });
    const lockStage = report.stages.find((s) => s.stage === 'lock-attach');
    expect(lockStage?.evidence).toContain('?');
    expect(lockStage?.passed).toBe(false);
  });

  it('notificationsFiredCount=undefined → evidence에 count=0 표시', () => {
    const report = runChainFromDump({
      capturedAt: undefined,
      tripStartedAt: '10:00:00',
      lifecyclePhase: 'active',
      fusionConfidence: 'gps-only',
      subsurface: false,
      gpsAccuracy: undefined,
      environment: undefined,
      silentPushReceived: 5,
      silentPushFired: 1,
      boardingLockActive: true,
      alarmLogSources: { 'boarding-prompt': 1 },
      notificationsFiredCount: undefined,
      notificationKinds: [],
      coldStart: undefined,
    });
    const spStage = report.stages.find((s) => s.stage === 'station-passed-fired');
    expect(spStage?.evidence).toContain('notificationsFiredCount=0');
  });
});
