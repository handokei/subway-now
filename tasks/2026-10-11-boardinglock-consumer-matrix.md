# boardingLock 소비자 전수 매트릭스 (E1 사전조사, 읽기 전용)

조사 범위: `grep -rln "boardingLock"` 결과 **113개 비-테스트 파일**(backend 13 + device 100).
전부를 라인단위로 끝까지 추적하지는 못했다 — 아래 §5에 미확인 파일을 명시한다. 이 파일은
**코드 변경 없음, 커밋하지 않음**(요청대로 team-lead가 검토 후 커밋).

## 1. 요약

- grep 적중 파일: 113개 (backend 13, device 100). 이 중 **깊게 추적**(file:line 근거로 거동
  판정)한 소비자: **14개**. 나머지는 패턴 분류(필드 read-only 접근, 거동 미판정)로 묶었다.
- 축 분포(깊게 추적한 14개 기준): 표시 4 / 판정 6 / 발사 4.
- `stale 위험`: 0건 확정 (widget은 boardingLock을 직접 미러링하지 않음 — §2 확인).
- `식별자 의존`: **2건 확정** — ① `tryDefaultHop`의 `lock.boardedAt` 앵커(진행도),
  ② backend `promptState.firedTrainCodes`의 `trainCode` dedup 키(boarding-prompt 재발사).
- `단조성 가정`: **2건 확정 코드/주석** — ① device `useBoardingLockStore.ts:171`
  `lock-create-skip-immutable`(flag-gated), ② backend `index.ts:2185,2240`
  `#1729 active lock 재평가 금지` — **이것이 E1이 직접 바꾸는 게이트 그 자체**.
- `미확인`: 99개 파일(개별 거동 미판정, 패턴상 저위험으로 추정되나 미확인으로 표기).

## 2. 매트릭스 (깊게 추적한 소비자)

### 표시 (Display)

| file:line | 읽는 필드 | 교체 순간 거동 | 위험 |
|---|---|---|---|
| `src/features/nearest-station/hooks/useFusedNearestStation.ts:1260-1270` | `boardingLock.boardingLine` | **무해(근거 있는 기존 flash)** — 주석(:1262) 자체가 "race: createTransferLock으로 lock이 새 leg로 교체되는 순간 1 render cycle 동안 옛 lock 기준 강등이 일어나 source가 한 번 gps로 flash 가능 — UX 임팩트 미미해 현재는 수용" 이라고 명시. **이미 존재하는 교체 경로(leg transfer)에 대한 기존 선례** — E1도 같은 종류의 1-frame flash를 유발할 것으로 예상(신규 위험 아님, 기존 수용된 패턴 재사용). | 낮음 — 단, E1의 교체 빈도가 leg-transfer보다 높다면(예: 매 탭마다) flash 빈도 증가 |
| `src/features/widget/api/widgetStorage.ts` (전체) | `boardingLock` **미참조** — grep 0건 | **무해** — 위젯은 boardingLock을 직접 미러링하지 않고 station 파생값만 저장 (`clearWidgetStation` 호출만 `tripBoundCleanups.ts:24`에서 확인). 교체 시 다음 tick에 파생값이 재계산돼 반영됨 — stale mirror 경로 없음. | 없음 |
| `src/features/alarm/hooks/useLiveActivityIntentBridge.ts:130-133` | `trainCode`(LA intent 파라미터) | **부분 미확인** — 주석: "LA 버튼 intent는 참여할 trainCode가 없다 — station+line만으로 판정하는 기존 dedup을 그대로 유지". LA 버튼 dedup이 trainCode를 안 쓰므로 교체에 영향 없음(무해)으로 보이나, LA 자체 render path(`useEnsureLiveActivity.ts`)는 미추적. | 미확인(LA 본체 render) |
| `src/features/alarm/components/BoardingLockHopCard.tsx` | `lock` 전체(표시용) | **미확인** — Zustand selector 기반이면 교체 시 자동 리렌더(무해 추정), 단 내부에서 `boardedAt` 기반 경과시간을 표시한다면 §2 판정 아래 "판정" 축 위험과 동일 패턴 공유 가능. 확인 못함. | 미확인 |

### 판정 (Decision/Filter)

