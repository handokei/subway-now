/**
 * #1833 — fixture chain simulation 인프라: runChainFromDump.
 *
 * DumpFixture를 입력받아 CHAIN_STAGE_IDS 순서대로 각 stage를 평가하고 ChainReport를 반환.
 *
 * 설계 원칙:
 * - STAGE_CHECKERS: ChainStageId → check 함수 맵. 새 stage는 여기만 추가.
 * - check 함수는 DumpFixture를 받아 { passed, evidence } 반환.
 * - 단방향 평가 — 이전 stage 실패 여부와 무관하게 모든 stage를 독립 평가.
 *   (firstStuck는 첫 실패 stage이나, 각 stage 결과는 독립적으로 관찰 가능)
 */

import type { DumpFixture } from './dumpParser';
import {
  CHAIN_STAGE_IDS,
  type ChainStageId,
  type ChainStageResult,
  buildChainReport,
  type ChainReport,
} from './chainReport';

interface StageCheckResult {
  passed: boolean;
  evidence: string;
}

type StageChecker = (fixture: DumpFixture) => StageCheckResult;

/**
 * 각 chain stage의 통과 조건 정의.
 *
 * 조건은 Day 2 dump evidence + paradigm shift 정합 기준:
 *   - trip-registered: lifecyclePhase != 'none' 또는 tripStartedAt != '—'
 *   - environment-classified: subsurface=true OR fusionConfidence에 'underground' 포함
 *     OR alarmLogSources에 'boarding-prompt' 존재 (환경 분류 없이도 lock 획득하면 chain continue)
 *   - boardingPrompt-displayed: alarmLogSources['boarding-prompt'] >= 1
 *   - lock-attach: boardingLockActive=true
 *   - silent-push-received: silentPushReceived > 0
 *   - station-passed-fired: notificationKinds에 'station-passed' 포함 (autolock-success는 별도)
 */
const STAGE_CHECKERS: Record<ChainStageId, StageChecker> = {
  'trip-registered': (f) => {
    const phase = f.lifecyclePhase;
    const started = f.tripStartedAt;
    const passed = (phase !== undefined && phase !== 'none') || (started !== undefined && started !== '—');
    const evidence = `lifecyclePhase=${phase ?? '?'} tripStartedAt=${started ?? '?'}`;
    return { passed, evidence };
  },

  'environment-classified': (f) => {
    // underground 신호 있거나, lock 획득(boarding-prompt fired = environment 통과 증거)하면 pass
    const underground =
      f.subsurface === true ||
      (f.fusionConfidence?.includes('underground') ?? false) ||
      (f.alarmLogSources['boarding-prompt'] ?? 0) >= 1;
    const evidence = `subsurface=${f.subsurface ?? '?'} confidence=${f.fusionConfidence ?? '?'} boarding-prompt-log=${f.alarmLogSources['boarding-prompt'] ?? 0}`;
    return { passed: underground, evidence };
  },

  'boardingPrompt-displayed': (f) => {
    const count = f.alarmLogSources['boarding-prompt'] ?? 0;
    return {
      passed: count >= 1,
      evidence: `boarding-prompt=${count}`,
    };
  },

  'lock-attach': (f) => {
    const active = f.boardingLockActive;
    return {
      passed: active === true,
      evidence: `boardingLock.active=${active ?? '?'}`,
    };
  },

  'silent-push-received': (f) => {
    const received = f.silentPushReceived ?? 0;
    return {
      passed: received > 0,
      evidence: `received=${received}`,
    };
  },

  'station-passed-fired': (f) => {
    const fired = f.notificationKinds.includes('station-passed');
    const count = f.notificationsFiredCount ?? 0;
    return {
      passed: fired,
      evidence: `notificationsFiredCount=${count} kinds=[${f.notificationKinds.join(',')}]`,
    };
  },
};

/**
 * DumpFixture를 chain stage별로 평가해 ChainReport를 반환.
 *
 * @param fixture - parseDumpFixture(dumpText) 결과
 * @returns ChainReport — stages, firstStuck, allPassed
 *
 * 예시:
 * ```ts
 * const fixture = parseDumpFixture(morningTripTxt);
 * const report = runChainFromDump(fixture);
 * expect(report.allPassed).toBe(true);
 * ```
 */
export function runChainFromDump(fixture: DumpFixture): ChainReport {
  const stages: ChainStageResult[] = CHAIN_STAGE_IDS.map((stageId) => {
    const checker = STAGE_CHECKERS[stageId];
    const { passed, evidence } = checker(fixture);
    return { stage: stageId, passed, evidence };
  });
  return buildChainReport(stages);
}
