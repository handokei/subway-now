# plan 2026-10-15 (v2) — 프롬프트/LA 결합 해소 (#2997)

> v1은 `/verify-plan`에서 **반증 10건**으로 착수 금지됐다(`*.v1-rejected.md` 보존). v2는 그 반증을 전부 반영해 다시 썼다.
> 선행 머지: **#2999**(`expiresAt` 전송 시점 기준, dev `7303719e`) — 그게 없으면 trip 등록 자체가 안 돼 이 plan이 무효다.

## 0. 목표 (사용자 요구, 2026-10-15 승인)

1. **LA 카드에서 상태를 보면서 탑승/미탑승을 선택**할 수 있다.
2. **일시정지 중에는 발사하지 않는다.**
3. boolean 리터럴로 정책을 호출부에 박지 않는다 — 사용자 행위를 넘기고 축 파생은 소유자 1곳.
4. push 배너는 임박 시점에만(소리 모드면 소리까지).

## 1. v1에서 반증된 것 (착수자는 v1을 믿지 말 것)

| # | v1의 틀린 주장 | 실제 | 근거 |
| --- | --- | --- | --- |
| 1 | *"`boardingPhase`를 채우면 버튼이 추가된다. Swift 변경 0"* | **카드가 `BoardingPromptView`로 교체**된다(배타 분기). 단 **역명은 그 뷰에도 있다** — 잃는 건 남은정거장/route뿐 | `SubwayLiveActivityWidget.swift:109-113`, `:226-262` |
| 2 | *"#2854가 막은 것은 배너이므로 content만 복원"* | #2854의 root는 **phase 필드 자체**이고 그걸 지키는 **기존 테스트 2개**가 있다 | `useLiveActivityPreBoardingLifecycle.test.ts:82`·`:95` |
| 3 | *"origin 경로에 반복 게이트 미적용 → R5 필요"* | **이미 적용돼 있다** → R5 **삭제** | `scheduled.ts:8142` |
| 4 | *"R3 1순위는 device"* | backend heartbeat(≤90s)가 content-state를 **통째로 교체**해 device가 쓴 `boardingPhase`를 지운다 | `scheduled.ts:209 LA_HEARTBEAT_INTERVAL_MS=90_000`, `liveActivity.ts:237-267` |
| 5 | (선언 없음) | **#2498 CLOSED** *"backend push가 유일한 저자"* + 확정 아키텍처 *"device=탭만"* | `liveActivityPushChannel.ts:375-378`, `decision_ARCHITECTURE_COMMITTED:85` |
| 6 | *"pause 억제는 R1의 속성으로 1곳"* | `infoModeEnabled`는 *"pause와 무관하게 절대 건드리지 않는다 — pause 중에도 매역 push 계속"*이 **명시 결정** | `HomeScreen.tsx:496`, `useNavigationStore.ts:25`·`:72` |
| 7 | *"OR 게이트 2곳"* | **3곳** — 하차(hop-end) 누락 | `scheduled.ts:8043`·`8454`·**`8761`** |
| 8 | *"리터럴 11곳"* | 최소 **15곳** — `setBoardingCommitted`·`setAllowSpeaker` 누락 | `useBoardingPromptResponder.ts:826`, `useUserIntentStore.ts:206`, `SettingsScreen.tsx:148`·`:151` |
| 9 | *"모든 시나리오"* | iOS 16.x는 버튼 미표시(`@available(iOS 17.0,*)`), Android는 훅 자체가 early-return | `SubwayLiveActivityWidget.swift:270`, `useLiveActivityPreBoardingLifecycle.ts:133` |
| 10 | *"device 플래그만으로 pause 억제"* | backend `Trip`에 pause 필드 **0건** — `promptOptIn` forward가 유일 신호 | `backend/.../types.ts` 전수 |

## 2. 확정된 사실 (v2 기준 — 전부 코드 인용)

### 2-1. LA 카드 분기 (반증 1의 정확한 범위)

`SubwayLiveActivityWidget.swift:105-113`:
```swift
var isBoardingPrompt: Bool { state.boardingPhase == "pre-boarding" || state.boardingPhase == "hop-end" }
var body: some View {
    if isBoardingPrompt { BoardingPromptView(state: state, phase: state.boardingPhase ?? "") }
    else if isUrgent { ... } else { ...정상 추적 뷰... }
}
```

