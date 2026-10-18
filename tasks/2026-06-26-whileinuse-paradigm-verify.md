# WhileInUse Paradigm Verify — BG widget update 차단 영향 분석 (2026-06-26)

사용자 질문: "BG에서는 업데이트 안 되고 앱에 들어가고 나서 가능하다는거지?" → **YES, foreground location 업데이트 경로만 가능. 단 silent push 채널은 별개 (권한 무관).**

## WhileInUse vs Always 권한 차이 + subway-now 권한 요청 path

iOS Location Services 3-tier — `notDetermined → whileInUse → always`. `whileInUse`는 앱이 FG일 때만 위치 추적 가능(BG suspended 시 stop). `always`는 BG suspended 상태에서도 location updates / region monitoring / SLC 동작.

subway-now 권한 요청 path:
- `useOnboardingPermissions.ts:23` — 온보딩 시 `Location.requestForegroundPermissionsAsync()` (= WhileInUse) 1차.
- `useBackgroundLocation.ts:51` — destination 등록 시 `Location.requestBackgroundPermissionsAsync()` (= Always upgrade) 2차. 거부 시 `BG_PERMISSION_DENIED_DISMISSED_KEY` 영구 dismiss(#791), Alert 1회.
- `app.config.js:81-83` — 3-tier 사용 설명 i18n 메시지 (`locationWhenInUsePermission` / `locationAlwaysPermission` / `locationAlwaysAndWhenInUsePermission`).

**WhileInUse 사용자가 다수** (사용자 명시 정책 + iOS UX 컨벤션). Always upgrade를 1회 거부하면 향후 영구 silent.

## `backgroundLocationTask` 동작 조건 (WhileInUse 가능 여부)

`useBackgroundLocation.ts:51~74` — `Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)` 호출은 **반드시 Always 권한 후에만** 실행됨 (`status !== 'granted'` early return). 즉 WhileInUse 사용자는:

- `TaskManager.defineTask(BACKGROUND_LOCATION_TASK, ...)` 등록은 모듈 import 시점에 됨 (silentPushTask.ts와 동일).
- 그러나 `startLocationUpdatesAsync` 미호출 → OS가 **task callback을 fire 안 함**.
- 결과: `backgroundLocationTask.ts:104~322` 본체(가속도 fingerprint, BG_LAST_FIX/STATION update, uploadPosition, processLocationUpdate, **saveStationToWidget**, evaluateBackgroundTransferSwap) **전체 0건 실행**.

`feedback_whileinuse_must_work.md` L16 명시: "BG GPS(`Location.startLocationUpdatesAsync`)는 WhileInUse에서 동작 안 함 → silent push, region monitoring, FG state freshness 보강에 우선순위." 이 룰은 **현재 코드와 정확히 일치**(고의 설계).

## BG widget update 차단의 paradigm 위반 여부

`saveStationToWidget` production caller 5개 (`bg-widget-wire.md` 분석):

| Caller | WhileInUse 동작 |
|---|---|
| `HomeScreen.tsx:865` `useWidgetMirror` | FG only — WhileInUse OK |
| `HomeScreen.tsx:844` AppState 'active' 복귀 | FG only — WhileInUse OK |
| `backgroundLocationTask.ts:291` | **WhileInUse 0건** |
| `notificationRouter.ts:74` widget surface | 알림 발사 시 — 채널 무관 |
| `tripBoundCleanups.ts:138` clear | trip 종료 — 채널 무관 |

**paradigm 위반 아님** 결론:
- `feedback_whileinuse_must_work.md`는 "WhileInUse 1차 + Always 추가 보강" 명시. BG widget update를 Always-only로 두는 것은 룰의 의도(보강 경로) 안.
- 그러나 V/X 다운로드 가치 표 기준 별 평가 필요: WhileInUse 사용자는 **위젯이 FG 진입 후에만 freshness refresh**. 출퇴근 BG 1시간 내내 위젯은 `savedAt+10min` 후 EXPIRED tier(opacity 0.45 + "정보 오래됨" caption). station name은 **그대로 노출**(stale).
- 위젯 5분 timeline emit + `SubwayWidget.swift:88` RC-15 staleAt/expiredAt 사전 entry 삽입(`#1890`)으로 OS 자율 freshness UI 전환은 가능 — 단 station name 자체 갱신은 X.

→ **WhileInUse 사용자의 위젯은 FG 진입 1회 후 BG 10분간만 fresh, 이후 stale 표시.** paradigm 룰("1차 시나리오") 충족이지만 **다운로드 가치 V (위젯 mirror)는 부분적**.

## silent push로 BG widget update 대체 가능 여부

silent push 채널: APNs `content-available=1` → iOS가 BG에서 expo-notifications BG task fire → `silentPushTask.ts:754 handleSilentPush`. 채널은 **OS 푸시 인프라**라 위치 권한 무관 동작 (APNs 등록 + Notifications 권한만 필요).

현 코드에서 **silent push handler는 `saveStationToWidget` 호출 X**. `handleSilentPush` finally 블록(`silentPushTask.ts:964~975`):
- `flushAlarmLog` (측정)
- `refreshLiveActivityFromBackgroundContext` — **LA만 update, widget 별도 채널**.

`refreshLiveActivityFromBackgroundContext.ts:107~127`이 `BG_LAST_STATION_KEY`를 읽어 LA refresh하지만 `saveStationToWidget`/`WidgetCenter.reloadAllTimelines`는 미호출. **위젯은 silent push로 update 받지 못함**.

→ **silent push로 BG widget update 대체 wire 존재 가능**: `refreshLiveActivityFromBackgroundContext`에 `saveStationToWidget(bg.station, bg.distanceKm, ..., force=true)` 호출 1줄 추가하면 권한 무관 widget update 채널 확보. 단 BG_LAST_STATION_KEY 자체가 WhileInUse면 stale (마지막 FG 진입 시 적재) → silent push payload의 `nextWaypoint`/`ssot.currentStationId`로 station 확정 후 stations.json lookup → widget stamp가 더 정확.

## 다운로드 가치 시나리오별 권한 영향 매트릭스

| 시나리오 | WhileInUse 동작 | Always 동작 |
|---|---|---|
| S1 앱 켜면 현재역 | OK (FG GPS) | OK |
| S7 trip 종료 옛 알림 정리 | OK (silent push 채널) | OK |
| V4 매역 silent 알림 | **OK (silent push 채널, 본 trip 미동작은 별개 wire 결함)** | OK |
| 위젯 BG update (50m bucket) | **X — FG 진입 후 10분만 fresh, 이후 stale name 유지** | OK |
| LA Dynamic Island BG update | OK (silent push → refreshLiveActivityFromBackgroundContext) | OK |
| V7 지하 station-passed 정확 | 부분 (silent push로 알림 OK, 위젯은 stale 가능) | OK |
| BG transfer swap 자동 감지 | **X — `evaluateBackgroundTransferSwap` 미실행** | OK |
| BG accelerometer fingerprint 송신 | **X — `uploadPosition`/`startAccelerometerFingerprint` 미실행** | OK |
| BG_LAST_FIX/STATION 적재 | **X — FG 마지막 fix가 stale로 잔존** | OK |

## 본 fix 적용 후 WhileInUse 사용자 시나리오 cover 비율

본 trip 분석(영역 H maxAge, 영역 B boardingPrompt, 영역 D' dismissNotificationAsync)은 **silent push 채널 + FG fusion 정확성** fix. WhileInUse 사용자 영향:

- 영역 H maxAge → FG GPS 정확성 fix → WhileInUse 사용자 S1/V4 직접 회복.
- 영역 B boardingPrompt → trip 등록 정확 + silent push 발사 정상화 → WhileInUse 사용자 V4 회복 (silent push 채널 무관 도달).
- 영역 D' dismissNotificationAsync → LA 차단 fix → WhileInUse 사용자 LA UI 직접 회복.

**cover 비율 추정 ~70%** (FG/silent push/LA). 미커버 30%:
- BG widget 50m bucket update — `refreshLiveActivityFromBackgroundContext`에 widget stamp wire 추가 필요(별도 fix).
- BG transfer swap 자동 감지 — silent push handler에 `evaluateBackgroundTransferSwap` ports 호출 wire 필요(별도 fix).
- BG accelerometer fingerprint 송신 — silent push 채널로 `uploadPosition` piggyback 가능 여부 별도 검토.

**결론**: 본 fix는 paradigm 위반 아님 (WhileInUse 1차 시나리오 정상 처리). BG widget 미update는 `feedback_whileinuse_must_work.md` 룰의 "Always 추가 보강" 영역. 단 **사용자 다수가 WhileInUse라면 silent push 채널로 widget update wire를 1줄 추가하는 follow-up이 다운로드 가치 V(위젯) 100% 회복에 가장 큰 효율**.
