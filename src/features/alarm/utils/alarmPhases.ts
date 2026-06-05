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
}

const APPROACH_STOPS = 1;
const IMMINENT_ETA_SECONDS = 10;

export const ALARM_PHASES: AlarmPhase[] = [
  {
    id: 'early',
    evaluate: (ctx) => ctx.remainingStops <= APPROACH_STOPS,
  },
  {
    id: 'imminent',
    evaluate: (ctx) =>
      ctx.remainingStops <= APPROACH_STOPS &&
      ctx.etaSeconds !== null &&
      ctx.etaSeconds <= IMMINENT_ETA_SECONDS,
  },
];
