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
// #1897 (RC-5) — 마지막으로 backend가 confirm한 APNs env(sandbox/production).
// register 응답에서 backend가 `existing.apnsEnv ?? incoming.apnsEnv`로 결정한 KV 값을 echo →
// device가 stamp. 다음 register에서 device build env(`resolveApnsEnv()`) 대신 이 값을 우선 송신해
// backend self-heal 발동 횟수를 0에 수렴시킨다. 부재(첫 register / parse 실패) 시 fallback.
// 형식: 'sandbox' 또는 'production' string.
export const LAST_CONFIRMED_APNS_ENV_KEY = 'subway-now:last-confirmed-apns-env';
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
// #1282 — boardingLockScheduler가 `bl:` 알람 예약 시 스냅샷하는 route signature.
// `tba:` 채널의 TRIP_BOUND_ROUTE_SIG_KEY와 동형. scheduledAlarmReceiver가 `bl:` 발사
// 수신 시 현재 route sig와 비교해 stale 알람을 억제한다.
// useBoardingLockScheduler가 scheduleHopsForLock 성공 직후 write, cancel 시 clear.
// 형식: string (boardingLockScheduler.routeSignature 결과).
export const BOARDING_LOCK_ROUTE_SIG_KEY = 'subway-now:boarding-lock-route-sig';
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
// #1501 (ADR-015 §10 P5 / PR-A) — Trip correlation id.
// trip 시작 시 `${epoch ms}-${8 hex}` 형식으로 생성하고 trip 종료(tripBoundCleanups)
// 시점에 제거한다. rawSignalBuffer entry와 backend evidence(P5 PR-B)의 같은 trip을
// 묶기 위한 unique id — 사용자가 trip을 여러 개 빠르게 만들어도 cycle/enter/exit
// entry가 어느 trip 소속인지 사후 재구성한다.
// 형식: 문자열 (`${epoch ms}-${8 hex}`). 키 부재 = trip 미시작 또는 종료된 상태.
export const TRIP_CORR_ID_KEY = 'subway-now:trip-corr-id';
// #1501 (ADR-015 §10 P5 / PR-A) — Device raw signal dump ring buffer (capacity 120).
// useFusedNearestStation 매 cycle에 push되는 (gps, motion, subsurface, source, confidence)
// 측정 entry. boot 시 1회 hydrate, push 후 1초 idle throttle write — 강제종료 후에도
// 마지막 ~120 entry가 복원돼 7일 회귀 사후 분석에 사용.
// 형식: RawSignalEntry[] JSON.
export const RAW_SIGNAL_BUFFER_KEY = 'subway-now:raw-signal-buffer';
// #1520 (ADR-015 §10 P5 / PR-B) — Raw signal dump outbox queue.
// triggerTripEndRecall이 fire-and-forget으로 upload 시도 → 네트워크 실패 시 outbox에 enqueue,
// 다음 cold-launch에서 useLaunchTripReconciliation 시점에 flush. 같은 corrId 재전송은 backend가 덮어쓰기로 처리.
// 형식: {corrId, token, entries}[] JSON. 단일 항목만 보존(가장 최근 trip-end).
export const RAW_SIGNAL_OUTBOX_KEY = 'subway-now:raw-signal-outbox';
// #1520 — 마지막으로 backend에 upload 성공한 corrId. 같은 corrId 재시도는 즉시 skip.
// triggerTripEndRecall이 1차 호출 + outbox flush 양쪽에서 이 키로 멱등성 보장.
// 형식: 문자열 (corrId). 부재 = 아직 upload 성공 trip 없음.
export const LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY = 'subway-now:last-uploaded-signal-dump-corr-id';
// #1279 — 기압계 지하 감지 상태(subsurface boolean) AsyncStorage stamp.
// useBarometer(FG-only React state)가 subsurface flip 시 write → BG silent-push task와
// 위치 게이트가 동일한 값을 read할 수 있도록 한다. updatedAt(epoch ms)은 TTL 만료 판별용.
// 형식: {"subsurface": boolean, "updatedAt": number} JSON.
export const SUBSURFACE_STATE_KEY = 'subway-now:subsurface';
// #1561 (T8, ADR-017 / ADR-016 S2 흡수) — backend가 silent push로 forward한 TripPositionSSoT
// 권위 스냅샷을 device가 mirror하는 AsyncStorage key.
//
// silent push handler가 payload.ssot를 추출하면 JSON으로 그대로 영속화. `useFusedNearestStation`
// cascade picker가 다음 cycle에서 본 값을 읽어 `backend-ssot` tier(최상위)로 채택한다.
// 형식: { currentStationId, motionState, lastAdvanceEvidence, lastAdvanceAt, passedStations, receivedAt } JSON.
//   - receivedAt: device가 silent push를 수신한 epoch ms. cascade picker가 자체 staleness 판정에 사용.
// 미존재 / parse 실패는 cascade가 자연 skip (구 backend 호환, graceful).
export const BACKEND_SSOT_MIRROR_KEY = 'subway-now:backend-ssot-mirror';
// #1518 — device → backend HTTP 호출 로그 ring buffer 영속화.
// `instrumentBackendFetch` wrapper가 모든 backend fetch 시점에 call/response/error entry를
// push하고 ring buffer를 통째로 AsyncStorage에 mirror한다. 앱 재시작 후 진단해도 직전 trip의
// 호출 흔적을 잃지 않게 하는 게 목적. 형식: BackendCallLogEntry[] JSON (capacity 100).
export const BACKEND_CALL_LOG_KEY = 'subway-now:backend-call-log';
// #1579 (P0-3) — alarmLog telemetry forward retry queue.
// trip 종료 시 device가 alarmLog/fusionLog/gpsDrops/ssotMirror snapshot을 backend로 forward.
// 네트워크 실패 시 단건 enqueue, 다음 trip 종료 시 재시도. 가장 최근 trip만 보존 (1건).
// 형식: TelemetryForwardOutboxEntry JSON.
export const TELEMETRY_FORWARD_RETRY_QUEUE_KEY = 'subway-now:telemetry-forward-retry';
// #1575 (T12, ADR-017) — NotificationRouter surface delivery log (ring buffer 200건).
// router.deliver()가 모든 surface fan-out 결과(delivered/suppressed + reason)를 push.
// DebugModal "Notification Delivery" 섹션이 read해 surface별 카운터 + suppress 사유 분포 표시.
// 형식: NotificationDeliveryEntry[] JSON (capacity 200, FIFO eviction).
export const NOTIFICATION_DELIVERY_LOG_KEY = 'subway-now:notification-delivery-log';
// #1502 (M2) — Trip ground truth (사용자 정답지) state.
// trip 종료 직후 사용자에게 "이번 trip 알람 정확했어요? Yes/No" 자동 prompt를 띄우고
// 응답을 누적. ADR-015 §10 P5 가중치 자동 학습의 label(=ground truth)이다.
// 형식: { pendingPrompt: { corrId, endedAt } | null, responses: TripGroundTruthResponse[] } JSON.
export const TRIP_GROUND_TRUTH_KEY = 'subway-now:trip-ground-truth';
// #1923 — 사용자 명시 의향 토글 (infoModeEnabled) SSoT.
// boardingPrompt [탑승] 응답 / BoardingTrainList 직접 탭 시 true로 stamp.
// useApnsTripRegistration이 본 키를 읽어 RegisterTripPayload.infoModeEnabled로 backend에 송신 →
// backend lockless intermediate gate가 통과되어 station-passed silent push가 발사된다
// (backend/alarm-worker/src/scheduled.ts:980 `trip.infoModeEnabled && waypoint.kind === 'intermediate'`).
// trip 종료 시 runTripBoundCleanups에서 false로 reset (이전 trip의 의향 신호가 새 trip에 leak 차단).
// 형식: 'true' 또는 키 부재(=false). ADR-014 §X "사용자 명시 의향 trip = lock 활성과 동급 정확도 보장 의무" 정합.
export const USER_INTENT_INFO_MODE_KEY = 'subway-now:user-intent-info-mode';
// #2045 (Signal 4, Issue #2043 β 후속) — 마지막 silent push 수신 시각 (epoch ms).
// silentPushTask.handleSilentPush가 유효 payload 진입점(handleSilentPush)에서 stamp,
// useLaunchTripReconciliation이 launch 시점에 read해 backend-timeout self-end 판정에 사용.
// 관찰 22 (BG kill 6h+ 방치 후 launch) 커버. FG-전용 3-signal(#2044)과 상호 보완.
// trip 종료 시 runTripBoundCleanups에서 제거 — 이전 trip의 수신 시각이 새 trip 판정 오염 차단.
// 형식: 숫자 (epoch ms) 문자열. 키 부재 = silent push 미수신(첫 launch or 새 trip 시작 직후).
export const LAST_SILENT_PUSH_RECEIVED_AT_KEY = 'subway-now:last-silent-push-received-at';
// #2093 (A) — BG task(`backgroundLocationTask`)가 마지막으로 POST /position을 발사한 시각(epoch ms).
// TaskManager invocation마다 새 컨텍스트라 in-memory ref 쓰로틀(FG hook의 `useFgPositionUpload`
// 패턴)을 쓸 수 없다 — AsyncStorage로 invocation 간 상태를 공유해 POSITION_UPLOAD_MIN_INTERVAL_MS
// (10s) 미만 간격의 연속 catch-up batch 배달에서도 uploadPosition 호출을 1회로 묶는다.
// 형식: 숫자(epoch ms) 문자열. 키 부재 = 첫 fix(즉시 발사).
export const BG_LAST_POSITION_UPLOAD_AT_KEY = 'subway-now:bg-last-position-upload-at';
// #2067 (Phase 2-device) — AlarmLocalAuthority persisted dedup ledger.
// 취침모드 companion silent push(kind `sleep-alarm-companion`)의 TTS/진동 부가 동작이 앱 재시작
// (cold-launch) 후에도 중복 발사되지 않도록 in-memory Set 대신 AsyncStorage에 영속화한다.
// entry TTL 1h — trip 하나가 1시간을 넘는 경우는 드물고, TTL이 지나면 자연 prune돼 무한 성장 방지.
// 형식: { id: string; firedAt: number }[] JSON. id = `alarm-${tripToken}-${station}-${kind}`.
export const ALARM_LOCAL_LEDGER_KEY = 'subway-now:alarm-local-ledger';
// #2122 — FG 보조 발사(로컬 station-passed 알림) 직후 (station, kind) 발사 기록.
// setupNotificationHandler(FG 표시 핸들러)가 뒤늦게 도착한 backend alert push를 렌더하기 전
// 이 기록을 참조해 같은 (station, kind)가 최근 로컬 발사됐으면 표시를 억제한다(2중 방어의 2b).
// TTL RECENT_LOCAL_STATION_FIRE_TTL_MS(recentLocalStationFires.ts) 경과 항목은 add/read 시 cleanup.
// 형식: { "<kind>:<stationName>": timestamp(epoch ms) } JSON.
export const RECENT_LOCAL_STATION_FIRES_KEY = 'subway-now:recent-local-station-fires';
