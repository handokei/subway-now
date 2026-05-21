/**
 * 알람 phase 판정 로직 — 앱 측 alarmPhases.ts와 동일 의미.
 *
 * #409: ETA 예측 오차로 인한 ~1분 지연을 줄이기 위해 Seoul API의 `arvlCd` 실측
 * 신호를 우선 사용한다. arvlCd가 phase trigger에 매칭되지 않으면 ETA 임계값 기반
 * fallback. 두 신호의 합집합으로 발화 → polling 경계 오차 영향 최소화.
 *
 * 우선순위:
 *   1. arvlCd ∈ {0 ENTERING, 1 ARRIVED}             → imminent (실측, 오차 거의 0)
 *   2. arvlCd ∈ {4 PREV_ENTERING, 5 PREV_ARRIVED}   → early    (1정거장 전 실측)
 *   3. etaSeconds <= IMMINENT_THRESHOLD_SEC          → imminent (ETA fallback)
 *   4. etaSeconds <= EARLY_THRESHOLD_SEC             → early    (ETA fallback)
 *   5. 그 외                                          → null
 *
 * EARLY 임계값 240은 cron 주기 1분 + Seoul API 갱신 지연 흡수용 버퍼. arvlCd 도입
 * 이후엔 fallback 경로에서만 의미.
 *
 * ETA 변동 폭이 임계치(±60초) 이상이면 트립 메모리 갱신용으로 변동을 신호한다.
 */

export type AlarmPhase = 'early' | 'imminent';

export const IMMINENT_THRESHOLD_SEC = 30;
export const EARLY_THRESHOLD_SEC = 240;
export const ETA_DELTA_THRESHOLD_SEC = 60;

/** Seoul API arvlCd 값. src/constants/arrivalCodes.ts와 동일 의미 (백엔드 카피). */
export const ARRIVAL_CODE = {
  ENTERING: 0,
  ARRIVED: 1,
  PREV_ENTERING: 4,
  PREV_ARRIVED: 5,
} as const;

const IMMINENT_CODES: readonly number[] = [ARRIVAL_CODE.ENTERING, ARRIVAL_CODE.ARRIVED];
const EARLY_CODES: readonly number[] = [ARRIVAL_CODE.PREV_ENTERING, ARRIVAL_CODE.PREV_ARRIVED];

const PHASE_ORDER: readonly AlarmPhase[] = ['early', 'imminent'];

/**
 * ETA 단독 phase 판정 (legacy / fallback).
 * arvlCd가 의미있는 신호를 못 주는 케이스에서만 단독 호출.
 */
export function evaluatePhase(etaSeconds: number): AlarmPhase | null {
  if (etaSeconds <= IMMINENT_THRESHOLD_SEC) return 'imminent';
  if (etaSeconds <= EARLY_THRESHOLD_SEC) return 'early';
  return null;
}

/**
 * arvlCd 실측 신호 + ETA fallback 결합 phase 판정 (#409).
 * arvlCd가 phase trigger에 해당하면 즉시 반환, 아니면 evaluatePhase(eta)로 fallback.
 * arvlCd가 null이거나 비매칭 코드(2 출발, 3 전역출발, 99 운행중)일 땐 ETA fallback.
 */
export function evaluatePhaseFromSignal(
  etaSeconds: number,
  arvlCd: number | null,
): AlarmPhase | null {
  if (arvlCd !== null) {
    if (IMMINENT_CODES.includes(arvlCd)) return 'imminent';
    if (EARLY_CODES.includes(arvlCd)) return 'early';
  }
  return evaluatePhase(etaSeconds);
}

/**
 * 이미 발사한 phase보다 더 진행된 phase일 때만 true. (early 이후 imminent는 발사, 역방향은 미발사.)
 */
export function shouldFire(current: AlarmPhase, lastFired?: AlarmPhase): boolean {
  if (!lastFired) return true;
  return PHASE_ORDER.indexOf(current) > PHASE_ORDER.indexOf(lastFired);
}

export function isSignificantEtaChange(prev: number | undefined, next: number): boolean {
  if (prev === undefined) return true;
  return Math.abs(prev - next) >= ETA_DELTA_THRESHOLD_SEC;
}
