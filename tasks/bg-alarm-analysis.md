# BG 알람/추적 — "꺼지지 않고 계속 깨우면서 이동 + BG 알림" 동작 분석 및 원인 추적

작성: 2026-05-27. 사용자 보고 ("군자 통과 중인데 앱은 용마산 표시 — 3개 역 차이") 의 원인을 코드 차원에서 분리해 분석한다.

## TL;DR

### 권한 정책 (1차 시나리오)
**WhileInUse("사용하는 동안") 권한이 다수 사용자의 기본값**. 모든 핵심 기능이 **WhileInUse에서 정상 동작**해야 함. Always는 추가 보강 경로로 취급. (메모리: `feedback_whileinuse_must_work`)

### 코드 차원 평가
코드는 BG에서 알림이 오게 **이미 짜여 있다**. WhileInUse 시나리오에 대해서도 **Silent Push를 1차 채널로 설계**되어 있음(#478 완료). "꺼지지 않고 계속 깨우면서" 동작도 OS가 허용하는 한계까지 옵션 적용됨.

### 사용자 증상의 직접 원인
> **FG의 React state(useNearestStation의 result)는 BG task와 독립적으로 살아 있다. BG 동안 BG task가 GPS를 받아 알람/AsyncStorage는 갱신하지만, FG 복귀 시 화면에 표시되는 "현재 역"은 BG 진입 시점의 fix로 정지된 채 watchPosition 첫 콜백을 기다린다.**

WhileInUse 사용자는 BG에서 GPS 갱신 자체가 없어 **이 stale 표시 문제가 더 빈번**. PR #543이 fix.

## 1. 시스템 분리 — BG와 FG는 같은 GPS를 공유하지 않는다

| 출처 | 컨텍스트 | 갱신 대상 | 살아있는 시점 |
|---|---|---|---|
| `useNearestStation` `watchPositionAsync` | React tree (FG) | React state (result, userLocation, accuracyMeters) → 화면 표시 | FG 활성 시 |
| `backgroundLocationTask` (`TaskManager.defineTask`) | iOS BG task | AsyncStorage (`ALARM_EVENT_KEY`, FIRED_ALARMS, `BG_LAST_FIX_KEY`) + 알림 발사 | BG, "항상" 권한 시 |
| `silentPushTask` (`Notifications.registerTaskAsync`) | iOS notification BG | AsyncStorage + 알림 발사 | 앱 종료/Suspended에서도 OS가 깨움 |

**핵심**: BG task가 동작 중이어도 `useNearestStation`의 React state는 직접 갱신되지 않는다. FG 복귀 시 화면이 BG 시점 fix를 그대로 보여주는 이유.

## 2. 사용자 증상 → 원인 가설 매트릭스

### 가설 A — FG state stale (PR #543가 해결)
- **시나리오**: 사용자가 용마산에서 화면을 끈다 → BG task가 20m/30s마다 깨워 GPS 받아 알람 트리거(있다면)는 정상 → 군자에 도착해 화면을 켠다 → `useNearestStation`의 React state는 여전히 BG 진입 직전 fix(용마산 좌표). UI는 watchPositionAsync 첫 콜백(~2s)까지 그 state를 표시.
- **증거**:
  - `app/(tabs)/index.tsx:215`의 AppState 'active' 리스너는 `startWatch()`만 호출 — fresh fix를 명시적으로 요청하지 않음
  - `startWatch()` 내부에서 `getLastKnownPositionAsync()` 호출하나, freshness(15s)/accuracy(200m) 게이트로 BG 중 마지막 fix는 대부분 stale 처리 → 적용 안 됨
  - 따라서 fresh watchPosition 콜백 도착까지 state는 그대로
- **3개 역의 의미**: BG 5분 (역간 평균 1km, 시속 35km → 100s/역, 3역 = 300s)에서 흔히 발생. 화면 잠깐 끈 시간으로 자연스러움.
- **해결**: AppState 'active' → `setLocationUncertain(true)` + `refresh()`. PR #543.

### 가설 B — WhileInUse 권한 (BG task 자체 미실행)
- **시나리오**: 사용자 권한이 "사용 중"이면 `Location.startLocationUpdatesAsync` 자체가 무효. BG 동안 GPS 추적 0. 알람도 BG GPS 경로로는 발사 0 → silent push 단독 의존.
- **증상 매칭**: BG → FG 전환 시 가설 A와 동일하게 stale. 게다가 BG에 받았어야 할 알람도 못 받음.
- **확인 방법**: `useBackgroundLocation`의 `Location.requestBackgroundPermissionsAsync` 결과 status. iOS Settings → 앱 → 위치 → "항상" 여부.
- **메모리**: `feedback_location_permission_scope` — 사용자 다수가 WhileInUse라는 운영 인식.

### 가설 C — Track A 활성이지만 BG GPS 좌표 게이트 drop
- **시나리오**: "항상" 권한 + BG task 실행. 그러나 지하/터널/약신호에서 fix accuracy가 200m 초과 → `backgroundLocationTask` 진입부에서 `isAccuracyAcceptable` drop → processLocationUpdate 미호출 → 알람 미발화 + `BG_LAST_FIX_KEY` 미갱신.
- **증상 매칭**: 알람 안 옴 + FG 복귀 시 stale.
- **확인 방법**: `logSuppressedGate('gate-accuracy', ...)` 진단 로그 발생 빈도. DebugModal에 노출됨.
- **관련**: 메모리 `feedback_realtime_priority` — "나쁜 좌표 거부" 정책 의도적.

### 가설 D — Silent push 미수신 (release 빌드 회귀)
- **시나리오**: alarm-worker가 silent push 보냈으나 디바이스에 도달 못 함 (APNs token / env / OS throttle).
- **증상 매칭**: train data 기반 알람 안 옴. 하지만 "현재 역 3개 차이"는 silent push로 표시 갱신 안 함 → 가설 A/B/C와 직교.
- **관련**: #506 트랙, `getSilentPushRegistrationStatus`로 가시화.

### 가설 E — iOS BG location update 빈도 자율 감속
- **시나리오**: "항상" 권한이어도 iOS가 사용자 패턴 학습 후 BG location 빈도 throttle. 코드는 `pausesUpdatesAutomatically:false` + `AutomotiveNavigation`으로 완화하나 OS 정책 한계.
- **증상 매칭**: BG GPS 콜백이 30s가 아니라 수 분에 1회 → 가설 C와 결합되어 알람 누락 + state 갱신 누락.
- **확인 방법**: 운영 alarmLog에서 BG fix 도달 시각 간격 분포.

## 3. "BG에서 알림이 오게" 코딩 — 단계별 검증

### A. iOS Background Modes (`app.config.js`)
```js
UIBackgroundModes: ['location', 'fetch', 'remote-notification']
```
- `location` ✅ — BG GPS 콜백 허용
- `remote-notification` ✅ — silent push 수신 허용
- `fetch` — 레거시 BGAppRefreshTask. `alarmRefreshTask`는 self-unregister만 (#411).

### B. 권한 사용 문구 (Info.plist 매핑)
```js
locationAlwaysAndWhenInUsePermission
locationAlwaysPermission        // "백그라운드에서 지하철역을 지속적으로 감지하기 위해..."
locationWhenInUsePermission
```

### C. BG GPS 시작/중단 (`useBackgroundLocation`)
- `destination` 있을 때만 시작. 해제 시 stopLocationUpdatesAsync.
- 권한 거부 시 사용자에게 모달 1회 + Settings 이동. 거부 후 다시 묻지 않음 (deniedAlertShownRef).

### D. BG GPS 옵션 (`LOCATION_TRACKING_OPTIONS`)
```ts
accuracy: BestForNavigation
activityType: AutomotiveNavigation          // iOS가 GPS를 가장 공격적으로 유지
pausesUpdatesAutomatically: false           // stationary 오판 차단
distanceInterval: 20m + timeInterval: 30s   // 거리/시간 둘 다 보장
showsBackgroundLocationIndicator: true      // iOS 상태바 점 표시 (사용자 인지)
// deferredUpdatesInterval 미설정 — batching 비활성 (#189)
```

### E. BG GPS 콜백 처리 (`backgroundLocationTask`)
```
locations[] → latest → 게이트(fresh<15s, accuracy<200m, jump<50m/s)
→ AsyncStorage에서 destination/sleepMode/route/allowSpeaker 로드
→ processLocationUpdate → alarmEvent 발생 시 FIRED_ALARMS + ALARM_EVENT_KEY 저장
```
- **이 task가 알람 발사를 직접 한다**. `processLocationUpdate`가 내부에서 `Notifications.scheduleNotificationAsync` 호출.

### F. Silent Push 처리 (`silentPushTask`)
```
APNs payload → extractPayload → 위치 게이트(거리 800m/400m/300m phase별)
→ FIRED_ALARMS dedup → buildAlarmContent → Notifications.scheduleNotificationAsync(trigger:null)
```
- `registerSilentPushTask`가 앱 시작 시 호출되어 OS에 task 라우팅 등록.

### G. APNs Trip 등록 (`useApnsTripRegistration`)
- destination 설정 → device push token 발급 → alarm-worker에 trip 등록(POST /trips)
- 백엔드가 train data 기반 ETA 계산 후 silent push 발사

### 검증 결과
- A~G 모두 코드 차원에서 정상 구현됨.
- "BG에서 알림 오게 코딩되어 있는가?" → **YES**, 두 채널(BG GPS, Silent Push) 독립 발화 + 공통 dedup.

## 3.1 WhileInUse 사용자 — 실제 동작 검증 (1차 시나리오)

WhileInUse 권한 사용자는 BG 동안 OS가 GPS를 앱에 전달하지 않는다. 따라서 다음 두 경로만으로 모든 동작이 보장돼야 한다.

### 동작하는 것
| 동작 | 경로 | 코드 |
|---|---|---|
| FG GPS 추적/표시 | `useNearestStation.watchPositionAsync` | ✅ FG 활성 시 2s 간격 |
| BG 알람 발사 | Silent Push → `silentPushTask` | ✅ alarm-worker 기반 |
| 강제 종료 후 알람 | OS가 silent push로 ~30s 깨움 | ✅ |
| 알람 dedup | FIRED_ALARMS (FG/BG/silent push 공통) | ✅ |
| FG 복귀 시 위치 갱신 | (PR #543 이후) refresh + uncertain 마킹 | ✅ #543 |

### 동작하지 않는 것 (Always 전용)
| 동작 | 비고 |
|---|---|
| BG GPS 추적 | `Location.startLocationUpdatesAsync`가 WhileInUse에서 no-op |
| BG GPS 기반 알람 | backgroundLocationTask 미실행 |
| 정밀 지도 폴리라인 BG 업데이트 | 사용자가 화면 켜야 갱신 |

### 결론 — WhileInUse 시나리오 보장 여부
- **알람 발사**: ✅ Silent Push 단독 채널로 보장 (#478 완료)
- **알람 신뢰성**: ⚠️ Silent push delivery 의존 — #506/#542 진단 트랙 가동 중
- **FG 표시**: ✅ #543 머지 시 stale 해결
- **앱 강제 종료 케이스**: ✅ Silent push가 OS 깨움으로 처리
- **지하 구간**: ⚠️ silent push는 train data 기반이라 GPS 무관하나, 디바이스 네트워크 끊김 시 수신 지연

**현실적 약점**: WhileInUse 사용자의 알람 신뢰성 = silent push delivery 신뢰성. 백엔드/APNs 트랙(#506)이 핵심.

## 4. "계속 깨우면서 이동" 시나리오별 매트릭스

| 시나리오 | Track A (BG GPS) | Track B (Silent Push) | React state 갱신 | 알람 발화 |
|---|---|---|---|---|
| FG + 화면 켜짐 | — | — | ✅ 2s/콜백 | FG GPS 기반 |
| BG + "항상" 권한 | ✅ 20m/30s | ✅ 백업 | ❌ (FG 복귀 시 stale) | ✅ |
| BG + "사용 중" 권한 | ❌ | ✅ 단독 | ❌ | Silent push 의존 |
| 앱 강제 종료 | ❌ | ✅ OS가 ~30s 깨움 | ❌ (앱 죽음) | Silent push 단독 |
| 지하/터널 (BG) | ⚠️ accuracy 게이트 drop | ✅ train data 기반 | ❌ | Silent push가 주력 |
| 사용자 정지 (BG) | ⚠️ OS 자율 감속 | — | ❌ | 발사 안 함 |
| BG→FG 전환 (이동 후) | — | — | ❌ → 첫 watch 콜백까지 stale | — |

**"꺼지지 않고 계속 깨우면서 이동"의 실제 의미**:
- 알람 발사 관점: **YES** ("항상" 권한 + 정상 신호 시). 지하/throttle 케이스는 silent push로 보완.
- 화면 표시 관점: **NO** (가설 A) — React state는 BG 중 정지. PR #543가 FG 복귀 시 명시적 fresh fix로 보강.

## 5. 사용자 보고 증상의 코드 차원 진단 흐름

```
"군자 통과 중 → 앱은 용마산 표시"
         │
         ├─ 화면 켰을 때 보이는가? (한 번 본 후 갱신은 빠른가?)
         │   ├─ YES: 가설 A 단독. PR #543가 해결.
         │   └─ NO (시간 지나도 안 바뀜): 가설 B/C/E 의심
         │
         ├─ 알람은 받았는가?
         │   ├─ YES (이전 trip의 알람들이 잘 옴): Track A or B 정상. 가설 A 단독.
         │   └─ NO: 가설 B (WhileInUse) or C (게이트 drop) or D (silent push 미수신)
         │
         ├─ 권한이 "항상"인가?
         │   ├─ YES: 가설 B 제외. 가설 C/E 검토.
         │   └─ NO: 가설 B 강력. "항상"으로 업그레이드 UX 필요 (service-gap-plan §4).
         │
         └─ DebugModal에서 `gate-accuracy` drop 로그 빈도 확인
             ├─ 잦음: 가설 C 강력. MAX_ACCURACY_M=200m가 운영 환경에 엄격할 수 있음 (#447 트랙).
             └─ 거의 없음: 가설 E (iOS throttle) or A.
```

## 6. PR #543가 해결하는 부분 / 안 하는 부분

### 해결 (가설 A)
- AppState 'active' 핸들러에서 `setLocationUncertain(true)` + `refresh()` 호출
- refresh가 `getCurrentPositionAsync` one-shot fresh fix를 즉시 요청 → `applyLocation` → uncertain 해제 + React state 갱신
- UI는 "위치 확인 중" 표시 후 fresh 위치로 자동 갱신

### 안 함 (다른 가설)
- 가설 B: WhileInUse → BG GPS 자체 부재. 별도 UX 트랙 필요(권한 업그레이드 안내 — #447/494 영역)
- 가설 C: 지하 정확도 → 게이트 임계값 튜닝 트랙(#447)
- 가설 D: Silent push 미수신 → 백엔드/APNs 트랙(#506)
- 가설 E: iOS throttle → OS 정책 한계, 코드 옵션은 이미 최대치

## 7. 추가 개선 후보 (#543 후속 또는 별도 이슈)

### WhileInUse 우선 보강 (다수 사용자 시나리오)
1. **Silent push 수신 신뢰성 측정 + 가시화** (#506 트랙 확장)
   - 백엔드 발사 시각 vs 디바이스 수신 시각 분포
   - APNs token 갱신 빈도/실패율
   - sentAt → receivedAt latency 분포
   - **WhileInUse 사용자에겐 이게 1순위 신뢰성 지표**
2. **Silent push delivery 실패 시 fallback** (#493 트랙)
   - silent push → alert push 전환 (강제 종료 BG 알림 보완)
3. **Region monitoring / Geofence** (#494)
   - iOS는 WhileInUse 앱에 대해서도 region monitoring 콜백 허용
   - 목적지/환승역 진입 시 OS가 앱을 깨워 silent push 백업 채널로 사용
4. **권한 상태 안내 UI** (강제 X)
   - 메모리 `feedback_whileinuse_must_work`: "현재 권한에서 가능한 동작 + 제한"을 사용자에게 명확히 전달
   - "사용하는 동안" 권한이어도 모든 알람이 동작함을 안내. "항상"은 추가 보강이라고 명시

### FG state freshness 보강 (#543 후속)
5. **BG task의 last fix를 FG 복귀 시 적용**
   - 현재: `BG_LAST_FIX_KEY`는 jump gate용으로만 사용
   - 제안: AppState 'active' 시 `BG_LAST_FIX_KEY`를 읽어 freshness 통과하면 `applyLocation`에 주입 → fresh fix 도착 전 stale 시간을 더 줄임
   - **다만 WhileInUse 사용자에겐 효과 없음 (BG task 미실행)** → Always 사용자만 보강
6. **`Location.getLastKnownPositionAsync` 활용 강화**
   - WhileInUse에서도 iOS는 시스템 차원의 last known을 일부 보유. 단 갱신 여부는 OS 정책.

### 진단 인프라
7. **DebugModal에 BG fix 도달 빈도 그래프** (alarmLog 기반)
8. **DebugModal에 silent push 수신 latency 분포** (#506 측정 인프라 확장)
9. **권한 상태 노출** (DebugModal "권한: WhileInUse / Always" 표시)

## 8. 결론

### Q1. "BG가 꺼지지 않고 계속 깨우면서 이동 + 알람 가능하게 코딩되어 있는가?"

**WhileInUse(다수 사용자) 관점**:
- 알람 발사: ✅ Silent Push가 1차 채널. WhileInUse에서도 alarm-worker가 train data 기반으로 발사 → OS가 silent push로 앱 깨움 → silentPushTask 처리 → 알림 발사.
- 화면 표시: BG 동안 GPS 갱신 0 → FG 복귀 시 stale. **PR #543가 직접 해결**.

**Always 관점 (추가 보강)**:
- BG GPS 추적까지 활성화. 알람 발사 경로가 2개(BG GPS + Silent Push) → 신뢰성 더 높음.
- 단 "꺼지지 않고 계속"의 지속성은 iOS OS 정책 종속.

### Q2. "BG에서 알림 오게 코딩되어 있는가?"

**YES**. iOS Background Modes 선언 + BG location task + silent push task 모두 등록. WhileInUse 사용자도 silent push로 알림 수신 보장 설계. 알림 발사 자체는 `Notifications.scheduleNotificationAsync({trigger:null})`로 단일 출구.

### 실제 위험 지점

코드 자체가 아니라 **외부 의존성**에 의존하는 구간:
1. **Silent push delivery 신뢰성** (WhileInUse 다수 사용자에게 가장 중요) → 백엔드/APNs/OS budget — #506/#542 트랙
2. iOS BG location throttling (Always 사용자) → 옵션은 최대치, OS 정책 한계
3. 지하 구간 디바이스 네트워크 끊김 → silent push 수신 지연 (지연 후 한꺼번에 도착)

### 우선순위 순서 (다음 작업)

1. **PR #543** — FG 복귀 stale 해결 (✅ 머지 완료)
2. **#506/#542** — silent push delivery 진단/검증 (WhileInUse 사용자 1순위) ← **현재 작업 중**
3. **#493** — alert push fallback (silent push 강제종료 보완)
4. **#494** — Region monitoring (WhileInUse도 활용 가능한 OS 깨움)
5. **권한 상태 안내 UI** — "WhileInUse에서도 동작합니다" 명확히 안내

## 10. 실기기 진단 데이터 (2026-05-27 13:11) — #506 직접 분석

### 입수 데이터 (DebugModal export)
```
permission=granted
apnsToken=…35b3502c
activeTrip=…35b3502c        ← 토큰 일치 (등록 OK)
apnsEnv=sandbox             ← Debug build, sandbox APNs 토큰
taskRegistration=success    ← Notifications.registerTaskAsync OK
route=set
destination=2-011
currentStation=7-015 (용마산)
lastReceived=(never)        ← 🚨 silent push 한 번도 도달 안 함
lastFired=(never)
lastSkipped=(never)

Alarm log 87건 전체 source=fg (foreground GPS 발사만)
BG/silent push entry 0건
```

### 차단표 (가설 a~f 중 어디서 막혔는가)

| 원인 | 진단 근거 | 판정 |
|---|---|---|
| (a) `registerSilentPushTask` 실패 | `taskRegistration=success` | ❌ 제외 |
| (b) `getDevicePushTokenAsync` 실패 | `apnsToken=…35b3502c` 발급됨 | ❌ 제외 |
| (e) `Notifications.registerTaskAsync` 실패 | `taskRegistration=success` | ❌ 제외 |
| (f) 알림 권한 미동의 | `permission=granted` | ❌ 제외 |
| (b'') 토큰이 백엔드에 등록 안 됨 | `activeTrip=…35b3502c` (같은 토큰) | ❌ 제외 |
| (c1) 백엔드 cron이 trip 폴링 못 함 | 미확인 (wrangler tail 필요) | ⚠️ **유력** |
| (c2) Seoul API 응답 빈 → `etaMissing` | 미확인 | ⚠️ 가능 |
| (c3) Phase 미발사 (ETA > 240s + 큰 변화 없음) | 미확인 | ⚠️ 가능 |
| (d1) APNs sandbox 도달 실패 (BadDeviceToken 등) | 미확인 (wrangler tail 응답 코드 필요) | ⚠️ **유력** |
| (d2) self-heal로 production 시도했으나 양쪽 실패 | 미확인 | ⚠️ 가능 |
| **(g) iOS Background App Refresh OFF** | iOS Settings 확인 필요 | ⚠️ **매우 유력** |
| (h) iOS Low Power Mode로 silent push throttle | 미확인 | ⚠️ 가능 |
| (i) Trip이 KV에 미저장 (backend 등록 실패) | `wrangler kv:key get` 확인 필요 | ⚠️ 가능 |

### 가설 g — iOS Background App Refresh가 가장 의심
- iOS는 "Background App Refresh" 설정이 꺼져 있으면 **silent push를 앱에 전혀 전달하지 않음**. 시스템 차원 + 앱별 차원 두 단계 모두 ON이어야 함.
- 사용자는 배터리 절약 / 데이터 절약 목적으로 종종 OFF로 설정.
- 코드 차원에서 감지 불가 (iOS API 미노출).
- 확인 경로: iOS Settings → General → Background App Refresh (전역) → subway-now (개별) 모두 ON 여부.

### 가설 c/d — 백엔드/APNs 경로 격리 필요
- 현재 진단 도구로는 "백엔드가 silent push를 발사하려고 시도했는지" 알 수 없음.
- `wrangler tail`로 cron이 trip 폴링 → push 발사 시도 → APNs 응답을 봐야 c/d 격리됨.
- **하지만** wrangler tail은 cron 1분 간격이라 한번에 5분 정도 봐야 의미 있는 데이터 수집.

## 11. 오늘 fix 계획 — 직접 발사 진단 엔드포인트

진단을 wrangler tail에만 의존하면 시간이 오래 걸리고 cron/Seoul API/phase 로직 변수에 가려진다. **이를 격리하기 위해 backend에 즉시 발사 엔드포인트 추가**:

### 제안: `POST /diag/push`
- Input: `{ token, host?: 'sandbox' | 'production' }` (또는 token에서 trip 조회해 apnsEnv 사용)
- 동작: `sendSilentPush`를 cron/Seoul/phase 로직 우회하고 즉시 호출
- 응답: `{ ok, status, reason }` — APNs HTTP 응답 그대로 노출
- 보안: token 본인 검증(token을 입력으로 받으므로 본인만 가능)
- 측정용 payload: `{ nextWaypoint: 'DIAG', etaSeconds: 0, phase: 'imminent', kind: 'destination', sentAt: now }`

### 격리 효과
| 응답 | 해석 |
|---|---|
| `200` + 디바이스 수신 ✅ | 가설 c/d 제외 → 가설 g(BG App Refresh) 또는 h(Low Power) 의심 |
| `200` + 디바이스 미수신 | 가설 g 거의 확정 — APNs는 받았으나 iOS가 앱에 전달 안 함 |
| `400 BadDeviceToken` | 가설 d2 — 환경 불일치 또는 토큰 무효 |
| `403/410` | 토큰 expire / 앱 미설치 |
| `5xx` | APNs 측 문제 |
| 응답 자체 없음/timeout | 가설 d1 — APNs 도달 실패 |

### 클라 측 변경 (선택)
- DebugModal에 "진단 push 발사" 버튼 추가 → `/diag/push` 호출 → 응답 인라인 표시
- 또는 사용자가 직접 `curl`로 호출하게 노출

### 작업 단위
- 새 이슈: `chore(#506): 즉시 silent push 진단 엔드포인트`
- backend route + 단위 테스트
- (선택) 클라 DebugModal 진단 버튼

이렇게 오늘 fix → 사용자가 내일 trip 시작 전 진단 버튼 한 번 눌러봄 → 즉시 가설 격리 가능.

## 9. 관련 자료

### 메모리
- `feedback_location_permission_scope` — Always 전제 금지, 다수 WhileInUse 사용자
- `project_bg_alarm_no_always_roadmap` — 사전 예약 + Silent push로 Always 없이 동작
- `project_alarm_accuracy_roadmap` — alarmLog 측정 인프라
- `feedback_realtime_priority` — 나쁜 좌표 거부, grace period 도입 금지

### 이슈/PR
- #478 silent push 단독화 (Track B 단일 채널)
- #506 release 빌드 silent-push-* 0건 진단
- #527 GPS jump gate 도입
- #494 Geofence/Region monitoring (지하 보강)
- #542 BG silent push 실기기 검증
- #543 (현재) FG 복귀 stale 표시 — 본 분석의 직접 fix
- #447 GPS 신뢰 정책 재검토 (가설 C 후속)
- #411 사전 예약 stopgap 제거

### 코드
- `app.config.js` (UIBackgroundModes)
- `src/hooks/useBackgroundLocation.ts` (BG 시작/중단)
- `src/constants/locationTracking.ts` (BG 옵션)
- `src/tasks/backgroundLocationTask.ts` (BG GPS 콜백 처리)
- `src/tasks/silentPushTask.ts` (silent push 핸들러)
- `src/utils/silentPushLocationGate.ts` (위치 게이트)
- `src/hooks/useApnsTripRegistration.ts` (백엔드 trip 등록)
- `src/utils/notificationState.ts` (FIRED_ALARMS dedup)
- `src/hooks/useNearestStation.ts` (FG GPS + AppState 핸들러)
