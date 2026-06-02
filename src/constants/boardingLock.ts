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

/**
 * 정거장당 추정 이동 시간 (ms). #584 PR C scheduler + #621 fusion interpolation 공유 상수.
 * uniform 90s — 노선별/시간대별 정밀화는 후속(#624 hopTime lookup).
 */
export const HOP_TIME_MS = 90_000;

/**
 * #759 — 도착 자동 release 트리거 임계값(m). 사용자가 목적지역과 같은 정거장으로 매칭되고
 * fusion distance가 이 값 미만이면 "도착"으로 간주.
 *
 * 300m로 둔 이유:
 *  - 역 구조물 내(개찰구/출구 보행 반경)에서 GPS 정확도는 50~150m 수준.
 *  - 인접역과의 평균 거리는 600m 이상이라 옆 역으로 잘못 매칭되는 사고를 막을 마진.
 *  - useArrivalAutoClear의 500m보다 보수적 — 자동 release는 lock 해제까지 가는 강한 effect라
 *    더 보수적인 임계값 사용.
 */
export const ARRIVAL_PROXIMITY_THRESHOLD_M = 300;

/**
 * #759 — 도착 신호가 이 시간 이상 지속되어야 자동 release.
 *
 * 45_000ms로 둔 이유:
 *  - fusion 폴링 주기 30s + 사용자가 실제로 하차해 개찰구를 통과하기까지 여유.
 *  - GPS 흔들림으로 한두 사이클 인접역 표시 → 다시 목적지역 복귀하는 케이스에서 grace 만료 회피.
 *  - 너무 짧으면(예: 15s) 정차 직전 한 사이클만 매칭되고 떠나도 release 발화 위험.
 *  - 너무 길면(예: 90s) 사용자가 이미 하차해 다른 곳으로 이동 중인데 lock이 남는 시간이 길어짐.
 */
export const AUTO_RELEASE_GRACE_MS = 45_000;