`BoardingPromptView`(`:226-262`)가 **이미 보여주는 것**:
```swift
Text(state.boardingPromptOriginStation ?? state.stationName)   // 역명 ✅
Text(questionKey)                                               // 질문 / "추적중"(autoLocked)
BoardingPromptButton(state:phase:autoLockedTracking:)           // 탑승/미탑승 버튼 ✅
```

**유일한 손실**: 남은 정거장 / 목적지 route(정상 뷰의 `LockScreenRouteView:347`).
→ 그 데이터는 **이미 ContentState에 있고 backend가 이미 보낸다**(`SubwayActivityAttributes.swift:18-19` `destinationName`/`stopsRemaining`). **표시만 추가**하면 된다.

### 2-2. 버튼 → backend lock 사슬은 완결 (앱 꺼져 있어도)

`BoardingIntents.swift`: `:50` `ALARM_BACKEND_URL_BASE`, `:85` `POST /trips/{token}/boarding-confirm`, `:91-111` `URLSession.shared.data(for:)`, `:104-106` `trainCode` optional(#2962), `:216` `await postBoardingConfirm(...)`.
doc `:52-54`: *"앱을 열지 않고(BG) backend에 직접 전달 — **앱이 완전히 정지된 상태에서도 leg 락 체인이 완결되도록 하는 주 경로**(#2527 FG-gap 제거)"*.
수신: `index.ts:2211 POST /trips/:token/boarding-confirm` — **promptOptIn/infoModeEnabled 게이트 없음**, `:2248-2249`가 오히려 `infoModeEnabled = true`를 stamp.

→ **버튼만 노출되면 lock이 생기고 그 뒤 사슬이 열린다. OR 게이트 완화 불필요.**

### 2-3. 배너 무음 보장 (구조적)

`LiveActivityManager.swift:155-178 resolveAlertConfiguration`:
```swift
guard let phase = state.boardingPhase, phase == "pre-boarding" || phase == "hop-end" else { return nil }
if phase == "pre-boarding" && state.boardingAutoLocked == true { return nil }
guard let title = state.boardingAlertTitle, let body = state.boardingAlertBody else { return nil }  // ← 여기
guard lastAlertedBoardingPhase != phase else { return nil }
```
→ **`boardingAlertTitle`/`Body`를 보내지 않으면 alert = nil → 무음 content 교체.** 배너는 프롬프트 발사(`scheduled.ts:7975`)에서만 그 필드를 채운다.
`alert`는 `contentState`와 **별개 파라미터**(`liveActivity.ts:256-262`) — content에 boarding 필드를 넣어도 배너가 붙지 않는다.

### 2-4. backend가 LA content의 단일 저자 (반증 4·5)

`scheduled.ts:6339 maybeFireLiveActivityUpdate` → `:6384 buildLiveActivityContentState` → `:6392 fireLiveActivityUpdate` → `liveActivity.ts:237-267`이 contentState를 통째로 APNs `content-state`로 전송(ActivityKit = 전체 교체). heartbeat `:209 = 90_000ms`. 실측 `{"sent":13,"failed":0}`/시간.
`buildLiveActivityContentState`(`liveActivity.ts:179-186`)는 `stationName`/`lineName`/`lineColorHex`/`etaMinutes`/`destinationName`/`stopsRemaining` 등을 보내고 **boarding* 필드는 0건**(전수 grep: `boardingPhase`는 `scheduled.ts:7971` 단 1곳).
device 소비자는 `shouldSkipDeviceLiveActivityWrite`(`liveActivityPushChannel.ts:375-378`)로 억제 — **#2498 "backend push 단독 저자"**.

### 2-5. pause 억제의 유일 신호 (반증 6·10)

backend `Trip`에 pause 필드 **0건**. 억제는 `promptOptIn=false` forward(`useApnsTripRegistration.ts:114`, `alarmBackend.ts:426`) → OR 게이트(`:8043`/`:8454`/`:8761`)에서 차단.
**단 `infoModeEnabled===true`면 pause 중에도 통과한다** — `HomeScreen.tsx:496`의 명시 결정(*"이미 lock급 정확도가 확립된 trip은 pause 중에도 매역 push를 계속 받는다"*).

## 2-6. 설계 원칙 — **사용자가 알 수 있도록** (2026-10-15 사용자 지시)

채널을 고를 때 기준은 "기능이 있다"가 아니라 **"사용자가 알 수 있고, 우리가 그것을 확인할 수 있는가"**다.

| 요구 | 판정 기준 |
| --- | --- |
| 사용자가 **현재 상태를 안다** | 잠금화면(LA)에 상주 표시 — FG 전용 UI는 BG/잠금에서 보이지 않는다(`PausedNavigationBadge`가 그 한계) |
| 사용자가 **결정할 수 있다** | 질문 + 액션이 **같은 표면**에 있다(LA 카드) — 앱을 열어야 하면 결정 기회를 잃는다 |
| 우리가 **도달을 확인한다** | 도달이 **측정되는 채널만** 쓴다 — LA push `laPushDelivery` ✅ / 로컬 알림 ❌(#2822 유령, `displayed=0`) |
| 우리가 **응답을 확인한다** | 응답이 **backend에 도달**하는 경로만 쓴다 — LA 버튼 직접 POST ✅ / 알림 액션 JS 처리 ❌(#2734 관측 0건) |

이 원칙이 S4-c의 채널 선택(로컬 알림 폐기 → LA alert + LA 버튼)과 S1의 소유자 선택(backend 단독 저자)을 모두 결정한다.

## 3. 해결 방안 (확정)

### S1 — backend가 boarding content를 상시 산출 【backend only】

`buildLiveActivityContentState`가 **trip 상태에서 파생**해 모든 heartbeat에 포함:

| 필드 | 값 |
| --- | --- |
| `boardingPhase` | lock 없음 + anchor 있음(`promptDisplay` 또는 `currentLegAnchor`) → `'pre-boarding'` / hop-end 대상 → `'hop-end'` / 그 외 → **미설정**(정상 추적 뷰 유지) |
| `boardingPromptTripToken` / `OriginStation` / `Line` | 그 anchor에서 파생 |
| `trainCode` | lock 있으면 `boardingLock.trainCode` |
| `boardingAutoLocked` | lock 있고 `boardingEvidence===true` → `true`(→ [탑승] 숨고 [아니에요]만) |
| **`boardingAlertTitle`/`Body`** | **채우지 않는다** → 무음(2-3) |

- device(`useLiveActivityPreBoardingLifecycle`) **무변경** → #2854 테스트 2개 **무회귀**(그 테스트는 device hook 산출물만 assert).
- #2498 "backend 단독 저자" **준수**.
- 하차(hop-end) 축 포함 — 반증 7 반영.

### S2 — `BoardingPromptView`에 남은 정거장 표시 추가 【Swift, 작음】

`:226-262`에 `stopsRemaining`/`destinationName` 표시 추가 → **상태 + 질문 + 버튼이 한 카드에**. 데이터는 이미 ContentState에 있고 backend가 이미 보낸다(2-1).
- iOS 16.x: 버튼은 `@available(iOS 17.0,*)`로 여전히 미표시(반증 9) — 텍스트/상태는 보인다. **"모든 iOS에서 버튼"은 주장하지 않는다.**
- Android: LA 자체가 iOS 전용. **범위 밖 명시.**

### S3 — 행위 기반 API 【device】

boolean 리터럴 **15곳**(반증 8)을 사용자 행위로 대체. 축 파생을 소유자 1곳으로.
- `setBoardingCommitted`는 `useUserIntentStore.ts:74-77` 주석대로 *"'탑승했지만 열차 미확정'과 '정보용 안내 시작'을 backend가 구분하는 **유일한 채널**"* — 반드시 교차 검토.
- **OR 게이트는 건드리지 않는다**(2-5 — 완화하면 pause 억제가 사라진다).

### S4 — 일시정지 = 억제가 아니라 **상태 표시 + 사용자 결정** 【사용자 설계, 2026-10-15 확정】

v2 초안의 S4(*"pause 중 `boardingPhase` 미세팅 = 버튼 미노출"*)는 **폐기**한다 — 사용자 설계와 반대였다.

사용자 요구(원문): *"일시정지일 때는 그 역을 계속 표시하고 있으면 되는 것 같은데, 지상이면 지상 GPS로 해당 역 쪽 멀면 멀어서 안 보인다 이거고, 계속된다 하면 종료할까요/안내 마치냐 이런 느낌"* + *"그 결정이 그 이후에 **이동이 없으면**이야. 근데 **그 멘트는 내가 결정해야 하는 거고**, 결정할 수 있도록 **LA 알림 있어야 함**"*.

| | 내용 | 임계 | 신규 상수 |
| --- | --- | --- | --- |
| **S4-a** | 일시정지 중에도 LA가 **그 역을 계속 표시**하고 "일시정지 중"임을 드러낸다 | — | 0 |
| **S4-b** | GPS 판독이 **있고**(지상) 그 역에서 **500m 초과**면 *"멀어서 추적 안 됨"*을 표시. 판독 없으면(지하) **거리 판정 안 함** | `BOARDING_PROXIMITY_THRESHOLD_M = 500` 재사용 | 0 |
| **S4-c** | **15분 경과 + 이동 없음**이면 **LA 알림(배너)**으로 *"안내를 종료할까요?"*. **자동 종료하지 않는다 — 사용자가 결정한다.** | `PAUSE_AUTO_END_MS = 15*60_000` + 정지 판정 | 0 |

#### 왜 500m인가 (새 숫자가 아니다)

`boardingLock.ts:35 BOARDING_PROXIMITY_THRESHOLD_M = 500`, 정의 주석(#758):
> *"탑승역 근접 게이트 임계값. BoardingTrainList를 노출할 GPS 거리 한계. 정당화: 서울 지하철 역사 출구의 일반적인 도보 반경(~300m) + GPS 도심 정확도 여유(~200m). 사용자가 역에서 멀리 떨어진 곳에서 list만 미리 보고 잘못 탭하는 케이스 차단 — **거리 게이트는 fusion 신호와 무관(미터 단위)이므로 지하/지상 신호 변동에 영향받지 않음**."*

의미가 S4-b와 동일한 축("이 거리 안이면 탑승 가능")이고, 마지막 문장이 사용자의 *"지상이면 지상 GPS로"* 조건과 정합한다 — 지하는 판독이 없어 거리 판정을 하지 않는다(#2651 fail-open과 동일 원리).
`LOCK_GPS_DRIFT_THRESHOLD_M = 1000`(`realtime.ts:195`)은 **GPS drift 이상치 판정**용이라 의미가 다르다 — 쓰지 않는다.

#### 🔴 종료 채널 — 로컬 알림 재사용은 **금지**(유령 채널). LA alert + LA 버튼으로 간다

초안은 `ALARM_ACTION_END_TRIP`(`notificationCategory.ts:52`, #2428)을 **그대로 재사용**하려 했다. **사용자 지적으로 폐기한다**: *"이미 있는 건데 **유령 알림**이었고 **사용자가 왔는지 알 수 없는** 알림들이었어."*

덤프가 그걸 증명한다 — **채널별로 도달 관측 가능성이 다르다**:
```
laPushDelivery = 100% (117/117)                            ← LA push: 도달이 측정된다
Boarding Prompt Acceptance: displayed=0 responded=0 responseRate=—   ← 로컬 알림: 왔는지 알 수 없다
```
그리고 **#2822 CLOSED** — *"로컬 추적/폴백 알림이 payload(kind)·sound 없이 발사돼 '유령'(무음+kind=unknown) — **device 인식 불가**"*. `ALARM_CATEGORY`는 로컬 알림(`scheduleNotificationAsync`) 채널이고 그 계열이다.

| | 폐기 | 채택 |
| --- | --- | --- |
| 질문 전달 | `ALARM_CATEGORY` 로컬 알림 | **LA alert**(backend push) — `laPushDelivery`로 **도달 측정** |
| 응답 수집 | 알림 액션 → JS 처리(BG 유실 가능, #2734 FG-gap) | **LA 버튼** → `BoardingIntents` 패턴으로 backend **직접 POST** → backend가 **탭을 관측** |

→ *"왔는지 알 수 없다"*와 *"눌렀는지 알 수 없다"* 가 **둘 다 LA 채널에서 해소**된다.

**신규 1건**: `EndTripIntent`(LA 버튼용). 기존 4개(`BoardingConfirmIntent`/`NotBoardedIntent`/`DisembarkConfirmIntent`/`DisembarkNotYetIntent`)와 **같은 패턴** — `openAppWhenRun: false` + backend 직접 POST. `ALARM_ACTION_END_TRIP`의 **처리 로직**(`useAlarmEndTripResponder.ts`, `tripEndedCleanupSequence.ts:88`)은 **재사용**하고 **진입 채널만** LA로 바꾼다.

#### `AlertConfiguration`은 Critical Alerts가 아니다 (엔타이틀먼트 불필요)

| | ActivityKit `AlertConfiguration` | Critical Alerts |
| --- | --- | --- |
| 용도 | LA 업데이트를 눈에 띄게(배너+소리) | 긴급(의료·안전) — 무음/방해금지 **관통** |
| 엔타이틀먼트 | **불필요** | 애플 승인 필요 |
| 소리 | 우리 코드 `sound: .default`(`LiveActivityManager.swift:176`) | `.defaultCritical` |

**#2807**(CLOSED) — *"Critical Alerts **애플 거부** 후 무음 관통 불가 명시"*. 그 거부는 **취침모드 무음 관통** 건이고 이 plan과 무관하다. 우리가 쓰는 것은 `.default`이므로 **같은 거부 리스크가 없다**. 무음 모드면 조용히 배너만, 소리 모드면 소리까지 — 사용자 요구(*"소리 모드에서는 소리까지"*)와 일치.
(`stationNotification.ts:443 allowCriticalAlerts: true`는 **권한 요청 옵션**일 뿐이고 엔타이틀먼트가 없으면 iOS가 그 권한을 주지 않는다 — #2807 결론과 정합, 무해.)

#### 정지 판정도 기존 자산

`arrivalDetect.ts:17 STATIONARY_THRESHOLD_MS = 60_000`, `:35 STATIONARY_TRIP_END_THRESHOLD_MS = 5*60_000`, 소비자 `destinationArrivalDetect.ts:82`. 덤프에도 `movement-static-position`/`movement-static-speed` suppress reason이 실재한다. **새 판정 로직 금지** — 이 중 하나를 재사용한다(어느 것인지는 착수 시 확정).

#### 기존 결정과의 충돌 (선언 필수)

| 결정 | 무엇이 바뀌는가 |
| --- | --- |
| **#2293**(CLOSED) — `PausedNavigationBadge.tsx:12` *"PAUSE_AUTO_END_MS 경과 시 1회 호출. **확인 다이얼로그 없이 즉시 종료**"*, `HomeScreen.tsx:511` 동일 | **자동 종료를 사용자 결정으로 바꾼다.** 단 #2293이 거부한 것은 **FG 모달 다이얼로그**이고 S4-c는 **LA/알림 채널**이다 — 채널이 달라 양립 가능. 그리고 조건에 **이동 없음**을 추가해 이동 중 종료 제안을 막는다 |
| **#2675**(CLOSED) — *"자динамic trip 종료가 아무 알림 없이 조용히 일어난다(유령 종료) — 도착 안내도 종료 알림도 없음"* | **같은 방향**이다. 실제로 `notifyTripEnded`는 `reason:'arrived'`(`HomeScreen.tsx:469`·`:1036`)와 `useDeviceSelfEnd:215`에서만 호출되고 **pause 자동종료 경로(`:515 handleStopNavigation`)에서는 호출되지 않는다**(확인). S4-c가 #2675의 미완 부분을 잇는다 |
| `HomeScreen.tsx:496` — *"`infoModeEnabled`는 pause와 무관하게 절대 건드리지 않는다 — 이미 lock급 정확도가 확립된 trip은 pause 중에도 매역 push를 계속 받는다"* | **유지한다.** S4는 프롬프트/배너/LA 표시만 다루고 매역 push 정책은 건드리지 않는다 → v2 §6의 승인 요청은 **해소**(사용자가 "일시정지 중 표시 유지"를 택했으므로 억제 자체가 없다) |

### ~~S5~~ — 삭제. origin 경로에 반복 게이트가 **이미 있다**(`scheduled.ts:8142`, 반증 3).

### S6 — 관측
"trip 등록됐는데 N분간 가시 산출물 0건"을 `trip_events`에 적재. 오늘 이 상태가 무신호라 사용자 신고로만 발견됐다.

## 4. Acceptance (전부 revert-red 가능하게)

| # | 항목 | revert-red 대상 |
| --- | --- | --- |
| 1 | lock 없는 trip의 heartbeat content에 `boardingPhase='pre-boarding'` + 버튼 컨텍스트 4필드 포함 | S1 파생 제거 |
| 2 | 그 content에 `boardingAlertTitle`/`Body`가 **없다**(무음 보장) | S1이 alert를 채우면 red |
| 3 | lock + `boardingEvidence` → `boardingAutoLocked=true` | S1 분기 제거 |
| 4 | hop-end 대상 → `boardingPhase='hop-end'` | 반증 7 축 |
| 5 | pause(`promptOptIn=false`) → `boardingPhase` 미설정 | S4 조건 제거 |
| 6 | `BoardingPromptView`가 `stopsRemaining`을 렌더 | S2 revert |
| 7 | 리터럴 15곳 → 행위 API, `boardingCommitted` 의미 보존 | S3 |
| 8 | **#2854 무회귀** — device hook은 `boardingPhase` 미설정 유지(`test:82`·`:95` green) | device를 건드리면 red |
| 9 | **#2498 무회귀** — device LA write 억제 유지 | |
| 10 | **#2651/#2532 무회귀** — 거리/정지 차단 유지, 지하 fail-open 유지 | |
| **10-R** | **revert-red는 레이어별로 분리한다**(§12 반증 ①) — S1·S3·S4-a/b·S4-c의 backend 절반은 **revert-red 필수**. **S2와 S4-c의 Swift 절반은 Swift 테스트 타깃이 없어 원리적으로 불가** → **실기기 검증으로 대체하고 PR에 그 사실을 명시한다.** "Swift도 테스트했다"고 쓰지 않는다 | |
| 11 | **#2801/#2939 무회귀** — 배너는 임박에만, lock 활성 leg 재질문 0 | |
| 12 | device 11097 / backend 4009 무회귀, coverage 100% | |

## 5. 영향 범위

- **backend**: `liveActivity.ts`(S1), `scheduled.ts`(S4 조건·S6)
- **Swift**: `SubwayLiveActivityWidget.swift`(S2) — **실기기 검증 필수**
- **device JS**: `HomeScreen.tsx`/`useUserIntentStore.ts`/`useNavigationStore.ts`/`SettingsScreen.tsx`/`useBoardingPromptResponder.ts`(S3)
- **device LA 훅**: **무변경**(#2854·#2498 준수)

## 6. 사용자 승인 — **완료** (2026-10-15)

v2 초안의 미결(일시정지 해석)은 사용자가 **S4-a/b/c로 직접 설계**해 해소됐다. 억제가 아니라 **상태 표시 + 사용자 결정**이며, `HomeScreen.tsx:496`의 매역 push 정책은 **건드리지 않는다**.

## 7. 미확인 (착수 시 `추정` 라벨)

- **LA 버튼 경로 프로덕션 실행 이력 0건** — #2734 *"덤프 20개에 LA 버튼 사용 흔적 0건"*. 코드 완결성은 2-2로 확인했으나 **실행 관측이 없다.** S1이 버튼을 처음 노출시키므로 이 plan의 결과가 **최초 관측**이 된다 → 실기기 1회 + S6으로만 확정. "코드 green = 동작"으로 보고하지 않는다.
- **#2782(OPEN)** — 같은 증상(*"용마산 탑승했는데 LA에 탑승여부 없음"*, 9/21)이고 기전 서술은 #2854 이후 stale. 이 plan이 #2782도 닫을 것으로 보이나 그 이슈의 `tripOrigin` 축이 S1 파생과 완전히 무관한지는 미확인.


## 12. `/verify-plan` v2 자체 검증 (메인 직접, 2026-10-15)

> 위임 에이전트가 **유휴 알림만 3회** 보내고 결과를 전달하지 않았다(스킬이 문서화한 실패 모드). 메인이 직접 수행.

### 확인 (근거 file:line)

- **[A] S4-b 성립** — backend가 거리 판정 데이터를 갖는다. `types.ts:805 PositionPoint { lat, lng, accuracy, ts, motion }`, `/position`(`index.ts:1893`)이 `appendPositionPoint(c.env.TRIPS, token, point)`로 KV 적재. 덤프 실측 `/position 200 × 32`. `accuracy` 유무로 "GPS 판독 있음"도 판정 가능.
- **[B] S4-c 정지 판정 성립** — 같은 타입 `:815 motion: 'stationary' | 'walking' | 'automotive' | 'unknown'`. 덤프 `accelPattern: stationary 4%(1)`. **새 신호 수집 0.**
- **[C-1] `trainCode` nil로 [탑승] 탭해도 처리된다** — `index.ts:2303-2306`은 `payload.trainCode !== undefined`일 때만 body 경로를 타고, nil이면 `null` → `attemptBoardingAnchorResolution`(live resolve, `:2360`)으로 fallback. **lock 없고 프롬프트 미발사 상태에서도 버튼 탭이 유효하다.**
- **[D] 무충돌** — `cross-trip-mirror-skip`(덤프 23회)은 **device** 경로다(`silentPushTask.ts:1078 logCrossTripMirrorSkip('mismatch')`). S1은 backend LA content 산출이라 교차하지 않는다.
- **[#4] Swift 미커버 선언** — `SubwayLiveActivityWidget.swift` **0 hit**. `BoardingIntents.swift`/`LiveActivityManager.swift` 각 1 hit(착수 시 판정).

### 🔴 반증 ① [검사 #10] — Swift 변경은 revert-red가 **원리적으로 불가**

Swift 테스트 타깃이 **없다**: `.xctestplan` 0건, `*Tests` 디렉토리 0건, `ios/`는 Expo 생성 프로젝트(`project.pbxproj`/`Pods`)뿐. CI의 `Swift MIRROR Sync Check`는 두 `SubwayActivityAttributes.swift` 사본의 **동기만** 보고 거동은 보지 않는다.

→ Acceptance #10(*"S1~S6 각각 revert-red"*)은 **달성 불가 항목을 포함**한다. 레이어별로 분리해야 한다:

| 작업 | revert-red | 검증 수단 |
| --- | --- | --- |
| S1(backend content 파생) | ✅ 가능 | backend vitest |
| S3(device JS 행위 API) | ✅ 가능 | device jest |
| S4-a/b(backend 파생 조건) | ✅ 가능 | backend vitest |
| S4-c **backend 절반**(alert 발사 조건) | ✅ 가능 | backend vitest |
| **S2**(Swift 표시 추가) | ❌ **불가** | **실기기만** |
| **S4-c Swift 절반**(`EndTripIntent` + 버튼) | ❌ **불가** | **실기기만** |

처분: Acceptance #10을 *"backend/device JS 항목은 revert-red 필수 / Swift 항목은 실기기 검증으로 대체하고 그 사실을 PR에 명시"*로 재작성한다. **"Swift도 테스트했다"고 쓰지 않는다.**

### 🔴 설계 결정 미결 [C-2] — 질문 뷰가 기본이 되는가

`boardingPhase`를 상시 파생하면 `SubwayLiveActivityWidget.swift:109-113`의 배타 분기로 **`BoardingPromptView`가 상시 노출**되고 정상 추적 뷰(역·남은정거장·route)가 사라진다. S2가 남은 정거장 표시를 추가해 보완하지만, 그것은 *"질문 뷰가 사실상 기본 화면이 된다"*는 뜻이다.

사용자 요구는 *"일시정지일 때는 **그 역을 계속 표시**"* 였으므로 질문이 화면을 점령하면 그 요구와 어긋날 수 있다. **두 갈래 — 사용자 결정 필요**:

| | 방식 | Swift 변경 | 결과 |
| --- | --- | --- | --- |
| **(가)** | 질문 뷰를 기본으로(현 배타 분기 유지 + S2로 정보 보강) | 작음 | "탑승하셨나요? + 버튼 + 남은정거장"이 기본 화면. lock 생기면 `boardingAutoLocked`로 "추적중 + [아니에요]" |
| **(나)** | 배타 분기를 깨고 **정상 뷰에 버튼 행만 추가** | 중간 | 화면은 "역·남은정거장" 중심 유지, 버튼은 보조 |

**사용자 결정(2026-10-15): (나) 확정** — *"상태가 주, 버튼은 보조"*.

```
┌──────────────────────────┐
│ 용마산 [7]                │
│ 뚝섬까지 5정거장 · 환승 건대입구 │
│ ──────────────────────── │
│ 탑승하셨나요? [탑승][아니에요]  │
└──────────────────────────┘
```

→ **S2 재정의**: `BoardingPromptView`에 정보를 더하는 것이 아니라, **`isBoardingPrompt` 배타 분기(`:109-113`)를 깨고 정상 추적 뷰 하단에 버튼 행을 붙인다.** 정상 뷰(역·남은정거장·route)가 **주**이고 질문+버튼이 **보조**다.
- `BoardingPromptView`는 **hop-end(하차) 전용으로 남기거나** 제거 — 착수 시 판정(하차는 질문이 주여야 할 수 있다).
- Swift 변경 규모가 (가)보다 크다. **revert-red 불가(§12 반증 ①)이므로 실기기 검증이 유일한 수단**이다.

## 13. 처분

- **반증 1건**(검사 #10) → Acceptance #10 재작성 필요. **착수 전 수정 대상.**
- **미결 1건**(C-2 가/나) → **사용자 결정 필요.** 이것이 Swift 변경 범위를 결정하므로 추측으로 진행하지 않는다.
- 나머지 A·B·C-1·D는 확인 완료 — S4-b/c가 새 신호 수집 없이 성립한다.


## 14. A+C 확정 (사용자 승인 2026-10-15) + PR 분할

### A — Swift는 실기기 검증
Swift 테스트 인프라가 없다(§12 반증 ① — `TARGET_REGISTRY` 44종에 test 0종, `.xctestplan`/`*Tests*.swift`/`import XCTest` 전부 0건, `ios/`는 gitignore 생성물). PR 본문에 **"Swift는 자동 테스트 없음 — 실기기 검증"**을 명시한다.

### C — Swift 로직 최소화 (판정은 backend)
Swift에 **조건 분기를 추가하지 않는다.** 모든 판정(`boardingPhase` 유무, `boardingAutoLocked`, 거리/정지 문구)은 **backend가 content로 결정**하고 Swift는 **받은 대로 그린다**. 그러면:
- Swift 변경 = "배타 분기 제거 + 버튼 행 위치" (레이아웃만)
- **판정 로직 100%가 backend 테스트로 덮인다** → revert-red 가능 범위 최대화

### PR 분할 (결함1=PR1 룰)

| PR | 내용 | 레이어 | revert-red |
| --- | --- | --- | --- |
| **1** | **S1** — backend가 boarding content 상시 산출(`boardingPhase`/버튼 컨텍스트/`boardingAutoLocked`, alert 필드 **제외**) | backend only | ✅ 전부 |
| 2 | **S2** — Swift 배타 분기 제거 + 정상 뷰에 버튼 행 | Swift | ❌ 실기기 |
| 3 | **S4** — pause 상태 표시(a) + 거리 문구(b) + 15분·정지 종료 질문(c, backend 절반) | backend + Swift | 부분 |
| 4 | **S3** — boolean 리터럴 15곳 → 행위 API | device JS | ✅ |
| 5 | **S6** — "가시 산출물 0건" 관측 | backend | ✅ |

**PR 1이 단독으로 가치가 있다**: backend가 `boardingPhase`를 싣기 시작하면 **현재 Swift로도 버튼이 뜬다**(`:289 else if phase == "pre-boarding"`). 카드가 질문 뷰로 교체되는 것은 PR 2가 고치지만, **그 전에도 사용자가 LA에서 탑승을 확정할 수 있다** — 오늘 불만의 핵심이 그것이다.
