# 게이트 전수 감사 — 개수·정합성·관측성 (2026-09-20)

backend(`backend/alarm-worker/src/`)와 device(`src/`)의 **모든 조건부 차단 지점**을 전수 열거하고 정합성을 판정했다. 게이트 = 이름에 gate가 없어도 행위(발사/lock/advance/프롬프트/종료)를 조건부로 막는 판정 지점 전부.

## 총계

| | backend | device | 합계 |
| --- | --- | --- | --- |
| 게이트 | ~35 | ~155 | **~190** |
| 관측 가능(D1/로그/카운터) | 24 | ~78 | ~102 |
| **조용한 억제**(관측 전무) | 7 | ~77 | **~84** |
| 정합성 문제(확정) | 3 | 11 | **14** |

**게이트의 44%가 차단 사실을 아무 데도 남기지 않는다.** 9/18 목적지 통과에서 7겹이 전부 조용히 막아 "왜 계속 안 되는지" 알 수 없었던 것이 이 구조의 직접 결과다.

## 경로별 AND 겹수 — 같은 목적에 1겹과 19겹이 공존

### backend
| 경로 | AND 겹 |
| --- | --- |
| lock 활성 매역 알림 | 11~13 |
| lock 활성 transfer/destination | 12 |
| lockless — `tryFireConsensusTrainLeg`(C OFF) | **19** |
| lockless — `runLocklessIntermediate`(C ON) | 6 |
| **lockless — `runLocklessTransfer`/`runLocklessDestination`** | **1** |
| boarding-prompt GPS | 11 (9단 전개 시 19) |
| boarding-prompt GPS-free origin | 8 |
| boarding-prompt leg-2 | 3 |
| leg-2 자동 lock (cron) | 8 |
| 목적지 확정 — lock 활성 | 11 |
| 목적지 확정 — lockless | 4 |

### device
| 경로 | AND 겹 |
| --- | --- |
| FG phase 알람 (Path D) | 15 |
| FG station-passed GPS (Path A) | 14 |
| FG arvlCd fast path (Path B) | 11 + movement 의도적 우회 |
| FG subsurface (Path C) | 8 (movement 게이트 자체 없음) |
| BG 알림 | 선행 7 + 경로별 6~9 — **단 `isMinimalAlarmEnabled()` OFF로 전부 도달 불가** |
| boardingPrompt 로컬 | 7 (동일 플래그로 비활성) |
| lock 생성 | **3 / 6 / 7 / 6** (경로 4종 제각각) |
| fusion 후보 채택 | 6~9 |

한 번의 매역 알림이 backend 11~13겹 + device 14~15겹 = **약 25~28겹의 AND**를 통과해야 한다.

## 정합성 문제

### ① 약속됐으나 미배선 (4건 확정)

주석·문서가 "caller가 X를 검증한다"고 적어놨는데 그 호출이 없는 것.

