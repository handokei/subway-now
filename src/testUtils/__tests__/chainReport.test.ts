/**
 * #1833 — ChainReport 데이터 모델 + CHAIN_STAGE_IDS 정의 검증.
 */
import {
  CHAIN_STAGE_IDS,
  buildChainReport,
  type ChainStageResult,
} from '../chainReport';

describe('CHAIN_STAGE_IDS', () => {
  it('기존 6 stages를 가치 흐름 순서 앞부분에 포함한다', () => {
    // Phase 6.1 (#1875) 확장 후: 기존 6 + Phase 6.1 6 = 12 stages.
    // 기존 6 stages의 순서가 유지됨을 검증.
    const firstSix = [...CHAIN_STAGE_IDS].slice(0, 6);
    expect(firstSix).toEqual([
      'trip-registered',
      'environment-classified',
      'boardingPrompt-displayed',
      'lock-attach',
      'silent-push-received',
      'station-passed-fired',
    ]);
  });

  it('Phase 6.1 stages를 포함한다 (cold-start → mismatch)', () => {
    expect(CHAIN_STAGE_IDS).toContain('cold-start-detected');
    expect(CHAIN_STAGE_IDS).toContain('candidates-extracted');
    expect(CHAIN_STAGE_IDS).toContain('weighted-narrowed');
    expect(CHAIN_STAGE_IDS).toContain('picker-shown');
    expect(CHAIN_STAGE_IDS).toContain('user-selected');
    expect(CHAIN_STAGE_IDS).toContain('mismatch-detected');
  });

  it('총 12개 (기존 6 + Phase 6.1 6)', () => {
    expect(CHAIN_STAGE_IDS).toHaveLength(12);
  });

  it('중복 없음', () => {
    expect(new Set(CHAIN_STAGE_IDS).size).toBe(CHAIN_STAGE_IDS.length);
  });
});

describe('buildChainReport', () => {
  it('모든 stage pass → allPassed=true, firstStuck=null', () => {
    const stages: ChainStageResult[] = CHAIN_STAGE_IDS.map((stage) => ({
      stage,
      passed: true,
      evidence: 'ok',
    }));
    const report = buildChainReport(stages);
    expect(report.allPassed).toBe(true);
    expect(report.firstStuck).toBeNull();
    expect(report.stages).toHaveLength(CHAIN_STAGE_IDS.length);
  });

  it('첫 번째 stage 실패 → firstStuck=trip-registered, allPassed=false', () => {
    const stages: ChainStageResult[] = CHAIN_STAGE_IDS.map((stage, i) => ({
      stage,
      passed: i !== 0,
      evidence: 'test',
    }));
    const report = buildChainReport(stages);
    expect(report.allPassed).toBe(false);
    expect(report.firstStuck).toBe('trip-registered');
  });

  it('중간 stage 실패 → firstStuck=lock-attach', () => {
    const lockAttachIdx = CHAIN_STAGE_IDS.indexOf('lock-attach');
    const stages: ChainStageResult[] = CHAIN_STAGE_IDS.map((stage, i) => ({
      stage,
      passed: i !== lockAttachIdx,
      evidence: 'test',
    }));
    const report = buildChainReport(stages);
    expect(report.firstStuck).toBe('lock-attach');
    expect(report.allPassed).toBe(false);
  });

  it('마지막 stage만 실패 → firstStuck=mismatch-detected (Phase 6.1 마지막 stage)', () => {
    // Phase 6.1 (#1875) 확장 후 마지막 stage는 mismatch-detected
    const last = CHAIN_STAGE_IDS.length - 1;
    const stages: ChainStageResult[] = CHAIN_STAGE_IDS.map((stage, i) => ({
      stage,
      passed: i !== last,
      evidence: 'test',
    }));
    const report = buildChainReport(stages);
    expect(report.firstStuck).toBe('mismatch-detected');
  });

  it('stages 배열이 CHAIN_STAGE_IDS 순서와 동일하다', () => {
    const stages: ChainStageResult[] = CHAIN_STAGE_IDS.map((stage) => ({
      stage,
      passed: true,
      evidence: '',
    }));
    const report = buildChainReport(stages);
    expect(report.stages.map((s) => s.stage)).toEqual([...CHAIN_STAGE_IDS]);
  });
});
