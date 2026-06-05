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
