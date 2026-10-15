# plan 2026-10-15 — 프롬프트/LA 결합 해소 (#2997)

> 사용자 승인 완료(2026-10-15). 착수 전 `/verify-plan` 적대 검증 대상.

## 0. 한 줄

사용자가 **역을 탭해 목적지만 설정한 상태**에서 탑승 프롬프트도, LA 탑승 표시도 **둘 다 영구 침묵**한다. 원인은 독립 축이 하나의 트리거/경로에 묶인 것이고, LA에는 **이미 탑승/미탑승 버튼이 구현돼 있는데** 그 렌더 조건(`boardingPhase`)이 프롬프트 발사 경로에만 채워진다.

## 1. 실측 (2026-10-15, 배포 `04:01:55Z` + 앱 재설치)

```
trip:e25e1158…  createdAt 05:04:15Z
route        : transfer 7→2 건대입구,  waypoints 중곡→군자(능동)→어린이대공원(세종대)→건대입구[transfer]→성수→뚝섬[dest]
promptDisplay: { originStation: "용마산", line: "7" }
boardingLock : none      currentLegAnchor: none
promptOptIn  : undefined     infoModeEnabled: undefined
activityState: "live"        activityPushToken: 160자
```

- backend 정상: `cron:has-active-trips=1`, 경로 5역 매 tick `selfPoll`, LA push `{"sent":13,"failed":0}`, `backend_errors` 0, `push_failures` 0
- 사용자 증언: *"탑승했는지에 대한 알림조차 안 오고, LA에도 탑승 관련으로 나온 게 아무것도 없다(LA 카드 자체는 있다)"*

## 2. 확정된 사실 (file:line — 전부 코드 인용으로 확인)

### 2-1. 프롬프트 차단 지점

origin(leg-1) 경로 `scheduled.ts:8020 maybeFireOriginBoardingPromptGpsFree`:

```ts
if (trip.currentLegAnchor) return;   // leg-1 전용 — 이 트립 통과
if (!display) return;                 // promptDisplay 있음 — 통과
if (trip.promptOptIn !== true && trip.infoModeEnabled !== true) return;   // :8043 ← 차단
if (trip.boardingLock !== undefined) return;
```

leg-2 경로 `scheduled.ts:8441 maybeFireLegBoardingPrompt`도 동일 OR 게이트(+`legBoardingPromptSkippedNoOptIn` 집계).

### 2-2. 게이트 **순서** — #2651 fix는 OR 게이트보다 뒤

```
:8043   OR optin 게이트
:8113   isTooFarFromOrigin = hasProximityReading && !isNearOrigin(...) && !anchorFresh
:8115   if (isTooFarFromOrigin) return;      ← #2651의 거리/정지 fix
```

→ **OR 게이트만 완화해도 #2651 보호는 유지된다**(서로 다른 축: opt-in vs 거리).
→ `isTooFarFromOrigin`은 `hasProximityReading`을 전제로 하므로 **지하(판독 없음)에서는 fail-open** — 이는 #2651 본문의 명시 요구(*"지하에서 GPS가 죽었을 때는 게이트 없이 발사돼야 한다(#2532 취지 유지)"*).

### 2-3. device 토글이 축 3개를 손으로 묶음

`HomeScreen.tsx:478` / `:499`:

```ts
handleStartNavigation: startNavigation(); setPromptOptIn(true);  clearNavigationPausedAt();
handleStopNavigation : stopNavigation();  setPromptOptIn(false); setNavigationPausedAt();
```

- `navigationActive` → BG GPS (`useBackgroundLocation.ts:61`가 deps로 사용)
- `promptOptIn` → 프롬프트 게이트 입력
- `pausedAt` → `PAUSE_AUTO_END_MS`(15분) 자동 종료

boolean 리터럴 호출부 **실측 11곳**: `useBoardingLockController.ts:451`, `useBoardingIntentPromotion.ts:39`, `useBoardingPromptResponder.ts:294`, `useUserIntentStore.ts:196`·`:217`, `HomeScreen.tsx:481`·`:501`·`:2085`·`:2087`, `SettingsScreen.tsx:114`·`:116`.

프롬프트 수신만 끄는 사용자 설정은 **없다**(`src/features/settings` 전수 0건).

### 2-4. LA 탑승 content 생산자 전수 3개 — lock·optin 없는 트립은 전부 배제

