import type { AlarmPhaseId } from '../../../shared/types/alarm';

// AlarmPhaseId는 shared/types/alarm으로 추출됨 (#890, Phase 5).
// 기존 호출자 호환을 위해 re-export 유지.
export type { AlarmPhaseId };

export interface AlarmContext {
  remainingStops: number;
  etaSeconds: number | null;
}

export interface AlarmPhase {
  readonly id: AlarmPhaseId;
  readonly evaluate: (ctx: AlarmContext) => boolean;
  /**
   * 도착 시각으로부터 알람 발화까지의 lead(ms).
   * - early: 입력 `hopMs`(직전 hop 소요 시간)를 그대로 사용.
   * - imminent: 도착 10초 전 고정.
   */
  readonly getLeadMs: (hopMs: number) => number;
}

const APPROACH_STOPS = 1;
const IMMINENT_ETA_SECONDS = 10;

/** imminent phase 고정 lead(ms) — 도착 10초 전. early는 입력 `hopMs`를 그대로 사용. */
export const IMMINENT_LEAD_MS = 10_000;

export const ALARM_PHASES: AlarmPhase[] = [
  {
    id: 'early',
    evaluate: (ctx) => ctx.remainingStops <= APPROACH_STOPS,
    getLeadMs: (hopMs) => hopMs,
  },
  {
    id: 'imminent',
    evaluate: (ctx) =>
      ctx.remainingStops <= APPROACH_STOPS &&
      ctx.etaSeconds !== null &&
      ctx.etaSeconds <= IMMINENT_ETA_SECONDS,
    getLeadMs: () => IMMINENT_LEAD_MS,
  },
];
