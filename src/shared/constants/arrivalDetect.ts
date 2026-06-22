/**
 * #925 destination 자동 하차 감지 임계값.
 *
 * "사용자가 destination 역에 도착했고 N초 동안 정지해 있다 = 하차 완료"로 본다.
 *
 * - NEAR_STATION_RADIUS_M (50m):
 *   역 좌표 vs 사용자 좌표의 허용 오차. 서울 지하철역 출구간 거리(통상 100~300m) 대비 보수.
 *   GPS 노이즈가 큰 지하/실내에서는 어차피 GPS 매칭이 안 되므로, 이 게이트는
 *   "지상 + 역 부근"이 명확한 케이스에서만 통과한다. 너무 넓히면 인접 역 통과 시 false positive.
 *
 * - STATIONARY_THRESHOLD_MS (60s):
 *   "정지" 판정 시간. 일반 정차(20~30s)는 통과 못 하고, 하차 후 개찰구로 걷는 시간이
 *   포함되도록 1분. 너무 짧으면 정차 중 자동 해제, 너무 길면 LA가 불필요하게 오래 떠 있다.
 *   재측정 후 (B/C/D 슬라이스에서) 조정 가능.
 */
export const NEAR_STATION_RADIUS_M = 50;
export const STATIONARY_THRESHOLD_MS = 60_000;

/**
 * #1647 — API-independent auto-end gate 임계값.
 *
 * 기존 detectDestinationArrival(arvlCd ARRIVED/ENTERING + 50m + 60s)은 Seoul Arrival API
 * 단일 의존이라 outage(6/22 13:36 / 10.5h 좀비 trip evidence) 시 fire 0건.
 * device self-contained 보장을 위해 API-independent 3-of-3 게이트 추가 (#1647).
 *
 * - DESTINATION_NEARBY_RADIUS_M (100m):
 *   destination 도착 게이트 — GPS noise tolerance를 50m → 100m로 완화.
 *   환승역/인접역 false fire 방지는 destination 1:1 매칭으로 보장 (destination ≠ 환승역).
 *
 * - STATIONARY_TRIP_END_THRESHOLD_MS (5min):
 *   60s → 5min로 강화. 정차(20~30s) + 개찰구(1~2min) + 출구 진입(1~2min) 합산이 안전 마진 안.
 *   3-of-3 합의(lock + destination 100m + 5min stationary)라 false positive 비대칭 작음.
 */
export const DESTINATION_NEARBY_RADIUS_M = 100;
export const STATIONARY_TRIP_END_THRESHOLD_MS = 5 * 60 * 1_000;