| file:line | 읽는 필드 | 교체 순간 거동 | 위험 |
|---|---|---|---|
| **`src/features/route/utils/stationProgressEstimator.ts:337-353` (`tryDefaultHop`)** | `lock.boardedAt`, `lock.boardingStationId` | **🔴 식별자 의존 확정** — `const elapsedMs = now - lock.boardedAt;`(:344). lock이 새 `boardedAt`으로 교체되면 `elapsedMs`가 0 근처로 리셋 → hop 적분이 탑승역부터 다시 시작 → **진행도가 뒤로 점프**. Strategy ①②③(`tryLivePosition`/`tryArrivalEta`/`tryReanchoredHop`)이 전부 실패해 ④로 fallback한 상황에서만 노출(:463-517 우선순위). | **높음** — 지하(신호 없음)에서 탭으로 lock 교체 시 진행바가 역행할 수 있음. E1 거부 케이스 후보 1번. |
| `backend/alarm-worker/src/index.ts:2240` (`boarding-confirm` 'boarded') | `working.boardingLock === undefined` | **🔴 단조성 가정 확정, E1이 바꾸는 바로 그 게이트.** 주석(:2185,:2239): "#1729 — 이미 active lock이 있으면 재평가하지 않는다(register-time과 동일 가드)". lock 존재 시 분기 전체(anchor resolve, `consecutiveEtaMissing`/`lastTrackedArrivalEpoch`/`lastLaPushEpoch`/`lastLaPushAt` 리셋, `markPromptFired`)가 **스킵**된다(:2313-2315, else 분기는 `lockState`만 재계산). E1이 이 가드를 제거하면 **이 리셋 블록이 trip 중간에 다시 실행**된다 — 특히 `lastLaPushEpoch`/`lastLaPushAt` undefined 리셋은 LA push 빈도 게이트를 초기화한다(아래 "E1 거부 케이스 후보 2"). | **높음** |
| `backend/alarm-worker/src/lockSwap.ts:1-173` (전체, 기존 trainCode auto-swap) | `existing.boardingLock`, `targetWaypoint` | **무해(기존 선례)** — 이 파일 자체가 "트레인코드만 바뀌는 교체"를 이미 1년 넘게 운영 중인 경로(#902). `boardingStationId`/`segmentStations`는 유지하고 `trainCode`만 swap — E1이 만들 교체(leg 전환, segmentStations도 바뀜)보다 **범위가 좁다**. E1 설계 시 이 파일의 "무엇을 보존하고 무엇을 바꾸는지" 패턴을 참조 가능. | 참고용(직접 위험 아님) |
| `backend/alarm-worker/src/scheduled.ts:8146-8280` (`firedTrainCodes` 소비) | `trip.boardingPromptState?.firedTrainCodes`, `legBoardingPromptState?.firedTrainCodes` | **🔴 식별자 의존 확정** — dedup 키가 `${trainCode}:${decision}`(`boardingPrompt.ts:276`). E1으로 `boardingLock.trainCode`가 바뀌어도 `firedTrainCodes`는 **promptState에 별도로 저장되고 lock 교체로 자동 초기화되지 않는다**(다른 struct). 즉 교체 자체는 이 dedup을 리셋하지 않음(무해 방향) — 단, 반대로 **"새 lock의 trainCode가 과거에 이미 fire된 trainCode와 같을 수 있는가"**는 E1의 교체 조건에 따라 달라짐(탭으로 같은 trainCode를 다시 선택하면 `canFireForTrainCode`가 거부해 정당한 재탑승 알림이 막힐 수 있음). | 중간 — E1이 "같은 trainCode로 재탭"하는 케이스를 허용하면 이 게이트와 충돌 가능 |
| `backend/alarm-worker/src/index.ts:1126-1142,1188-1190` (POST /trips register merge) | `existing.boardingLock?.trainCode`, `incoming.boardingLock?.trainCode` | **식별자 의존(기존 경로, cold-restart 재등록)** — "같은 세션" 판정이 `trainCode` 일치로 결정(:941 주석, :1487 `isSameTripSession` 추정). E1이 교체를 trip 도중에 허용하면 이 재등록 merge 로직이 "다른 세션"으로 오판할 가능성 — 재등록은 앱 재시작시에만 발생하므로 교차 영향은 간접적. | 미확인(재등록 타이밍과 E1 교체 타이밍이 겹치는 edge case) |
| `src/features/alarm/store/useBoardingLockStore.ts:139-172` (`createLock`, flag `isSimpleArchEnabled`) | `prev.destinationId/trainCode/boardingLine/boardingStationId` | **🔴 단조성 가정 확정(device, flag-gated)** — 이미 "정당한 교체 3조건"(trainCode 변경/boardingLine 변경/destinationId 변경)을 코드가 정의해놨다(:139-146 주석). 이 3조건 중 **어느 것도 안 바뀌고 boardingStationId만 바뀌는 createLock은 silent skip**(:171 `lock-create-skip-immutable` breadcrumb, `return`). **E1이 생성하려는 "탭이 즉시 그 leg의 lock을 만든다"가 이 3조건 중 하나(보통 trainCode 변경)를 수반하면 이 가드는 통과한다** — 즉 디바이스 쪽은 이미 E1 호환 가능한 모양새. 단 flag OFF(default)면 가드 자체가 비활성(:139 `if (isSimpleArchEnabled())`). | 낮음(flag ON 전제) — E1 구현 시 이 가드의 flag 상태를 확인해야 함 |

### 발사 (Fire/Push)

| file:line | 읽는 필드 | 교체 순간 거동 | 위험 |
|---|---|---|---|
| `src/features/alarm/utils/undergroundConsensusFire.ts:123` / `bgPositionTrainFire.ts:179` / `bgWaypointArvlcdFire.ts:119` | `getFiredAlarms(destination.id)` | **무해 확정** — fired-dedup 키가 `destination.id`(목적지 station) 기준이고, 내부 `alarmKey`는 `phaseId + stationName`(`bgWaypointArvlcdFire.ts:42`)으로 구성 — **trainCode나 lock 식별자를 키에 쓰지 않는다**. lock이 교체돼도 이미 발사한 역의 dedup 상태는 보존됨(중복발사 없음). | 없음 |
| `bgPositionTrainFire.ts:62` / `bgWaypointArvlcdFire.ts:79` | `lock.trainCode`(pending 여부만 체크) | **무해(매 tick 재평가)** — `isPendingTrainCode(lock.trainCode)` 체크는 매 호출마다 스토리지에서 fresh read(`getBoardingLock()`, 양쪽 파일 10행 import). 캐시/클로저 없음. | 없음 |
| `backend/alarm-worker/src/apns.ts:109-121,390-393,877-935` (silent push payload 조립) | `boardingLock.line`, `boardingLock.trainCode` | **무해(매 호출 시점 trip 스냅샷에서 직접 읽음)** — payload 조립 함수가 호출 시점 `trip`/`options` 인자를 그대로 읽어 조립(:393 `payload.trainCode === undefined ? {} : {...}`). 캐시 없음. 단, **payload가 device로 전달된 후** device 쪽에서 trainCode를 키로 쓰는 2차 소비(`silentPushTask.ts`)는 별도 축. | 없음(이 파일 자체는) |
| `backend/alarm-worker/src/d1TripMetrics.ts:66-122` (`lockAttached` 메트릭) | `trip.lockEverAttached`, `trip.boardingLock !== undefined` | **무해(OR 조건으로 단조 누적)** — `lockAttached: trip.lockEverAttached === true \|\| boardingLock !== undefined ? 1 : 0`(:122). `lockEverAttached`는 한 번 true가 되면 유지되는 별도 플래그(putTrip choke point, :108 주석) — lock이 교체(release→재생성)돼도 "생애 중 한 번이라도 lock이 붙은 적 있는가"라는 메트릭 의미는 보존됨. | 없음 |

## 3. 🔴 단조성 가정 전수 (주석 원문 인용)

1. **`backend/alarm-worker/src/index.ts:2185`**
   > "`boarded` — ... 이미 `boardingLock`이 있으면 재평가하지 않는다(#1729 active lock 재평가 금지와 동일 원칙, POST /trips register-time 가드 재현)."
   **`index.ts:2239-2240`**
   > "#1729 — 이미 active lock이 있으면 재평가하지 않는다(register-time과 동일 가드)."
   `if (working.boardingLock === undefined) { ... } else { lockState = isLegTwoActive(working, now) ? 'leg2' : 'leg1'; }`
   → **이것이 E1이 직접 수정할 게이트.** else 분기는 `lockState` 레이블만 다시 계산하고 그 외 아무것도 안 함 — anchor 재평가, `markPromptFired`, 4개 필드 리셋(`consecutiveEtaMissing`/`lastTrackedArrivalEpoch`/`lastLaPushEpoch`/`lastLaPushAt`) 모두 스킵.

2. **`src/features/alarm/store/useBoardingLockStore.ts:139-146`** (device, `#1996 Phase 1-7 ADR-022 A4`)
   > "route 등록 시 확정된 boardingStationId는 절대 자동 변경 금지 (auto-swap / reanchored / fusion cascade 금지). 예외는 정당한 route 재등록: 1) trainCode 변경 ... 2) boardingLine 변경 ... 3) destinationId 변경 ... 위 3가지가 모두 동일한데 boardingStationId만 다른 createLock은 auto-swap 시도로 간주 → skip."
   `:171` `addDomainBreadcrumb('boarding', 'lock-create-skip-immutable', {...}); return;`
   → device는 이미 "정당한 교체 vs 불법 auto-swap"을 **3개 필드 비교로 구분하는 메커니즘을 갖고 있다**(flag `isSimpleArchEnabled()` ON 시). E1은 이 메커니즘과 **호환되는 방식으로 설계해야 한다** — 즉 E1이 생성하는 새 lock은 (trainCode 또는 boardingLine 또는 destinationId) 중 최소 하나를 이전 lock과 달라야 이 가드를 통과한다. 같은 leg 안에서 보드스테이션만 바꾸는 "교체"는 이 가드가 **이미 차단한다**(flag ON 전제).

3. (참고, 단조성은 아니지만 인접) **`backend/alarm-worker/src/index.ts:2191-2193`** (disembarked 분기)
   > "`trip.boardingLock`을 해제한다. waypoint/currentLegAnchor는 건드리지 않는다 — 그 advance는 cron의 책임 그대로이며, 이미 advance됐다면(currentLegAnchor 존재) 본 분기는 boardingLock을 건드리지 않는다."
   → lock 해제와 waypoint advance가 **분리된 책임**이라는 기존 설계 원칙. E1이 "탭 즉시 교체"를 구현할 때 이 분리를 깨면(예: lock 교체와 동시에 waypoint도 강제 advance) 기존 cron 책임 경계와 충돌.

## 4. E1 거부 케이스 후보 (TDD 제약)

1. **진행도 역행 금지** — lock 교체 시 `tryDefaultHop`(`stationProgressEstimator.ts:344`)이 `now - lock.boardedAt`을 재계산해 진행도가 교체 이전보다 **뒤로 가면 거부**. 근거: §2 판정축 1행. E1은 새 lock 생성 시 `boardedAt`을 교체 이전 값(또는 더 이른 값) 이하로 내려가지 않게 보존하거나, `tryDefaultHop`이 "직전 추정 진행도 이하로 떨어지면 clamp"하는 별도 가드를 둬야 함(현재 코드에 이 clamp 없음 — 신규 작업 필요).

2. **LA push 빈도 게이트 재설정 금지** — `index.ts:2298-2300`의 `lastLaPushEpoch: undefined, lastLaPushAt: undefined` 리셋이 lock 교체 시 **다시 실행되면** "방금 LA push를 보냈는데 lock 교체로 게이트가 풀려 즉시 재push"가 가능. 근거: §2 판정축 2행, §3-1. E1은 이 4개 필드 리셋 블록을 "lock이 `undefined`에서 생성될 때만" 실행하도록 조건을 분리해야 함(현재는 "boarded 분기에 진입하면 무조건" 실행).

3. **같은 trainCode 재선택 시 발사 거부 금지** — `firedTrainCodes` dedup(`scheduled.ts:8146-8280`, `boardingPrompt.ts:353` `canFireForTrainCode`)이 "같은 trainCode는 `MAX_FIRES_PER_TRAIN_CODE`까지만"을 강제. 근거: §2 판정축 4행. 사용자가 **같은 열차를 다시 명시 탭**(예: 하차 취소 후 재탑승)하는 E1 경로가 있다면, 이 dedup이 정당한 재알림을 막을 수 있음 — E1 스펙에 "같은 trainCode 재탑승" 케이스가 있는지부터 확인 필요(없으면 이 거부 케이스는 기각).

4. **device `boardingStationId` 불변 가드와 모순 금지** — §3-2. E1이 생성하는 새 lock이 (trainCode/boardingLine/destinationId) 중 하나도 바꾸지 않고 `boardingStationId`만 바꾸는 형태라면 device측 `createLock`이 **flag ON 환경에서 조용히 skip**한다(`useBoardingLockStore.ts:171`). E1 구현이 반드시 이 3필드 중 하나를 바꾸는 방식이어야 device와 backend 양쪽에서 일관되게 "교체"로 인식됨.

5. **disembarked/advance 책임 분리 유지** — §3-3. E1이 lock 교체와 waypoint advance를 한 트랜잭션으로 묶지 않아야 함(기존 cron 책임 경계 보존).

## 3-A. 2차 패스 — 기존 교체 경로의 실측 거동 (주 산출물)

**핵심 발견**: 기존 "trip 도중 lock 교체"는 **두 가지 서로 다른 메커니즘**이고, 둘 다 **E1이
바꾸려는 게이트(`index.ts:2240` `boardingLock === undefined`)를 실제로는 우회하지 않는다** —
즉 기존 경로는 "active lock을 그 자리에서 replace"가 아니라 **release(undefined로 리셋) →
재생성**의 2단계다. 근거:

- `backend/alarm-worker/src/scheduled.ts:6117-6124` (`advanceBoardingLockWaypoint` 내부) —
  `isRealLineChange`(:6117, `nextLegWaypoint?.line !== trip.boardingLock?.line`)가 true면
  `trip.boardingLock = undefined`(:6124)로 **먼저 release**한다.
- 그 직후 `/boarding-lock/sync` 핸들러(`index.ts:~2884-2899`, 1차 패스에서 본 "lock 승격" 블록)의
  조건이 `working.boardingLock === undefined && payload.trainCode !== undefined`(원문 요약, 코드
  라인은 2884 부근)다 — **release로 undefined가 된 그 순간에만** 새 trainCode로 재생성(promote)된다.
  release 전이라면(즉 아직 active lock이 있는 상태) 이 경로는 시도조차 안 한다.
- device 쪽 `createTransferLock`(`src/features/route/hooks/useTransferTrainList.ts:221-264`)은
  **`createLock` store 호출 하나로 끝나는 완전히 다른 경로**다(backend release를 기다리지 않고
  device가 즉시 로컬 lock을 새로 만든다) — `useBoardingLockStore.createLock`은 기존 lock이
  있어도 **flag ON 시에만** 3조건(trainCode/boardingLine/destinationId) 가드를 걸고, flag OFF
  (default)면 무조건 교체를 허용한다(§3-2 재인용). 즉 **device는 이미 "active lock이 있어도
  즉시 교체"를 하고 있다** — 이건 E1이 아니라 **지금 운영 중인 동작**이다.
- `backend/alarm-worker/src/lockSwap.ts`(`attachTrainCodeForLeg`)도 **호출 전에 caller가 이미
  `trip.boardingLock`을 release한 상태에서만 호출된다**(§위 2줄과 동일 패턴, `scheduled.ts`의
  vanish-swap/transfer-swap 호출부가 release 후 attach를 조합). `attachTrainCodeForLeg`가 반환하는
  `BoardingLockMeta`에는 **`boardedAt` 필드 자체가 없다**(`backend/alarm-worker/src/types.ts:571-583`
  정의 확인 — `selectedDepartureTime`만 있음). → **backend는 §4-1(boardedAt 역행) 위험에 애초에
  노출되지 않는다.** 그 위험은 **device 전용**이다.

| 교체 경로 | `boardedAt`(device) | `segmentStations` | `trainCode` dedup | LA 게이트(`lastLaPushEpoch`) |
|---|---|---|---|---|
| **device `createTransferLock`**(`useTransferTrainList.ts:245`) | **새 `Date.now()`로 전면 리셋**(승계 없음) — 모든 device `createLock` 호출부(`useBoardingLockController.ts:311,478,569`)가 동일 컨벤션. 신규 leg 시작이 전제이므로 "역행"이 아니라 **의도된 0-리셋**. | 명시 전달 안 함 — `BoardingLockInput`에 없고, segmentStations는 `boardingStationId`+`boardingLine`+route에서 **별도 파생**(device 쪽 타입에 필드 없음, §5 재확인 필요 — `shared/types/boardingLock.ts`에 `segmentStations` 필드 자체가 없을 수 있음). | 해당 없음 — device `createLock`은 backend `firedTrainCodes`(promptState)를 건드리지 않음(서로 다른 struct, 서로 다른 저장소). | 해당 없음(device 로컬 상태 — `lastLaPushEpoch`는 backend `Trip` 필드). device 쪽은 이 게이트와 직접 상호작용 없음. |
| **backend `advanceBoardingLockWaypoint` release→`/sync` 재승격** | N/A(backend `BoardingLockMeta`에 `boardedAt` 없음) | **교체됨** — `buildLegSegmentStations`(`lockSwap.ts:54-65`)가 새 leg의 waypoint부터 다시 수집. 이전 leg 배열은 폐기. | **release가 trainCode를 바꾸므로 dedup 키 scope도 새 trainCode로 이동** — 단, `firedTrainCodes`(promptState)는 release로 자동 clear되지 않음(별도 struct, §2 재확인) — 과거 trainCode 기록은 남아있지만 새 trainCode는 처음이라 자연히 "안 맞음"=정상. | **리셋됨** — `/boarding-lock/sync`의 "기존 경로"(:2800-2804) 분기가 waypoint 전진마다 `lastTrackedArrivalEpoch`/`lastLaPushEpoch`/`lastLaPushAt`을 **항상** undefined로 리셋한다(주석: "새 waypoint의 첫 push를 보장하기 위해 baseline reset"). **이건 lock 교체 전용이 아니라 모든 waypoint 전진에 적용되는 범용 동작**이다. |
| **backend `lockSwap.ts` vanish-swap**(같은 leg, trainCode만 변경, #902) | N/A | **유지** — `buildLegSegmentStations`가 같은 `targetWaypoint.line`에서 다시 빌드하지만 leg가 안 바뀌었으므로 결과적으로 동일 배열. | 동일(위와 같음) | **미확인** — 이 경로가 `lastLaPushEpoch`를 리셋하는지는 호출부(`scheduled.ts` `attemptVanishSwap` 주변)를 더 봐야 함(시간상 미추적). |
| **backend `boarding-confirm` 'boarded'(E1이 바꿀 그 경로, 현재는 lock 있으면 미진입)** | 해당 없음(backend) | 해당 없음 | 해당 없음 | 현재 코드: lock 있으면 이 분기 전체(4필드 리셋 포함, :2298-2300) **스킵**. E1이 가드를 풀면 **매번 실행**된다 — 위 "범용 동작"과 달리 **이건 "같은 leg 재탭"에서도 실행될 수 있어 새로운 조합**(아래 §4 참고). |

**결론(2차 패스가 바꾸는 판단)**: 기존 두 교체 경로(device 탭-환승, backend vanish-swap)는 모두
**"새 leg/새 트레인 선택" = boardedAt 0-리셋이 의미상 올바른 상황**에서만 발생하는 걸로 보인다
(leg가 바뀌거나, 같은 leg 안에서 열차 자체가 바뀌는 vanish 케이스 — 둘 다 "사용자가 이 시점부터
새로 진행한다"는 의미가 성립). **E1의 위험은 "같은 leg, 같은 트레인 상황에서 보강용 재탭"이
있는가에 전적으로 달려 있다** — 그런 케이스가 스펙에 없다면 §4-1(진행도 역행)은 **기각**된다.
스펙 확인 전까지는 "조건부 위험"으로 유지한다.

## 3-A-보강. 지정 4개 파일 직접 매핑

team-lead가 지정한 4개 파일을 위 표의 어느 행에 매핑되는지 명시(요청대로 파일명 그대로 인용):

| 교체 경로 | `boardedAt` | `segmentStations` | `trainCode` dedup 키 | LA 게이트(`lastLaPushEpoch`) |
|---|---|---|---|---|
| **`src/features/route/utils/transferSwap.ts`** | **해당없음** — 이 파일은 `evaluateTransferSwap`/`buildAutoLockCandidate`(순수 함수, :62-173)로 `AutoLockCandidate`(`{trainCode, line, subwayId}`)만 **계산**한다. `createLock`을 호출하지 않고 lock 필드를 직접 건드리지 않음 — 소비자는 `useTransferTrainList.createTransferLock`(위 표 행1)과 `backgroundLocationTask.ts`(미확인, §5). | 해당없음(같은 이유) | 해당없음 | 해당없음 |
| **`src/features/route/utils/findActiveTransferContext.ts`** | **해당없음** — `BoardingLock`을 **읽기만**(`lock: BoardingLock \| null` 인자, :54) 하고 `transferStationInToLine`/`nextLine`/`completedTransferIdx`를 계산해 반환(:34-51). lock을 쓰지(write) 않음 — 소비자(`useTransferTrainList.ts:179`)가 그 결과로 `createTransferLock`을 만들 때 실제 lock 필드를 결정한다(위 표 행1 참조). | 해당없음 | 해당없음 | 해당없음 |
| **`src/features/nearest-station/hooks/useFusedNearestStation.ts:1262` 주변** | **해당없음(이 파일 자체는 lock을 생성하지 않음)** — :1260-1270은 표시 축(fused station 강등 판정)이며, 주석(:1262)이 가리키는 "`createTransferLock`으로 lock이 새 leg로 교체"는 **다른 파일**(`useTransferTrainList.ts:221`, 위 표 행1)의 효과를 1-render-cycle 늦게 관측하는 쪽이다. 즉 이 파일은 교체의 **소비자**(표시 축, 이미 1차 §2에 기록)이지 교체 **메커니즘 본체**가 아니다. | 해당없음 | 해당없음 | 해당없음 |
| **`backend/alarm-worker/src/lockSwap.ts`** | **N/A(필드 없음)** — 위 표 행3("vanish-swap")과 동일 파일. `attachTrainCodeForLeg`가 반환하는 `BoardingLockMeta`(`types.ts:571-583`)에 `boardedAt`이 없음(`selectedDepartureTime`만 있음) — 이 함수는 `boardedAt` 개념 자체를 다루지 않는다. | **교체(재계산)** — `buildLegSegmentStations`(:54-65)가 매 호출마다 `trip.waypoints`에서 새로 빌드. leg가 안 바뀐 vanish-swap이면 결과가 이전과 동일한 배열이 되고, leg가 바뀐 transfer-swap 호출이면 새 leg 배열이 된다 — **호출 시점의 waypoints 상태에 전적으로 의존**(승계/보존 로직 없음, 매번 재계산). | 이 파일 자체는 dedup 키를 읽거나 쓰지 않음(caller인 `scheduled.ts`가 `promptState.firedTrainCodes`를 별도로 다룸, 위 표 행2 참조) | 이 파일 자체는 `lastLaPushEpoch`를 건드리지 않음 — **미확인**(caller `scheduled.ts`의 `attemptVanishSwap`/transfer-swap 호출부가 trip 객체에 반영할 때 리셋하는지는 호출부를 더 봐야 함, 위 표 행3과 동일 미확인 사유) |

**결론**: 지정된 4개 파일 중 **`lockSwap.ts`만 실제로 lock 필드를 합성**한다(나머지 3개는 후보 계산/읽기/표시 소비자). `lockSwap.ts`는 `boardedAt` 개념이 없는 backend 전용 타입을 다루므로 §4-1(진행도 역행)과 무관 — 그 위험은 여전히 device `createLock`(`useTransferTrainList.ts:245`, `useBoardingLockController.ts:311,478,569`) 쪽에만 있다. `segmentStations`는 `lockSwap.ts`에서 **승계가 아니라 매번 재계산**이다 — "승계해서 이미 해결된 문제"는 아니고, "재계산 결과가 우연히 올바른 값이 되는" 구조다.

## 4-개정. E1 거부 케이스 재분류

| # | 거부 케이스(1차) | 재분류 | 근거 |
|---|---|---|---|
| 1 | 진행도 역행 금지(`boardedAt`) | **E1 고유 — 조건부.** 기존 두 교체 경로는 "새 leg/새 트레인" 상황에서만 발생해 0-리셋이 의미상 맞다(§3-A 결론). E1이 "같은 leg 재탭"(보강/정정 탭)을 허용한다면 이때만 역행이 실제 버그가 된다. **E1 스펙에 "같은 leg 재탭" 케이스가 있는지가 유일한 분기점** — team-lead 확인 필요. | §3-A 표 행 1·4, `useTransferTrainList.ts:245`, `useBoardingLockController.ts:311,478,569` |
| 2 | LA push 게이트 재설정 금지(`lastLaPushEpoch`) | **E1 고유 — 기존 경로와 성격이 다르다.** 기존 `/boarding-lock/sync` 리셋(:2800-2804)은 "waypoint가 실제로 전진했을 때"만 실행되는 범용 동작이라 항상 정당(새 역이니 새 push 허용). E1의 `index.ts:2240` 가드가 풀리면 **waypoint 전진 없이(같은 역, 같은 leg) 리셋이 실행될 수 있다** — 이게 기존 경로에 없는 새로운 조합이다. **기각되지 않음, E1이 직접 처리해야 함.** | §3-A 표 행 2 vs 행 5, `index.ts:2298-2300` |
| 3 | 같은 trainCode 재선택 시 발사 거부 | **기각 쪽에 가까움, 근거 약화.** `firedTrainCodes`는 release로 clear되지 않는 별도 struct이고(§3-A 표 "dedup" 열), 기존 release→재생성 경로도 이미 이 구조를 거친다 — 즉 "release 후 같은 trainCode로 재승격"이 기존에도 가능한 조합이고 별도 사고 보고가 없다. E1이 이 조합을 새로 만드는 게 아니라 **기존에도 존재하는 조합을 더 자주 트리거**할 뿐. 1차 분류의 "중간" 위험을 "낮음"으로 하향. | §3-A 표 "dedup" 열, `boardingPrompt.ts:276,353` |
| 4 | device `boardingStationId` 불변 가드와 모순 | **E1 고유 — 유지, 설계 제약으로 전환.** §3-2 그대로. E1이 생성하는 새 lock이 3필드(trainCode/boardingLine/destinationId) 중 하나를 바꾸지 않으면 flag ON 환경에서 device가 조용히 거부한다 — **버그가 아니라 설계가 지켜야 할 제약**. | `useBoardingLockStore.ts:139-171` |
| 5 | disembarked/advance 책임 분리 유지 | **기존 경로에도 이미 존재하는 원칙(별건 아님, 참고용으로 하향).** `advanceBoardingLockWaypoint`도 release와 advance를 같은 함수 안에서 순서대로 하지만 "advance가 트리거 → release가 결과"라는 방향이 고정돼 있다. E1은 반대 방향("release/replace가 트리거 → advance는 건드리지 않음")이면 원칙과 충돌 없음 — **설계 가이드로 하향, 거부 케이스에서 제외.** | `index.ts:2191-2193`, `scheduled.ts:6117-6124` |

## 6. 🔴 단조성 가정 테스트 전수

grep 범위: `boardingLock`을 다루는 131개 테스트 파일 중 "이미 active lock" 계열 키워드로 좁힌 결과,
**정확히 이 가드를 기대값으로 박아둔 테스트 2건**을 찾았다(나머지 키워드 hit은 "once"/"교체" 같은
범용 단어의 false positive — 개별 확인 생략, 시간 제약).

| file:test명 | 무엇을 assert하는가 | E1에서 깨지는가 |
|---|---|---|
| `backend/alarm-worker/src/__tests__/index.test.ts:2862` `'이미 boardingLock 있는 trip → 재평가 안 함(fetch 미호출), 기존 상태 그대로 leg1 보고'` | `POST /trips/:token/boarding-confirm`에 lock이 이미 있는 trip으로 'boarded' 요청 시 `fetchSpy`(Seoul API 호출)가 **호출되지 않음**(`expect(fetchSpy).not.toHaveBeenCalled()`)과 `lockState: 'leg1'`을 그대로 보고 | **깨진다.** E1은 정의상 이 경로에서 재평가(필요시 fetch)를 하게 만든다 — 이 테스트는 **E1 구현 PR에서 반드시 수정(또는 "같은 트레인 재탭일 땐 skip, 다른 조건일 땐 진행" 분기 추가)해야 할 red 후보**다. |
| `backend/alarm-worker/src/__tests__/index.test.ts:5088` `'이미 boardingLock 있는 trip → tap-resolve 시도 안 함 (active lock 재평가 금지)'` | `POST /trips`(register-time) 경로에서 **동일한 가드**(`#1729`)를 검증 — lock이 있으면 `attemptBoardingAnchorResolution`의 fetch를 호출하지 않음 | **E1의 영향 범위 재확인 필요.** 이 테스트는 `boarding-confirm`이 아니라 **register-time** 경로(`resolveBoardingAnchorAtRegister`, `index.ts:299` 부근 — 1차 패스에서 본 다른 call site)를 검증한다. E1이 `boarding-confirm`만 바꾸면 이 테스트는 **안 깨진다** — 단, `#1729` 가드가 두 call site에 **동일 원칙으로 양쪽에 적용**되고 있으므로, E1이 "active lock 재평가 금지" 원칙 자체를 바꾸는 거라면 **이 register-time 경로도 같은 원칙 변경 대상인지 team-lead가 범위를 명시해야 한다** — 1차 패스에서 빠졌던 두 번째 call site. |

**추가로 확인한 것(E1과 무관, 참고)**: `useBoardingLockStore.test.ts:353` 및 `:379,:394`는 device
flag-ON 가드(§3-2)의 정/반 사례를 모두 커버하는 테스트 — trainCode/boardingLine 변경을 **허용**하는
사례가 이미 있으므로, E1이 이 3필드 중 하나를 바꾸는 방식으로 구현되면 **이 테스트들은 그대로
유효하다(안 깨짐)**.

## 5. 미확인 목록

**깊게 추적하지 못한 파일(개별 거동 미판정)** — 아래는 grep 적중 113개 중 §2에서 다루지 않은 나머지. 카테고리별로 대표 경향만 적고, 개별 file:line 판정은 하지 않았다(시간 제약):

- **backend 미추적**: `advanceTripPosition.ts`, `boardingAnchorResolver.ts`, `boardingPrompt.ts`(dedup 헬퍼 함수 본체 외 나머지), `progress.ts`, `tripRegisterRateLimit.ts`, `trips.ts`, `types.ts`(타입 정의만 — 거동 없음으로 간주 가능하나 미확인 처리). — **"판정" 축일 가능성이 높은 파일들(advance/progress)이라 가장 우선 추적 필요.**
- **device `src/features/alarm/` 미추적**: `useApnsTripRegistration.ts`, `useBoardingIntentPromotion.ts`, `useBoardingLockAutoRelease.ts`, `useBoardingLockController.ts`, `useBoardingLockSync.ts`, `useBoardingPromptResponder.ts`, `useDestinationAutoClear.ts`, `useSafetyNetScheduler.ts`, `useStationAlarm.ts`, `alarmLog.ts`, `alarmLogTelemetry.ts`, `boardingLockLifecycleBuffer.ts`, `boardingLockStorage.ts`, `boardingPromptContext.ts`, `destinationArrivalDetect.ts`, `duplicateBoardingLock.ts`, `fgArvlCdFastPath.ts`, `prescheduledMissContext.ts`, `refreshLiveActivityFromBackgroundContext.ts`, `safetyNetScheduler.ts`, `scheduledAlarmReceiver.ts`, `shouldSuppressBySleepRule.ts`, `stationAlarm.ts`, `stationPipeline.ts`. — **이름상 `useBoardingLockController.ts`/`useBoardingLockSync.ts`/`boardingLockLifecycleBuffer.ts`가 lock lifecycle 직접 소비자일 가능성이 높아 다음 우선순위.**
- **device `nearest-station`/`route` 미추적**: `useCurrentStationConfirmModal.ts`, `useNearestStation.ts`, `useStationMismatchDetector.ts`, `backgroundLocationTask.ts`, `candidateRejectBuffer.ts`, `fusionDebugBuffer.ts`, `fusionDistanceGate.ts`, `inferAutoLockCandidate.ts`, `inferEnvironment.ts`, `lockedStationGate.ts`, `movementGate.ts`, `pickFusionTier.ts`, `positionTrainConsensus.ts`, `useMisBoardingDetector.ts`, `useTrainCodeMismatchDetector.ts`, `useTransferAutoDetect.ts`, `useTransferTrainList.ts`, `approachLine.ts`, `arcEstimation.ts`, `detectMisBoarding.ts`, `findActiveTransferContext.ts`, `hopTime.ts`, `journeyAdapter.ts`, `journeyOrigin.ts`, `transferSwap.ts`. — **`transferSwap.ts`/`findActiveTransferContext.ts`는 기존 leg-transfer 교체 경로 본체일 가능성이 높아 §2 "무해(기존 선례)" 판정의 1차 근거가 될 파일이지만 직접 읽지 못했다 — 추정만 함.**
- **그 외**: `app/_layout.tsx`, `src/screens/HomeScreen.tsx`, `src/features/debug/components/DebugModal.tsx`(관측용, 소비자 아님으로 추정), `src/features/arrival/providers/progress/types.ts`(타입), `src/features/arrival/utils/pickCandidateTrains.ts`, `src/shared/constants/*.ts`(상수 정의, 거동 없음), `src/shared/utils/boardingWait.ts`, `src/shared/utils/stationLookup.ts`, `src/shared/utils/stationRoute.ts`, `src/shared/utils/transferTimes.ts`, `src/features/nearest-station/api/*.ts`(backendHttp/boardingLockSync/positionUpload), `src/testUtils/*`(fixture — 테스트 제외 대상이나 `fixtureChainRunner.ts`에 "단조성 가정 테스트"가 있는지는 미확인).
- **"단조성 가정 테스트" 존재 여부**: §특별히 확인할 것 6번(테스트 중 단조성 가정)은 **전혀 조사하지 못함** — `__tests__` 파일을 이번 조사에서 전부 제외했다(지시사항대로 소비자 목록에선 제외했으나, "단조성 가정 테스트 별도 수집"은 별도 grep이 필요했고 시간 내 수행 못함). 재조사 시 `grep -rn "boardingLock" **/__tests__/*.test.ts | grep -i "immutable\|once\|unchanged\|same lock"` 류로 시작 권장.
