import type { AlarmPhaseId } from '../../../shared/types/alarm';

// AlarmPhaseId는 shared/types/alarm으로 추출됨 (#890, Phase 5).
// 기존 호출자 호환을 위해 re-export 유지.
export type { AlarmPhaseId };

export interface AlarmContext {
  remainingStops: number;
  etaSeconds: number | null;
  /**
   * #2688 — 승차역을 실제로 벗어났는가.
   *
   * `false`면 early phase 발사를 보류한다(억제 아님 — 출발이 확인되면 같은 tick 이후 재평가 시
   * 그대로 발사된다). 목적지/환승역이 승차역에서 정확히 1정거장이면 `remainingStops <= 1`이
   * 탑승하는 순간 이미 참이라, 이 조건 없이는 승차 직후 즉시 발사됐다(2026-09-17 성수→뚝섬
   * 40초 오발사 evidence).
   *
   * `undefined`(신호 없음 — lockless 등 승차역 SSoT가 없는 경로)는 보수적으로 게이트 미적용
   * (`!== false`이므로 통과) — 기존 동작 보존. `isStationPassedFirstHop`과 동일한 "신호가 없으면
   * 차단하지 않는다" 패턴.
   */
  departed?: boolean;
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
    // #2688 — ctx.departed === false면 출발 미확인이라 보류. undefined/true는 기존대로 통과.
    evaluate: (ctx) => ctx.remainingStops <= APPROACH_STOPS && ctx.departed !== false,
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
