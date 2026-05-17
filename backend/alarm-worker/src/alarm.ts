/**
 * 알람 phase 판정 로직 — 앱 측 alarmPhases.ts와 동일 의미.
 *
 * 백엔드는 stops 정보가 없으므로 ETA만으로 판정한다.
 * - imminent: etaSeconds <= 30 (도착 임박)
 * - early   : etaSeconds <= 240 (4분 이하)
 *
 * EARLY는 240으로 잡는다. cron 주기 1분 + Seoul API 갱신 지연 ~수십초가 누적되면
 * 180초 경계에서 한 cycle 놓치고 ~60초 늦은 알림이 발생할 수 있어, 한 cycle만큼의
 * 버퍼를 두어 그 가능성을 줄인다.
 *
 * 또한 ETA 변동 폭이 임계치(±60초) 이상이면 트립 메모리 갱신용으로 변동을 신호한다.
 */

export type AlarmPhase = 'early' | 'imminent';

export const IMMINENT_THRESHOLD_SEC = 30;
export const EARLY_THRESHOLD_SEC = 240;
export const ETA_DELTA_THRESHOLD_SEC = 60;

const PHASE_ORDER: readonly AlarmPhase[] = ['early', 'imminent'];

export function evaluatePhase(etaSeconds: number): AlarmPhase | null {
  if (etaSeconds <= IMMINENT_THRESHOLD_SEC) return 'imminent';
  if (etaSeconds <= EARLY_THRESHOLD_SEC) return 'early';
  return null;
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