| 생산자 | 결과 |
| --- | --- |
| device 평상시 pre-boarding (`useLiveActivityPreBoardingLifecycle.ts:14-17`·`:73`) | `boardingPhase` **미세팅** — #2854가 "유령 배너" 회귀 때문에 의도적으로 내려놓고 backend에 위임 |
| device auto-lock 직후 (`:97-111`, 호출 조건 `:147` `lock.boardingEvidence === true && tripOrigin`) | `boardingPhase` 세팅하나 **lock 필수** |
| backend `scheduled.ts:7971`·`:7974` (enclosing `:7670 fireBoardingPromptForAnchor`) | **OR 게이트에 막힘** |

`stationNotification.ts:564-580`에 `phase → boardingPhase` forward 매핑이 존재하나 `phase` 입력이 없으면 전달하지 않는다.

### 2-5. LA 버튼은 **이미 구현돼 있다** (이 plan의 핵심 레버)

`SubwayLiveActivityWidget.swift`:
- `:261` `BoardingPromptButton(state:phase:autoLockedTracking:)`
- `:289` **`} else if phase == "pre-boarding" {`** → `BoardingConfirmIntent`(탑승) + `NotBoardedIntent`(미탑승)
- `:277-287` `autoLockedTracking == true`면 **[탑승] 버튼을 빼고 [아니에요]만** 노출(#2528) — 재질문 방지가 이미 설계됨

`BoardingIntents.swift:207 BoardingConfirmIntent.perform()`:
```swift
await markCurrentActivity(boardingPhase: PHASE_BOARDED)
writePendingBoardingIntent(action: ACTION_BOARDING_BOARDED, tripToken: ..., trainCode: ...)
```
`trainCode`는 `@Parameter`로 **버튼 생성 시점 값을 캡처**(#2962 주석) — "LA가 들고 있던 그 열차를 그대로 보낸다".

→ **`boardingPhase`를 채우기만 하면 탑승/미탑승 버튼이 렌더되고 lock 사슬이 열린다. Swift 변경 0.**

### 2-6. 반복 억제 primitive는 이미 존재 (신규 설계 금지)

`boardingPrompt.ts`: `:109 MAX_FIRE_COUNT = 3`, `:258 MIN_FIRE_INTERVAL_MS`(5분), `:31 DISMISS_SILENCE_MS`(5분), `:249 silencedUntil`.
`evaluateBoardingPromptRepeatGate`는 **현재 leg-2 경로만** 사용. origin 경로 미적용.

## 3. 철회된 주장 (착수자 주의 — 내가 검증 전에 단정해 틀린 것)

1. ~~"LA boarding 필드는 backend만 채운다"~~ → device에도 생산자 존재(2-4)
2. ~~"origin은 arvlCd 임박 게이트가 없다 → leg-2 고질병의 키"~~ → **공유 본체** `fireBoardingPromptForAnchor`를 둘 다 호출(`:8202` origin / `:8570` leg-2)하고 **둘 다 `onSuppressedNotImminent`를 넘긴다**. 임박 게이트는 공통. 키 아님
3. ~~"S1 활성화는 #2651 구멍 재개방"~~ → 게이트 순서상 다른 축(2-2)
4. ~~"위치 근접 확증이 leg-2에 없는 게 중요하다"~~ → 지하 fail-open이라 사실상 무효이고 그게 #2651 설계 의도

공통 실패 패턴: **"유일/없음/전수"를 전수 확인 전에 단정.** device+backend+native를 모두 긁고, **공유 본체 호출 여부와 게이트 순서**까지 본 뒤 쓸 것.

## 4. 사용자 결정 (2026-10-15 승인)

1. **일시정지 중에는 발사하지 않는다.**
2. **boolean 리터럴로 정책을 호출부에 박지 않는다** — "사용자 행위"를 넘기고 축 파생은 소유자 1곳.
3. **LA는 모든 시나리오에서 탑승 상태 + 탑승/미탑승 버튼을 노출**한다(2-5로 Swift 변경 없이 가능).
4. **push 배너는 임박 시점에만.** 소리 모드면 소리까지.

채널 역할 분리:

| 채널 | 역할 | 침입도 |
| --- | --- | --- |
| LA 카드 | 항상 현재 상태 + 탑승/미탑승 버튼 | 낮음(잠금화면 상주) |
| push 배너 | 임박 "지금 타세요" | 높음(배너/소리) |

## 5. 작업 (R1~R6)

### R1 — 행위 기반 API로 전환 (device)
boolean 리터럴 호출부 11곳(2-3) 제거. `navigationActive`/`promptOptIn`/`pausedAt` 축 파생을 **소유자 1곳**으로 모은다. 사용자 행위 단위: 안내 시작 / 일시정지 / 안내 종료 / 탑승 응답 / trip 종료.
- 금지: 새 추상화 레이어 신설(글로벌 룰 2). 기존 store 경계 유지하며 **의도 명명 함수**만 추가.

### R2 — 일시정지 중 발사 억제
R1의 pause 전이 **속성으로 1곳** 정의. 현재는 `promptOptIn=false` stamp가 유일 수단이었고 R3 이후 무력해지므로 별도 억제가 필요하다.

### R3 — LA `boardingPhase` 상시 산출 (핵심)
프롬프트 발사와 **무관하게** `boardingPhase`/`boardingPromptTripToken`/`boardingPromptOriginStation`/`boardingPromptLine`/`trainCode`를 채운다. 1순위 구현 위치는 **device `useLiveActivityPreBoardingLifecycle`**(훅 doc이 *"네이티브/버튼/AppIntent 변경 없음 — JS만"* 명시). #2854가 막은 것은 **배너**이므로 content만 복원하고 배너는 발사하지 않는다.
- S4(lock 후 `boardingPhase` 공백) 해소 포함. `autoLockedTracking` 분기(2-5)가 lock 후 재질문을 이미 방지한다.

### R4 — push 배너는 임박에만
현 동작 유지(변경 없음). #2801 `suppressed-not-imminent` / #2939 `lock-already-attached` 보호 **무변경**.

### R5 — origin 경로에 반복 게이트 적용
`evaluateBoardingPromptRepeatGate`(2-6)를 origin 경로에도 적용. **신규 상수 0.** OR 게이트 완화(아래)로 늘어날 발사 빈도의 스팸 억제.

### R6 — 관측
"트립 등록됐는데 N분간 사용자 가시 산출물 0건"을 `trip_events`에 적재. 현재 이 상태는 **무신호**라 사용자 신고로만 발견된다(오늘 그랬다).

### OR 게이트 완화 범위 (R3와 독립 결정)
R3만으로 **LA 버튼을 통한 lock 경로가 열리므로**, OR 게이트(`:8043`) 완화는 **push 배너 발사에만** 영향한다. R4가 "배너는 임박에만"이므로 **OR 게이트 완화는 이 plan 범위에서 불필요**할 수 있다 — `/verify-plan`에서 판정 대상.

## 6. Acceptance

1. **S1**(목적지만 설정, 안내 시작 전): LA 카드에 탑승 상태 + **탑승/미탑승 버튼** 노출. 버튼 탭 → lock 생성.
2. **S4**(탑승 확정 후): LA 탑승 표시가 **공백이 되지 않는다**. [탑승] 버튼은 사라지고 [아니에요]만(#2528 기존 설계).
3. **일시정지 중**: 프롬프트/배너 **0건**.
4. **#2651 무회귀**: GPS 양호 + 출발역에서 먼 거리 + 정지 → 배너 **미발사**(거부 케이스).
5. **#2532 무회귀**: 지하(GPS 판독 없음) → 근접 게이트 fail-open으로 **발사**(거부 케이스).
6. **#2854 무회귀**: 목적지만 설정해두고 방치 → **배너 0건**(R4: 배너는 임박에만). LA content는 노출.
7. **#2801 무회귀**: 임박 아닌 시점에 배너 **미발사**.
8. **#2939 무회귀**: lock 활성 leg에서 재질문 **미발사**.
9. **R5**: origin 경로 배너가 최대 3회 / 5분 간격 / dismiss 후 5분 침묵. 4회째 발사 시 red.
10. **revert-red**: R1~R3·R5 각각을 되돌리면 red가 되는 테스트.
11. 기존 device 11096 / backend 4008 **무회귀**, coverage 100%.

## 7. 영향 범위

- device: `HomeScreen.tsx`, `useNavigationStore.ts`, `useUserIntentStore.ts`, `useLiveActivityPreBoardingLifecycle.ts`, (`SettingsScreen.tsx` — sleepMode 리터럴)
- backend: `scheduled.ts`(R5 적용, R6 적재) — R3는 device-only 가능성
- native(Swift): **변경 없음**(2-5 — 버튼·필드 기존재)

## 8. `/verify-plan` 자체 검증 결과 (메인 직접 수행, 2026-10-15)

### 확인 (근거 file:line)

- **[B] LA 버튼 → backend lock 사슬 완결** — 위젯이 **직접 POST**한다. `BoardingIntents.swift:50` `ALARM_BACKEND_URL_BASE = "https://subway-now-alarm-worker.handokei.workers.dev"`, `:85` `POST /trips/{encodedToken}/boarding-confirm`, `:91-111` `URLSession.shared.data(for:)` + non-2xx 로깅, `:104-106` `trainCode` optional 포함(#2962). doc `:52-58`: *"App Intent perform()이 앱을 열지 않고(BG) backend에 직접 전달 — **앱이 완전히 정지된 상태에서도 leg 락 체인이 완결되도록 하는 주 경로**(#2527 FG-gap 제거)"*. App Group write + `useLiveActivityIntentBridge`(FG 폴링, `:22`)는 **재시도 fallback**이다.
  → **`openAppWhenRun: false`(`:176`)인데도 FG 불필요.** acceptance #1("버튼 탭 → lock 생성")은 앱을 열지 않아도 성립한다.

- **[D] `boardingPhase`를 채우되 배너를 안 내는 것이 가능** — `LiveActivityManager.swift:155-178 resolveAlertConfiguration`:
  ```swift
  guard let phase = state.boardingPhase, phase == "pre-boarding" || phase == "hop-end" else { return nil }
  if phase == "pre-boarding" && state.boardingAutoLocked == true { return nil }   // S4 무음(의도)
  guard let title = state.boardingAlertTitle, let body = state.boardingAlertBody else { return nil }
  guard lastAlertedBoardingPhase != phase else { return nil }                      // 같은 phase 1회만
  ```
  → **`boardingAlertTitle`/`boardingAlertBody`를 생략하면 alert = nil → 무음 content 교체.** 버튼은 `phase == "pre-boarding"`만 보므로(`SubwayLiveActivityWidget.swift:289`) 그대로 렌더된다. Swift 변경 0으로 R3 구현 가능.

- **[버튼 렌더 조건]** `SubwayLiveActivityWidget.swift:289` `} else if phase == "pre-boarding" {` → `BoardingConfirmIntent`/`NotBoardedIntent`. `:277-287` `autoLockedTracking == true`면 [탑승] 제외하고 [아니에요]만(#2528).

### 🔴 반증 → plan 수정 (C)

- **[C] backend는 일시정지를 모른다.** `backend/alarm-worker/src/types.ts`에 `paused` 관련 필드 **0건**, 등록 페이로드에도 pause 신호 없음. 현재 pause 억제의 **유일한 경로**는 `promptOptIn=false`를 backend로 forward하는 것이다(`useApnsTripRegistration.ts:114 promptOptIn?: boolean`, `alarmBackend.ts:426`).

  → **따라서 §5의 "OR 게이트 완화"는 선택지가 아니라 금지사항이다.** 완화하면 `promptOptIn`이 더 이상 게이트가 아니게 되어 **일시정지 중 backend 발사를 막을 수단이 사라진다**(사용자 결정 §4-1 위반). plan §5 마지막 문단이 "불필요할 수 있다"고 적은 것을 **"하지 않는다(hard constraint)"** 로 확정한다.

  → R2(일시정지 억제)의 범위도 확정된다: **device에서 pause 중 `boardingPhase`를 채우지 않는다**(LA 버튼 미노출). backend 발사는 기존 `promptOptIn=false` forward가 그대로 막는다. **backend 변경 불필요.**

### 수정된 작업 범위 (확정)

| | 내용 | 레이어 |
| --- | --- | --- |
| **R1** | 행위 기반 API — boolean 리터럴 11곳 제거, 축 파생 1곳 | device |
| **R2** | pause 중 `boardingPhase` 미세팅(LA 버튼 미노출). OR 게이트 **무변경**이라 backend 발사는 기존 경로가 막음 | device |
| **R3** | `boardingPhase` + 버튼 컨텍스트(tripToken/originStation/line/trainCode) 상시 산출. **`boardingAlertTitle`/`Body`는 채우지 않는다**(무음 보장) | device |
| **R4** | push 배너는 임박에만 — **무변경** | — |
| **R5** | origin 경로에 `evaluateBoardingPromptRepeatGate` 적용 | backend |
| **R6** | "가시 산출물 0건" 관측 | backend |
| ~~OR 게이트 완화~~ | **금지**(위 C) | — |

### 🔴 반증 ② → R3를 **backend로 이동** (A + 검사 #9)

- **[A] device-only R3는 heartbeat마다 지워진다.** backend `buildLiveActivityContentState`(`liveActivity.ts:179-186`)가 보내는 필드는 `stationName`/`lineName`/`lineColorHex`/`etaMinutes` 등이고 **boarding* 필드는 0건**이다(`grep "boardingPhase|boardingPrompt|boardingAlert|boardingAutoLocked" src/liveActivity.ts` → 0 hit). ActivityKit push 업데이트는 content-state를 **교체**하므로, device가 `boardingPhase`를 채워도 **backend heartbeat(실측 시간당 13건)마다 nil로 덮인다** → 버튼이 깜빡이거나 사라진다.
  → plan §5 R3의 *"1순위 구현 위치는 device `useLiveActivityPreBoardingLifecycle`"* 는 **틀렸다.**

- **[검사 #9] device-only R3는 확정 아키텍처를 뒤집는다.** `memory/decision_ARCHITECTURE_COMMITTED_server_track_visible_push.md:85`: *"**backend-vs-device 재litigate 금지.** 결정됨: backend추적 + Live Activity표시 + device=탭."* LA content 소유권을 device로 가져오는 것은 그 결정의 반대 방향이며 plan에 충돌 선언이 없었다.

- **보강 확인**: `alert`는 `contentState`와 **별개 파라미터**다(`liveActivity.ts:256-262` `sendLiveActivityUpdate({ contentState, event:'update', staleDate, alert, ... })`). 따라서 **backend content-state에 boarding 필드를 추가해도 배너는 붙지 않는다** — R4(배너는 임박에만)와 양립한다.

### R3 수정 (확정)

**backend가 LA content의 단일 소유자다.** `buildLiveActivityContentState`가 **trip 상태로부터** boarding 필드를 파생해 **모든 heartbeat에 포함**한다:

| 필드 | 값 |
| --- | --- |
| `boardingPhase` | lock 없음 → `'pre-boarding'` / lock 있음 → `'boarded'`(또는 미세팅) |
| `boardingPromptTripToken` / `OriginStation` / `Line` | `trip.promptDisplay`(leg-1) 또는 `currentLegAnchor`(leg-2)에서 파생 |
| `trainCode` | lock 있으면 `boardingLock.trainCode`, 없으면 미세팅 |
| `boardingAutoLocked` | lock 있고 `boardingEvidence===true`면 `true`(→ [탑승] 버튼 숨김, `:277-287`) |
| **`boardingAlertTitle`/`Body`** | **heartbeat에서는 채우지 않는다** → `resolveAlertConfiguration`이 nil 반환(무음). 프롬프트 발사 시에만 기존대로 채움 |

- device(`useLiveActivityPreBoardingLifecycle`) **변경 없음** — #2854의 "싣지 않는다"를 **유지**한다(상속이 아니라 유지, 검사 #4).
- Swift **변경 없음**.
- 영향 레이어: **backend only**.

### 미확인 (착수 시 `추정` 라벨)

- device 로컬 LA update(`LiveActivity.updateLiveActivity`, lock 전 GPS 파이프라인)와 backend push가 **교차**하는 구간에서 device가 보내는 content에 boarding 필드가 없으면 같은 덮어쓰기가 **역방향**으로 생기는지 미확인. backend가 소유자가 되면 device 로컬 update 경로도 boarding 필드를 보존해야 할 수 있다 — 착수 시 `stationNotification.ts` forward 매핑(`:564-580`) 경유 여부로 판정.

## 9. (구) 미확정 — §8로 대체됨

1. R3를 device로 할지 backend로 할지 — device 훅 doc은 JS만으로 가능하다 하지만, LA가 backend push로 갱신되는 구간(13건 heartbeat)에서 device가 content를 덮어쓰는 **경합**이 없는지 미확인.
2. OR 게이트 완화가 실제로 불필요한지(§5 마지막).
3. R2 억제의 구현 지점 — pause 중 backend가 트립을 계속 폴링하므로 device 플래그만으로 되는지, backend에도 신호가 필요한지 미확인.
4. `boardingPhase` 상시 세팅이 `stationNotification.ts:564-580` forward 매핑과 충돌해 **원치 않는 배너**를 유발하지 않는지 미확인.


## 10. `/verify-plan` 2차 (검사 #4·#7 — 메인 직접, 2026-10-15)

### 🔴 반증 ③ [검사 #4] — `scheduled.ts` 미커버 선언 미판정

`scheduled.ts`에 `무변경|싣지 않는다|의도적으로|범위 밖|다루지 않` **31 hit**이 있는데 plan이 하나도 판정하지 않았다. R5/R6이 건드릴 구간으로 좁힌 판정:

| 위치 | 선언 | 판정 |
| --- | --- | --- |
| `:8051` | *"게이트 판정/발사 로직 자체는 무변경"*(ADR-037 D2c 계측) | **유지** — R5는 계측이 아니라 repeat gate 추가. 그 선언 범위와 무관 |
| `:8072` | *"device 변경 범위 밖"*(accuracy 해석) | **유지** — 근접 게이트 무변경 |
| `:7717` | *"trip 객체 경유 dedup은 무변경 — 이 콜백은 신규 억제"* | **유지** — R5가 쓰는 `evaluateBoardingPromptRepeatGate`가 그 "trip 객체 경유 dedup"이다. 공유 본체의 fire-once와 **별개 레이어**임을 이 선언이 보증 |
| `:7854` | *"정상 경로는 device fresh pick 우선 — 무변경"* | **유지** — payload trainCode 무변경 |
| `:7860` | *"repeat gate(trip 경유)는 무변경, 이 검사는 이중 방어로 얹는다"* | **유지. 그리고 R5의 근거다** — repeat gate가 공유 본체의 fire-once와 독립임이 명시돼 있어, origin 경로에 추가해도 이중 적용이 아니다 |

`liveActivity.ts`(R3 대상): **0 hit** — 상속할 선언 없음.
`useLiveActivityPreBoardingLifecycle.ts`: 3 hit(`:15`·`:23`·`:73`) → 전부 **유지**(R3가 backend로 이동했으므로 이 파일 무변경).

### 🔴 중대 발견 ① [검사 #7] — #2782(OPEN)가 **같은 증상, 같은 역**이고 기전이 stale

**#2782**: *"tripOrigin이 GPS로만 확정돼 지하 출발 시 LA 탑승 버튼이 사라진다 — 9/21 용마산 실측"*
> 사용자 관측: **"용마산 탑승했는데 LA에 탑승여부가 없었음. 알림 탭으로 FG 진입 후에야 lock 생성."**

**오늘 증상과 동일하고 출발역도 같다(용마산).** 그런데 #2782이 인용한 기전(`origin`이 null이면 탑승 필드 4개가 빠진다)은 **더 이상 유효하지 않다** — 현재 `buildPreBoardingLiveActivityData`(`:79-88`)는 `stationName`/`lineName`/`lineColorHex`/`distanceM`/`destinationName`만 반환하고 **boarding 필드를 `origin` 유무와 무관하게 아예 안 싣는다**(`:73` #2854).

→ **#2997과 #2782는 같은 사용자 결함이고, #2782의 기전 서술은 #2854 이후 stale이다.** #2782을 #2997로 수렴시키거나, #2782에 "기전 갱신" 코멘트를 달아야 한다. **이 plan은 #2782도 닫는다.**

### 🔴 중대 발견 ② [검사 #7] — LA 버튼 경로는 **프로덕션 관측 0건**이다

**#2734**(CLOSED): *"LA 버튼 BG lock 경로가 전부 구현돼 있는데 실행 관측 0건 — boarding-confirm-result D1 0건, 원인 미확정"*
> **덤프 20개에 LA 버튼 사용 흔적 0건 — 실제 동작을 관측한 적이 없다.**

#2734 당시 서술("결과는 App Group 쓰기뿐, 읽는 주체가 FG에만")은 현재 코드와 다르다 — 직접 POST가 존재한다(§8 [B]). 그러나 **"관측 0건"은 여전히 유효할 수 있다**: 버튼이 렌더될 조건(`boardingPhase`)이 이 plan 전까지 거의 성립하지 않았으므로 **사용자가 누를 버튼이 없었다**. 즉 #2734의 "원인 미확정"에 대한 답이 이 plan의 결함이다.

→ **acceptance #1은 이 경로의 "최초 프로덕션 관측"이 된다.** 코드 완결성은 검증했지만 **실행 이력이 0이므로 `추정`으로 라벨한다** — 실기기 1회 확인이 필수이고, R6(관측)이 그 판정 수단이다.

## 11. 처분

- 반증 ①②③ → **plan 수정 완료**(OR 게이트 완화 금지 / R3 backend 이동 / 미커버 선언 판정).
- 미확인 2건 → `추정` 라벨: ⓐ device 로컬 LA update의 역방향 덮어쓰기 ⓑ LA 버튼 경로 프로덕션 실행 이력 0건.
- **착수 가능.** 단 ⓑ 때문에 "코드 green = 동작"으로 보고하지 않는다 — 실기기 1회 + R6 관측으로만 확정한다.
