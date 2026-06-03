/**
 * #746 — 사용자가 알람을 dismiss한 직후, 모든 카테고리(destination/transfer/station-passed)
 * 알람을 한동안 차단하기 위한 정책 상수.
 *
 * 정책: dismiss 시점 이후 아래 두 조건 중 *먼저* 만족하는 쪽까지 모든 알람 silence.
 *  - 시간 경과: DISMISS_SILENCE_MS 이상 경과
 *  - 위치 이동: dismiss 당시 좌표로부터 DISMISS_SILENCE_RADIUS_M 이상 이동
 *
 * dismiss 시점 GPS가 없으면 거리 조건은 평가 불가 — 시간 조건만 사용한다.
 */
export const DISMISS_SILENCE_MS = 5 * 60_000;
export const DISMISS_SILENCE_RADIUS_M = 200;
