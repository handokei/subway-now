/**
 * #3377 — BG에서 울린 취침 알람 오버레이(SleepAlarmOverlay) 재생 창.
 * 창 밖의 저장 이벤트는 이미 지난 알람이라 띄우지 않는다(#2210 stale 억제 원칙).
 */

/** 알림을 탭하지 않고 앱을 열었을 때(FG 진입) — 알람이 울린 지 이 안이면 재생. */
export const ALARM_OVERLAY_REPLAY_WINDOW_MS = 2 * 60_000;

/** 알람 알림을 탭해 열었을 때 — 지난 트립 오표시를 막는 상한. */
export const ALARM_OVERLAY_TAP_WINDOW_MS = 30 * 60_000;