1. **`evaluateConsensusGate` caller 미배선** (#2641, 기존) — `boardingPrompt.ts` 3곳이 "caller(scheduled.ts)가 별도 검증한다"고 명시. 호출 전수는 `advanceTripPosition.ts:510` 1곳, `scheduled.ts` **0건**. `advanceTripPosition.ts:11`이 스스로 "호출자 미적용"이라 적음.
2. **`evaluateConsensusGate`의 `archFlag` 인자 미전달** (신규 확정) — 시그니처는 3번째 인자 `archFlag?`를 받고 내부에 `if (archFlag === 'on') return {pass:true}`(`consensusGate.ts:157`)가 있는데, 유일 호출부(`advanceTripPosition.ts:509-516`)가 **2인자만** 넘긴다. 프로덕션 KV는 `archFlag='on'`인데 **이 게이트만 그 사실을 못 받아** 항상 환경별 N-of-M을 완전 평가한다 → 설계 의도보다 **과하게 막는다**. 앞의 `envConsensusBypass`는 arvlcd-confirmed-train 용이라 별개.
3. **`silentPushLocationGate` 고아** (신규 확정) — `src/` 전체에서 실제 import/호출 **0건**, 주석에서만 6회 언급. 코드가 "이 게이트가 처리한다"고 적어둔 것을 아무도 호출하지 않는다.
4. **`evaluateLocalBoardingPromptGate`의 `reason` 폐기** (신규 확정) — 게이트가 실패 사유를 반환하는데 호출부(`useLocalBoardingPromptGate.ts:66`)가 `if (!outcome.pass) return;`로 버린다. 관측 인프라가 만들어져 있는데 배선이 끊겼다.

### ② 모순 — "lock 활성"이 공유 헬퍼 없이 최소 26곳에 독립 재구현 (확정)

**`isLockActive()` 공유 헬퍼가 존재하지 않는다.** 세 가지 다른 표현이 통용된다:
```
currentLockTrainCode !== null     1곳   (가장 좁음 — trainCode 미확정 lock은 false)
boardingLock != null             13곳
lock != null                     12곳
```

그리고 **같은 함수 안에서 두 줄 연속 반대 의미**로 쓰인다 (`fusionDistanceGate.ts:70-73`):
```ts
if (accuracyMeters == null) return lockActive === true;      // lock → 면제 (#1612)
if (!lockActive && accuracyMeters > MAX_ACCURACY_M) return false;  // lock → 엄격 검사로 진행 (#1016)
```

극성도 갈린다 — 대부분은 lock을 **면제 근거**로 쓰지만, `triggerTripEndRecall.ts:300`은 lock이 있으면 recall을 **차단**하고, `destinationArrivalDetect.ts:122`는 `!lockActive`면 기능 자체를 끈다.

**`#2711`(면제가 trainCode 있는 lock에만 걸림)은 이 구조의 증상이지 원인이 아니다.** 같은 패턴이 `useStationAlarm.ts` 3곳(1153/1195/1314)에 전파돼 있고, fg-arvlcd fast path(`:1661`)는 `isLocklessNoUserIntent` 헬퍼를 경유하지 않는 raw `!lock` 체크라 **같은 파일 안 3개 station-passed 경로 중 이것만 면제 범위가 좁다.**

### ③ 모순 — 자동 lock 채택 경로의 신뢰 정책이 정반대 (확정)

같은 파일 `useBoardingLockController.ts` 안에서:
- `:246-249` backend lockSuggestion 자동 hydrate — 주석: "backend가 이미 합의했으므로 arrival 매칭·motion 게이트 **불필요, 명시적 우회**"
- `:469-493` device auto-detect(#924) — Gate1(arrival 매칭)·Gate2(motion) **필수 요구**

둘 다 "무탭 자동 채택"인데 기준이 반대다.

### ④ 모순 — 같은 신호를 다른 신뢰 맥락에 동일 문턱으로 적용 (확정)

`runLocklessTransfer`/`runLocklessDestination`(`scheduled.ts:6389-6416`, `6441-6469`)은 **`advanceTripPosition`을 아예 호출하지 않고** arvlCd ENTERING/ARRIVED 단일 신호로 `completeWaypointAdvance` 직행 — **AND 1겹**. 반면 lock 활성 경로(`tryAdvanceAndFireArvlcd`, `:4275-4297`)는 같은 일에 8게이트를 통과한 뒤의 lock 소유 확증까지 갖는다. 코드 주석은 "lock-active도 같은 단일 신호를 쓴다"고 정당화하지만, **lock-active는 그 신호 앞에 8겹이 있고 lockless는 없다.**

### ⑤ 중복 목적

- **dedup 계열 backend 9종** (과거 "7종 sprawl"보다 증가): `arvlCdFireKey`(1h) / `stationPassedFiredKey` / `arvlcdFireOnceTtl`(5분, flag) / cross-station(`SAME_PHASE_STATION_DEDUP_WINDOW_MS`) / vanish 2종 / `hopEndPromptFiredKey`+`trip.hopEndPromptState` 이중 / `rescheduleDedup`(5분) / `evaluateBoardingPromptRepeatGate` / `AUTO_PROMPT_DEDUP_WINDOW_MS`(30분)
- **dedup 계열 device 7종**: `lastNotifiedStationId` / `isStationRecentlyFired`(30s) / `isTripScopedCrossCategoryRecentlyFired`(5s) / `isPhaseToPhaseCrossStationRecentlyFired`(3s) / `isAnyChannelRecentlyFired`(8min) / `evaluateSsotFireGate` / `fireAlarmOnce`(30s, flag)
- **accuracy 컷 5곳 독립 정의**: `movementGate.MAX_ACCURACY_M` / `gpsQualityGate.GPS_QUALITY_GATE_MAX_ACCURACY_M` / `location.MAX_ACCURACY_M` / `surfaceSSotConsensus.GPS_ACC_MAX_M=30` / `stickyStationGates.STICKY_GOOD_FIX_ACCURACY_M`
- **속도 튐 판정 2종**: `locationGates.isPlausibleJump` vs `movementGate.isImplausibleSpeedSpike`

정책 하나를 바꾸려면 9~16곳을 손대야 한다.

### ⑥ 도달 불가

- **`isMinimalAlarmEnabled()`(기본 OFF)가 BG 발사 3모듈 전체를 막는다** — position-train-lock(#2383) 9겹 / waypoint arvlCd(#2480) 7겹 / underground consensus(#2381) 6겹이 프로덕션에서 전부 dead. 5곳에서 같은 플래그를 중복 확인(belt-and-suspenders). **의도된 dogfood 게이팅이라 결함은 아니나**, BG 알림이 전적으로 backend push 의존이라는 사실을 뜻한다. `silentPushTask`의 표준 역 종류는 #2064로 **영구 봉인**.
- `evaluateConsensusGate`의 archFlag bypass — 위 ①-2.

## 조용한 억제 — 밀집 지점

| 위치 | 개수 | 왜 중요한가 |
| --- | --- | --- |
| `useBoardingLockController.ts` | **16** | **"왜 이 사용자에게 lock이 안 걸렸는가"를 사후 재구성할 방법이 전혀 없다.** lock 생성 4경로 어느 것도 개별 게이트 실패를 남기지 않는다 |
| `useStationAlarm.ts` | ~20 | 878(in-flight), 1488(accuracy, station-passed), 1661(lock 부재, fast path) 등 |
| backend boarding-prompt 9단 전체 | 1블록 | 코드 주석이 자백(`scheduled.ts:7481`) — D1 없이 wrangler tail 실시간 스트림으로만. **과거 재현 불가** |
| fusion consensus 3파일 | ~11 | `positionTrainConsensus`/`surfaceSSotConsensus`/`undergroundSSotConsensus` 파일 자체 무로그 |
| `fireVanishFallbackStationPush`의 transferDestinationGate block | 1 | 같은 게이트 함수인데 `tryAdvanceAndFireArvlcd`는 D1 기록, 이쪽은 log만 — **관측 비대칭** |

## 권장 순서

**1단계 — 관측 (동작 변경 0)**
차단 사실을 남기지 않는 게이트가 84개다. 이 상태로는 어떤 라이드도 원인을 확정하지 못한다. 이 레포의 기존 룰("원인 확정 전 동작 변경 금지", #2723 요구사항 1)과도 정합. 우선순위: lock 생성 16곳 → boarding-prompt 9단 D1 → `useStationAlarm` 무로그 20곳.

**2단계 — 배선 (4건, 작고 명확)**
①의 4건. 전부 "약속이 코드에 적혀 있는데 이행 안 됨"이라 판단 여지가 적다.

**3단계 — `isLockActive()` 통일 (구조)**
공유 헬퍼를 도입하고 26곳을 수렴시킨다. **#2711이 자동 해소된다** — 증상이 아니라 원인을 고치는 것. 극성이 다른 3곳(`triggerTripEndRecall`/`destinationArrivalDetect`)은 의미를 명시적으로 구분해 별도 이름을 준다.

**4단계 — AND 겹수 정합 (결정 필요, 구현 아님)**
lockless transfer/destination 1겹 vs lock 활성 11겹을 어떻게 맞출지는 **결정 사항**이다. 올리는 방향(안전)과 내리는 방향(알림 확보) 중 무엇이 ADR-010("두 실패 모드 동급")에 맞는지 근거가 필요하다. dedup 16종 통합도 같은 단계.

## 미검증 영역 (정직하게)

backend: `scheduled.ts` 5035-5330(`runTrainCodeTracking`/`estimateBoardingLockArrival`), 4815-5035(`handleEtaMissing`), 6046-6219(`maybeReschedulePush`), 2708-3123(sleep/prepare alarm), 8100줄 이후 — **미독**. 특히 `handleEtaMissing`은 임계 게이트가 몰린 곳이라 추가 감사 가치가 높다. `index.ts`는 register-time 게이트 호출부만 grep 확인.

device: `pickFusionTier.ts`/`candidateRejectBuffer.ts` 상세 미독(fusion 겹수는 추정). accuracy 상수 5곳의 **실제 값이 다른지는 대조 안 함**(중복 정의 위험만 확정).

총계 ±10 오차 가능 — "게이트"의 경계 정의에 따라 달라진다.
