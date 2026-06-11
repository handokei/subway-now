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
// #700 — useTripOrigin이 destination set 순간 캡처하는 trip origin Station.
// cold restart(앱 강제종료 후 재실행) 시 첫 GPS fix가 진짜 출발역과 다를 수 있어
// route 계산이 잘못된 origin으로 일어나는 회귀를 막기 위해 영속화한다.
// 형식: Station JSON. destination null 또는 새 destination set 시 클리어/재캡처.
export const TRIP_ORIGIN_KEY = 'subway-now:trip-origin';
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
// #791 — BG 위치 권한 거부 시 띄우는 안내 Alert를 사용자가 dismiss한 적이 있는지.
// 'true' 또는 키 부재. 한 번 dismiss하면 앱 재시작 후에도 다시 노출하지 않는다.
// 사용자는 첫 안내로 결정한 상태이므로 반복 노출은 스팸. (WhileInUse 1차 시나리오 정책 정렬)
export const BG_PERMISSION_DENIED_DISMISSED_KEY = 'subway-now:bg-permission-denied-dismissed';
// #711 — BG task가 마지막으로 평가한 nearest station + 평가 시각.
// FG 복귀 직후 fresh fix가 들어오기 전 일시 공백을 메우기 위한 임시 hydrate 용도.
// hydrate 시 locationUncertain=true는 유지 — fresh fix(applyLocation) 도착 시점에 해제된다.
// 형식: {"station": Station, "distanceKm": number, "timestamp": number} JSON.
// WhileInUse 권한 사용자에게는 BG task 자체가 동작하지 않으므로 graceful no-op (key 없음).
export const BG_LAST_STATION_KEY = 'subway-now:bg-last-station';
// #816 C — 사용자 opt-in 토글: lock 없는 trip route에서도 station-passed 알림 허용 여부.
// 기본 OFF. #640 회귀(lock 없는 noise alarm) 차단을 위해 명시적 opt-in 필요.
// 형식: 'true' 또는 키 부재. (sleep 모드 같은 패턴 — 단순 boolean)
export const LOCKLESS_STATION_PASSED_KEY = 'subway-now:lockless-station-passed';
// #816 B — boardingPrompt 발사 추적 (trip당 1회 발사 + dismiss 시 5분 silence).
// 형식: {"tripKey": string, "promptedAt": number, "dismissedAt"?: number} JSON.
// tripKey는 `${destinationId}|${createdAtBucketMs}` — destination 변경 시 자동 reset.
export const BOARDING_PROMPT_STATE_KEY = 'subway-now:boarding-prompt-state';
// #746 — 사용자가 알람을 dismiss한 시점의 timestamp + 좌표(좌표는 null 가능).
// dismiss 후 5분 또는 200m 이동까지 모든 카테고리 알람 silence하는 게이트의 SSOT.
// 형식: {"sinceTs": number, "sinceLat": number | null, "sinceLng": number | null} JSON.
// 새 trip 시작(setDestination switch) 또는 새 BoardingLock 생성 시 즉시 클리어한다.
export const DISMISS_SILENCE_KEY = 'subway-now:dismiss-silence';
// #876 — Sticky Station lock 영속화 키.
// 좋은 fix(accuracy ≤ 50m, speed < 1 m/s)가 같은 역 N회 연속 관찰될 때 그 역을 lock.
// trip 없는 상태(탑승 전 / 환승 대기 / 단순 위치 확인)에서 지하 noise로 흔들리지 않게 표시.
// 형식: {"station": Station, "lockedAt": number} JSON.
// TTL(30분) 경과 또는 1km+ 이동 또는 automotive motion 시 unlock.
export const STICKY_STATION_KEY = 'subway-now:sticky-station';
// #899 (Seam C) — silent push trip-ended 핸들러가 BG에서 작성하는 sentinel.
// BG에서는 zustand store에 접근할 수 없어 storage cleanup만 수행하는데, 그러면
// FG 복귀 시 hydrated 직전의 in-memory store 상태(destination/lock 등)가 stale로
// 잠시 노출된다. trip-ended 시 이 키에 epoch ms를 쓰면 useStateRehydration이
// AppState 'active' 진입 시 키를 읽고 sentinel 이후 destination/lock store를
// reset해 stale UI를 차단한다. 처리 후 키를 즉시 삭제 — 키가 다시 나타나면
// 또 다른 trip-ended를 의미.
// 형식: 숫자 (epoch ms) 문자열.
export const TRIP_ENDED_BY_BACKEND_AT_KEY = 'subway-now:trip-ended-by-backend-at';
// #926 (Seam E3) — 사용자가 Live Activity를 dismiss한 시점(epoch ms).
// silent push 핸들러가 sentinel 활성 동안 LA를 다시 살리지 않도록 차단하는 게이트.
// 사용자의 명시적 dismiss 의사를 존중하되, TTL(LA_DISMISS_SENTINEL_TTL_MS) 경과 후
// 자동 reset해 trip이 살아있는 상태에서 LA가 영영 안 뜨는 사고를 방지.
// HomeScreen 진입/destination 재설정 같은 명시적 의사도 sentinel clear 트리거가 될 수 있다(후속 PR).
// 형식: 숫자(epoch ms) 문자열. 키 부재 = sentinel 없음.
export const LA_DISMISSED_AT_KEY = 'subway-now:la-dismissed-at';
// #919 — Trip 시작 epoch ms. setDestination(non-null)의 switch 분기에서 set,
// trip-end 시점에 recall KPI 계산용 alarmLog 윈도우 lower bound로 사용.
// tripBoundCleanups에서 새 trip 시작 또는 trip 종료 시 함께 제거된다.
// 형식: 숫자(epoch ms) 문자열.
export const TRIP_STARTED_AT_KEY = 'subway-now:trip-started-at';
// #919 — 마지막으로 recall telemetry upload된 tripStart 값. idempotency 가드:
// 같은 trip을 두 번 trigger해도(silent push trip-ended → FG 진입 후 setDestination(null) race 등)
// 중복 upload 되지 않도록 비교한다. 새 trip이 시작되면 tripBoundCleanups에서 제거되어
// 다음 trip에 대해 다시 upload가 가능해진다.
// 형식: 숫자(epoch ms) 문자열.
export const LAST_UPLOADED_RECALL_TRIP_START_KEY = 'subway-now:last-uploaded-recall-trip-start';
// #918 — A3 사전 예약 효과 측정 ledger.
// `tripBoundScheduler.prescheduleStationAlerts` 1건 등록 시 entry 추가,
// `tba:` 알람 발사 수신 시 actualFireMs 기록. trip 종료 시 compute → backend upload.
// 형식: PrescheduledLedgerEntry[] JSON (prescheduledMetrics.ts).
export const PRESCHEDULED_LEDGER_KEY = 'subway-now:prescheduled-ledger';
// #918 — 마지막으로 prescheduled telemetry upload된 tripStart 값. recall과 동형 idempotency.
// 형식: 숫자(epoch ms) 문자열.
export const LAST_UPLOADED_PRESCHEDULED_TRIP_START_KEY =
  'subway-now:last-uploaded-prescheduled-trip-start';
