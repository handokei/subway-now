export type AlarmPhaseId = 'early' | 'imminent';

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
