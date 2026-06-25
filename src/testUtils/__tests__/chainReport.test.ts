/**
 * #1833 — ChainReport 데이터 모델 + CHAIN_STAGE_IDS 정의 검증.
 */
import {
  CHAIN_STAGE_IDS,
  buildChainReport,
  type ChainStageResult,
} from '../chainReport';

describe('CHAIN_STAGE_IDS', () => {
  it('6개 stage를 가치 흐름 순서로 정의한다', () => {
    expect(CHAIN_STAGE_IDS).toEqual([
      'trip-registered',
      'environment-classified',
      'boardingPrompt-displayed',
      'lock-attach',
      'silent-push-received',
      'station-passed-fired',
    ]);
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

  it('마지막 stage만 실패 → firstStuck=station-passed-fired', () => {
    const last = CHAIN_STAGE_IDS.length - 1;
    const stages: ChainStageResult[] = CHAIN_STAGE_IDS.map((stage, i) => ({
      stage,
      passed: i !== last,
      evidence: 'test',
    }));
    const report = buildChainReport(stages);
    expect(report.firstStuck).toBe('station-passed-fired');
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