// #918 A3 PR2 — preschedule 시점의 route signature 스냅샷 (#729 흡수).
// `tba:` 알람이 OS로 발사돼 클라가 reconcile할 때 *현재* sig와 비교해 trip 도중 route가
// 바뀐(목적지 변경/환승 재산정/노선 갈아탐) 잔여 알람을 식별·억제한다.
// useTripBoundAlarmScheduler가 preschedule 성공 직후 write, cancel 시 clear.
// 형식: string (boardingLockScheduler.routeSignature 결과).
export const TRIP_BOUND_ROUTE_SIG_KEY = 'subway-now:trip-bound-route-sig';
// #828 — Phase 1+2 fusion wire — active trip의 boarding line code.
// BG/FG location task가 좌표 upload 시 이 line으로 linePolyline snap을 수행해
// `mapMatchedArcM` + `mapMatchedLine`을 backend에 첨부한다.
// registerActiveTrip이 promptDisplay.line으로 set하고 clearActiveTrip이 삭제.
// 형식: LineNumber 문자열 ('1'..'9' | 'airport' | ...). 키 부재 = snap skip(graceful).
export const ACTIVE_BOARDING_LINE_KEY = 'subway-now:active-boarding-line';
// #1032 — 최근 선택한 목적지 리스트. 가장 최근 우선(LRU), 동일 station id는 dedup.
// 최대 RECENT_ROUTES_LIMIT개(`src/shared/constants/recentDestinations.ts`)까지 보관.
// 형식: Station[] JSON.
export const RECENT_DESTINATIONS_KEY = 'subway-now:recent-destinations';
// #1038 — Sentry 에러 모니터링 opt-in 토글. 기본 OFF (opt-in only).
// 사용자 명시 동의 전에는 외부 SaaS(Sentry)로 어떤 데이터도 전송하지 않는다.
// 'true'일 때만 boot 시 Sentry.init 실행. DSN(EXPO_PUBLIC_SENTRY_DSN) 미설정 시 추가 no-op.
// UI 토글은 follow-up PR — 현재는 init 인프라만.
// 형식: 'true' 또는 키 부재.
export const SENTRY_OPT_IN_KEY = 'subway-now:sentry-opt-in';
