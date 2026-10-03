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
 *
 * Phase 6.1 (#1875) — cold start 경로 5 stages:
 *   판정 전략:
 *   - ## Cold Start 섹션이 dump에 있으면 → 섹션 필드 사용 (명시적, 가장 정확)
 *   - 섹션 부재 시 → 기존 dump 필드에서 파생 (graceful fallback, 신호 일부만 가능)
 *
 *   GPS 정확도 임계값 50m는 useColdStartCandidates.ts의
 *   COLD_START_ACCURACY_THRESHOLD_M 과 동일 기준.
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

/** GPS 정확도 임계값 (useColdStartCandidates.COLD_START_ACCURACY_THRESHOLD_M 동일 기준). */
const COLD_START_ACCURACY_THRESHOLD_M = 50;

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
 *
 * Phase 6.1 cold start stages:
 *   - cold-start-detected: ## Cold Start detected=yes OR (accuracy>50m + env=underground|unknown + no trip)
 *   - candidates-extracted: coldStart.candidatesCount > 0 (섹션 필요)
 *   - weighted-narrowed: coldStart.weightedCount > 0 (섹션 필요)
 *   - picker-shown: coldStart.pickerShown=yes (섹션 필요)
 *   - user-selected: coldStart.userSelected=yes (섹션 필요)
 *   - mismatch-detected: alarmLogSources['cold-start-mismatch'] >= 1
 *
 * #2068 mode-aware stages (Phase 1·2 완료 전 fail이 정상, expected-fail):
 *   - general-mode-no-alarm-sound: sleepMode=off 인데 alarm류(transfer/destination) kind가
 *     fired에 존재 → fail. 일반 모드에서는 alarm.wav 발사 0건이어야 한다(ADR 확정 스펙,
 *     #2061 epic 본문 표).
 *   - sleep-mode-no-per-station-notification: sleepMode=on 인데 station-passed kind가
 *     fired에 존재 → fail. 취침 모드에서는 매역 notification이 mute돼야 한다.
 */
const STAGE_CHECKERS: Record<ChainStageId, StageChecker> = {
  // ── 기존 6 stages ─────────────────────────────────────────────────────────

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

  // ── Phase 6.1 cold start 경로 5 stages (#1875) ────────────────────────────

  /**
   * cold-start-detected: cold start 조건 충족 여부.
   *
   * 판정 우선순위:
   * 1. ## Cold Start 섹션에 detected=yes → pass
   * 2. 섹션 부재 fallback: gpsAccuracy > 50m AND environment=underground|unknown AND no trip
   */
  'cold-start-detected': (f) => {
    if (f.coldStart !== undefined) {
      return {
        passed: f.coldStart.detected,
        evidence: `coldStart.detected=${f.coldStart.detected}`,
      };
    }
    // fallback: 기존 dump 필드에서 파생
    const accuracy = f.gpsAccuracy;
    const env = f.environment;
    const hasTrip =
      f.lifecyclePhase !== undefined &&
      f.lifecyclePhase !== 'none' &&
      f.lifecyclePhase !== 'ended';
    const accuracyExceeds = accuracy !== undefined && accuracy > COLD_START_ACCURACY_THRESHOLD_M;
    const envMatches = env === 'underground' || env === 'unknown';
    const passed = accuracyExceeds && envMatches && !hasTrip;
    return {
      passed,
      evidence: `accuracy=${accuracy ?? '?'}m env=${env ?? '?'} hasTrip=${hasTrip}`,
    };
  },

  /**
   * candidates-extracted: ColdStartCandidate[] 생성 확인.
   *
   * ## Cold Start 섹션의 candidatesCount > 0 로 판정.
   * 섹션 부재 시 false (해당 신호 없음 = 검증 불가).
   */
  'candidates-extracted': (f) => {
    if (f.coldStart !== undefined) {
      const count = f.coldStart.candidatesCount;
      return {
        passed: count > 0,
        evidence: `candidatesCount=${count}`,
      };
    }
    return {
      passed: false,
      evidence: 'coldStart section absent — signal unavailable',
    };
  },

  /**
   * weighted-narrowed: weight 계산 + 정렬 완료 확인.
   *
   * ## Cold Start 섹션의 weightedCount > 0 로 판정.
   * 섹션 부재 시 false.
   */
  'weighted-narrowed': (f) => {
    if (f.coldStart !== undefined) {
      const count = f.coldStart.weightedCount;
      return {
        passed: count > 0,
        evidence: `weightedCount=${count}`,
      };
    }
    return {
      passed: false,
      evidence: 'coldStart section absent — signal unavailable',
    };
  },

  /**
   * picker-shown: picker UI 표시 OR auto-boardingPrompt trigger 확인.
   *
   * ## Cold Start 섹션의 pickerShown=yes 로 판정.
   * 섹션 부재 시 false.
   */
  'picker-shown': (f) => {
    if (f.coldStart !== undefined) {
      return {
        passed: f.coldStart.pickerShown,
        evidence: `pickerShown=${f.coldStart.pickerShown}`,
      };
    }
    return {
      passed: false,
      evidence: 'coldStart section absent — signal unavailable',
    };
  },

  /**
   * user-selected: 사용자 선택 완료 + trip 등록 확인.
   *
   * ## Cold Start 섹션의 userSelected=yes 로 판정.
   * 섹션 부재 시 false.
   */
  'user-selected': (f) => {
    if (f.coldStart !== undefined) {
      return {
        passed: f.coldStart.userSelected,
        evidence: `userSelected=${f.coldStart.userSelected}`,
      };
    }
    return {
      passed: false,
      evidence: 'coldStart section absent — signal unavailable',
    };
  },

  /**
   * mismatch-detected: useStationMismatchDetector 감지 이력 확인.
   *
   * alarmLog sources에 'cold-start-mismatch' >= 1 이면 pass.
   * 이 stage는 mismatch가 발생하지 않는 것이 정상이므로, pass=true는 경보 신호.
   * chain runner에서는 "감지 인프라가 작동했다"는 evidence로 사용.
   *
   * 중요: mismatch-detected=false (pass=false)는 정상 trip에서의 예상 결과.
   * 이 stage는 "문제 감지 capability 테스트" 전용 fixture에서 pass=true를 확인한다.
   */
  'mismatch-detected': (f) => {
    const count = f.alarmLogSources['cold-start-mismatch'] ?? 0;
    return {
      passed: count >= 1,
      evidence: `alarmLog.cold-start-mismatch=${count}`,
    };
  },

  // ── #2068 mode-aware stages ──────────────────────────────────────────────

  /**
   * general-mode-no-alarm-sound: 일반 모드(sleepMode=off)에서 alarm류(transfer/destination)
   * kind가 발사되면 fail. sleepMode 미확인(undefined)이면 판정 불가 → pass(신호 없음, 보수적
   * 미차단) — 기존 dump(## Sleep 섹션 없음)가 이 새 stage로 인해 잘못 fail 처리되지 않도록.
   */
  'general-mode-no-alarm-sound': (f) => {
    const alarmKinds = f.notificationKinds.filter((k) => k === 'transfer' || k === 'destination');
    const passed = f.sleepMode !== 'off' || alarmKinds.length === 0;
    return {
      passed,
      evidence: `sleepMode=${f.sleepMode ?? '?'} alarmKinds=[${alarmKinds.join(',')}]`,
    };
  },

  /**
   * sleep-mode-no-per-station-notification: 취침 모드(sleepMode=on)에서 station-passed kind가
   * 발사되면 fail. sleepMode 미확인(undefined)이면 판정 불가 → pass(보수적 미차단).
   */
  'sleep-mode-no-per-station-notification': (f) => {
    const stationPassedFired = f.notificationKinds.includes('station-passed');
    const passed = f.sleepMode !== 'on' || !stationPassedFired;
    return {
      passed,
      evidence: `sleepMode=${f.sleepMode ?? '?'} station-passed-fired=${stationPassedFired}`,
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
