/**
 * BoardingLock 관련 상수 — PR C/D에서 scheduler/알람도 참조해 drift 방지 (#584).
 */

/**
 * trip ETA 미상 시 lock 생성에 사용할 fallback 지속시간(분).
 * 자동 만료는 expectedDurationMs × BOARDING_LOCK_EXPIRY_FACTOR(=1.5)이므로
 * fallback 적용 시 30 × 1.5 = 45분 후 자동 release.
 */
export const FALLBACK_BOARDING_DURATION_MINUTES = 30;

/**
 * 환승역 도착 list에서 "지금 못 잡는" 열차로 표시(disabled)할 도보 buffer (#584 PR E).
 * arrival.arrivalSeconds < TRANSFER_WALKING_BUFFER_SECONDS 인 첫 차는 비활성화.
 * 평균 환승 도보 시간 — 정밀화는 후속.
 */
export const TRANSFER_WALKING_BUFFER_SECONDS = 180;
