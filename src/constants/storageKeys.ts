export const FAVORITES_KEY = 'subway-now:favorites';
export const SLEEP_MODE_KEY = 'subway-now:sleep-mode';
export const DESTINATION_KEY = 'subway-now:destination';
export const FIRED_ALARMS_KEY = 'subway-now:fired-alarms';
export const ALARM_EVENT_KEY = 'subway-now:alarm-event';
export const CUSTOM_ORIGIN_KEY = 'subway-now:custom-origin';
export const THEME_MODE_KEY = 'subway-now:theme-mode';
export const ROUTE_PREFERENCE_KEY = 'subway-now:route-preference';
export const ROUTE_KEY = 'subway-now:route';
export const LAST_NOTIFIED_STATION_KEY = 'subway-now:last-notified-station';
// 사전 예약 alarm: 알림 발사 시 기록되는 station name. alarmRefreshTask가 Arrival API
// 기준역을 정할 때 사용. LAST_NOTIFIED_STATION_KEY(id 기반, GPS 추적)와 분리한 이유:
// 사전 예약 알람은 동명이역 환경에서 노선을 식별할 수 없어 id로 매핑하면 잘못된 노선의
// 좌표/메타로 후속 소비자가 오작동할 수 있다. name만 단일 출처로 둔다.
export const LAST_FIRED_ALARM_STATION_NAME_KEY = 'subway-now:last-fired-alarm-station-name';
export const ALLOW_SPEAKER_KEY = 'subway-now:allow-speaker';
export const ACCESSIBILITY_MODE_KEY = 'subway-now:accessibility-mode';
export const SLEEP_MODE_GUIDE_SHOWN_KEY = 'subway-now:sleep-mode-guide-shown';
export const LOCALE_PREFERENCE_KEY = 'subway-now:locale-preference';
export const ALARM_LOG_KEY = 'subway-now:alarm-log';
export const APNS_TOKEN_KEY = 'subway-now:apns-token';
export const ACTIVE_TRIP_KEY = 'subway-now:active-trip';
export const TRIP_TRAIN_CODE_KEY = 'subway-now:trip-train-code';
// #498 — silent push 게이트 outcome 텔레메트리. 마지막 flush 시각(epoch ms).
// 다음 flush는 이 시점 이후의 alarmLog 엔트리만 집계 → 중복 방지.
export const TELEMETRY_LAST_FLUSH_KEY = 'subway-now:telemetry-last-flush';
// #527 — BG 위치 task의 jump gate가 참조하는 직전 수용 fix.
// 형식: {"lat":number,"lng":number,"timestamp":number} JSON.
export const BG_LAST_FIX_KEY = 'subway-now:bg-last-fix';
// #574 P2e — 디바이스가 fire한 silent push의 pushId 집합. alert fallback race 시 중복 표시 차단.
// 형식: {"[pushId]": timestamp} JSON. 5분 이상 된 항목은 add/read 시 cleanup.
export const FIRED_PUSH_IDS_KEY = 'subway-now:fired-push-ids';
// #584 PR A — 사용자가 명시적으로 확정한 탑승 열차/노선/시각. trip 종료 또는 자동 만료까지 유지.
// 형식: BoardingLock JSON (src/types/boardingLock.ts).
export const BOARDING_LOCK_KEY = 'subway-now:boarding-lock';
// #584 PR C — boardingLockScheduler가 OS에 사전 예약한 알림 identifier 목록.
// release/expiry 또는 새 Lock 시점에 일괄 cancel하기 위한 추적 큐.
// 형식: string[] JSON.
export const SCHEDULED_NOTIFICATIONS_KEY = 'subway-now:scheduled-notifications';
// #623 — 글로벌 알람 kill switch. ON일 동안 모든 alarm fire/schedule 경로 차단.
// 사용자가 잠금화면 dismiss로도 진동이 안 멈춰 100% 차단 토글 요청.
export const ALARMS_KILLED_KEY = 'subway-now:alarms-killed';
