# 주석 속 불변식·한계 카탈로그 (INVARIANTS)

> **용도**: 코드 주석에만 살아있는 규칙·전제·함정의 색인. **해당 영역을 건드리는 RCA/스펙/fix 전에 그 섹션을 먼저 읽는다.**
> **승격 룰**: fix 작업이 load-bearing 불변식(강제: 없음/부분)을 밟으면, 그 fix PR에 해당 불변식을 assert하는 테스트(가능하면 whole-trip replay)를 **같이 승격**한다 — 주석만 남기고 지나가지 않는다.
> **주의**: 라인 번호는 2026-09-30 `dev@020463ec` 기준 point-in-time — 어긋나면 요약 키워드로 재검색. 이 문서는 원문 사본이 아니라 **포인터**다(원문은 항상 코드가 SSoT).
> 생성: 2026-09-30 주석 전수 스윕(backend / device alarm+LA+Swift / device fusion+shared 3갈래). 갱신: 스윕 재실행 또는 fix 시 해당 항목 갱신.

표기 — `[불변식]` 어기면 안 되는 규칙 · `[갭]` 알려진 미구현/한계 · `[함정]` 과거 회귀/조건부 지뢰. `강제:` 어기면 실패하는 테스트/린트 존재 여부.

---

## 1. Backend (alarm-worker)

| 위치 | 종류 | 요약 | 강제 |
|---|---|---|---|
| scheduled.ts:3474 | 불변식 | advance 미성공 시 fire path 진입 금지(조기 return) | 있음 |
| scheduled.ts:1621 | 불변식 | 열차 미선택/lock 만료 trip은 fire 제외 | 부분 |
| scheduled.ts:5615 | 불변식 | `promptDisplay`는 stampCurrentLegAnchor 외부에서 불변경 — leg-1 프롬프트 사망 방지 | **없음** |
| scheduled.ts:7628 | 함정 | isNearOrigin은 부재 시 false → "존재 AND 멀다" 분리 판정 필수(#2532) | **없음** |
| scheduled.ts:3780 | 함정 | staleMs는 #2764 후 상시 무의미 — 사후 확인용만 | 없음(자인) |
| boardingPrompt.ts:245 | 불변식 | caller가 evaluateConsensusGate 2-of-2 합의 별도 검증 필수 | 부분 |
| apns.ts:962 | 불변식 | boarding-prompt push 최상위 키는 `body`(expo iOS 파싱 계약) | 있음 |
| trips.ts:52 | 함정 | verifyBoardingLockPersisted — /boarding-lock/sync 전체 400 fail 함정 재발 가능 | **없음** |
| trips.ts:472 | 한계 | register-lock 큐는 같은 isolate 내만 직렬화 — cross-isolate 무방비(DO 미도입) | 없음(구조) |
| trips.ts:39-53 | 함정 | cron read cacheTtl 30s = KV 최소값 — putTrip 직후 read stale 창 구조적 존재. lock만 read-after-write 보호. boarding-prompt(leg-1 GPS-free/leg-2/GPS 9단 3경로 전부, #2838)·hop-end(#2672)는 trip 객체 무관 독립 fire-once KV 마커로 방어됨. 그 외 SSoT 마커는 여전히 무방비 | 부분(boarding-prompt만, boardingPromptFireOnce.test.ts) |
| index.ts:289 | 불변식 | cron은 allowLegTransfer 없이 호출 — leg-2 조용한 승격 금지(answer-driven) | 있음 |
| index.ts:1389 | 불변식 | POST /position에서 **마커**(`markTripRegistered` 등 관측 신호) stamp 금지(#2450 throttle 보호) — **TTL(수명) 연장과는 다른 축**: #3047이 `extendTripExpiryViaPosition`(index.ts, `stampOriginProximityIfNeeded` 다음 정의)으로 /position에서도 조건부(잔여 TTL<`TRIP_ACTIVITY_MIN_REMAINING_MS`) 1회 putTrip을 허용했다 — BG-only 라이드(화면 꺼짐)의 유일 채널이 sliding TTL 연장에서 빠져있던 미보호를 해소. 마커 무조건 stamp 금지는 여전히 유효, TTL 조건부 연장만 예외 | 있음(positionTtlExtension.test.ts 쿼터 산술 케이스) |
| index.ts:2864 | 함정 | KV read-modify-write는 CAS 없음 — 동시 갱신 stale 덮어쓰기 race 창 | 없음(구조) |
| motionState.ts `SSOT_MOTION_WRITE_MIN_INTERVAL_LOCK_MS` (#3006 PR-6) | 불변식 | **LOCK(`isBoardingLockActive`) trip의 motionState·motionEvidence는 저밀도(>=90s)** — 새 reader를 붙일 때는 LOCK 우회 필수. LOCK=false(lockless/환승 공백/만료 lock)는 25s | 있음(positionLockSsotThrottle.test.ts 'evidence 밀도') |
| tripPositionSsot.ts:186 | 불변식 | 이 모듈은 lock 승격 절대 안 함 — device useLockSuggestion만 소비 | 부분 |
| promotePendingLockFromConfirm.ts (#3055) | 불변식 | **PENDING→실 열차 승격 채널은 2개이며 유래가 다르다**: ① `useLockSuggestion`(lockSuggestion mirror) = 관찰 유래·polling·lock 활성 시 null(`advanceTripPosition.ts` lockActive), ② boarding-confirm 응답 `resolvedTrainCode` = 표명 유래(device 자신의 탭에 대한 권위적 회신). ②는 **이번 응답 사이클이 만든 PENDING일 때만**(`tryAutoLock.createdPending`, store 재조회로 boardedAt 대조) 그리고 **현재 store lock이 PENDING일 때만** 교체 — skip 분기에서 남은 이전 탭의 stale PENDING·실 lock·lock 부재·응답 없음은 no-op, boardedAt·evidence 보존. backend는 `KEPT_LOCK_ECHO_ALLOWED`(Record 전수 매핑, 새 reason 추가 시 컴파일 에러)에서 기존-lock echo를 no-anchor/already-correct-leg로만 허용하고 `lock.line === 탭 line`일 때만 싣는다. `resolveTier`는 **저장 필드가 아니다**(소비자 0·D1 meta가 SSoT) — 승격 lifecycle entry(source=`boarding-confirm-response`)와 `recordPendingLockPromotion` 로그에만 실리며, 부재 = 일반 tier·live resolve 응답에만 존재. device 실 lock ≠ 응답 resolvedTrainCode면 교체하지 않고 logger(`confirm response ignored`)로 관측만 남긴다 | 있음(index.test.ts '응답 확장', tapRoundtrip.test.ts, promotePendingLockFromConfirm.test.ts, replay_20261018_assertion_departed) |
| boardingAnchorResolver.ts:36 | 불변식 | 틀린 열차 lock 절대 금지 — 이 모듈의 존재 이유 | 있음(replay_20261018_assertion_departed.test.ts ⓓⓔⓕⓘ — stale/반대방향/ARRIVED 우선/복수 후보 ambiguous, #3056) |
| boardingAnchorResolver.ts:126 | 갭 | staleness 상한 의도적 보류(N=1 편향 우려) | 없음(의도) |
| boardingAnchorResolver.ts `assertionMode` 최후 tier (#3056) | 갭 | 탑승 표명 경로가 앵커 정위치 fresh(120s) DEPARTED 단독을 lock한다. 사용자 열차가 아직 앵커에 안 잡히고 같은 방향 선행 열차 1대만 120s 내 DEPARTED로 남으면 **틀린 열차 lock 가능**(ambiguous는 2대+만 차단). 신규 창 도입은 :126 보류와 충돌해 코드로 막지 않았다. 결정: D1 `boarding-confirm-result.meta.resolveTier='assertion-departed'` 라벨로 배포 후 24h backfill 오수용률을 측정한 뒤 창 재조정 여부를 정한다. 결합 효과: #3057 도착확정 발사는 탭 시점을 열차 이벤트에 앵커해 이 창을 구조적으로 좁힌다 | 부분(라벨 측정 대기, 창 재조정 미결정) |
| liveActivity.ts:11 | 불변식 | ContentState 필수 3필드(stationName/lineName/lineColorHex) backend가 항상 채움 | 있음 |
| liveActivity.ts:434 | 함정 | 'la-stale-backstop'은 backend 내부 식별자 — 외부 enum 노출 금지 | **없음** |
| advanceTripPosition.ts:716 | 함정 | consensus-tick D1 append는 전이 시에만(#2073 quota) | 부분 |
| lockSwap.ts:15,90 | ~~불변식~~ → **거짓 근거, 재사용 금지**(#2944 H-6 정정) | ~~direction=null이어도 wrong-direction 열차 pool 배제~~ — 틀렸다. 구 주석은 "추론 불가 노선(1/5/gyeongui)에서는 direction=null fallback → stationName + segmentStations 인덱스 필터로 진행 방향 implicit 해소(기존 동작 유지)"라 적었지만, 그 인덱스 필터(`arrivalsFromPositions.ts:111-129`)는 **"경로상 어느 역에 있는가"만 보고 방향(`isUp`)은 전혀 보지 않는다** — 10/9 반대 방향 lock 사고(군자→광화문, 5호선, 5559=마천행 하행)에서 반대 방향 열차가 탑승역 그 자리(segmentStations[0])에 있어 이 필터를 그대로 통과했다. `legDirection.ts:75`의 "segmentStations.length<2 → null(동일 역) → **안전**"도 같은 계열의 거짓 근거 — null은 양방향 허용(fail-open)이므로 안전이 아니다. #2944가 `pickAutoTrainCode`/`synthesizeArrivalsFromPositions`/`freshCandidatesAtAnchor`/`restrictArrivalsByLegDirection`/`fireBoardingPromptForAnchor` decisionPool 전부를 fail-closed로 전환해 이 근거가 의존하던 전제 자체를 없앴다 — **"implicit 해소로 안전하다"는 근거로 새 fail-open을 만들지 말 것.** segmentStations.length<2(트립 꼬리)는 `lockSwap.ts:resolveLegOriginStation`이 leg 앵커(`currentLegAnchor`/`originStationName`)로 보강하고, 앵커도 없으면 fail-closed(후보 0건)로 수렴한다 | 있음(boardingPrompt.test.ts/arrivalsFromPositions.test.ts/boardingAnchorResolver.test.ts/scheduled.test.ts `restrictArrivalsByLegDirection` describe — #2944) |
| fallback.ts:67,139 | 함정 | stale-intermediate 체크가 implicit-ACK보다 **먼저** — 순서 뒤집히면 회귀 관측 자체가 죽음 | 부분 |
| alarm.ts:41 | 불변식 | ARRIVAL_CODE 숫자 우연 일치해도 타 코드체계 재사용 금지 | **없음** |
| scheduled.ts:7405 | 불변식 | 프롬프트는 임박 열차 있을 때만 발사(#2801 재발 방지, arvlCd∈{0,1,2} OR-fallback) | 있음(#2834 + replay_20260930_leg2_prompt) |
| ~~boardingPrompt.ts:176 / scheduled.ts:6842~~ | (해소, #2844) | ~~boarding-prompt "임박" 게이트 정의 2벌 공존~~ — GPS 9단 경로(`evaluateAndMaybeFireBoardingPrompt`/`hasArrivedSignal`)를 subsumption 증명 기반으로 은퇴시켜 게이트 정의가 공유 본체(`decideBoardingPromptFire`, boardingPrompt.ts) 단일화로 수렴. leg-1(`maybeFireOriginBoardingPromptGpsFree`)/leg-2 모두 이 하나만 사용 — drift 재발 불가(구현 자체가 삭제됨) | N/A (게이트 자체 삭제) |
| liveActivity.ts:364 | 갭 | (#2857 확인) device가 보내는 DELETE는 reason 없음 → `writeTripEndedStatus` 미기록 → FG `tripDeathPullBackstop`이 404를 "alive"로 오판(:122-125)해 후속 정리가 영구 스킵될 수 있다. backend DELETE reason 정책은 의도적으로 무변경(#2857 스코프 — device측 안전망이 chokepoint를 경유하도록 고치는 것으로 이 사각의 실제 노출 빈도를 줄였을 뿐, 사각 자체는 여전히 존재) | **없음** |
| ~~scheduled.ts completeWaypointAdvance~~ | (해소, #2861 T3) | ~~lock-경로 advance(`advanceBoardingLockWaypoint` evidence=undefined, 실 production 호출: `/boarding-lock/sync`가 transfer/destination waypoint 처리 시, index.ts:2619-2629)가 SSoT.alarmEvents 미stamp~~ — `tripPositionSsot.ts`의 `stampPassedStationAlarmEvent` 공유 헬퍼로 lockless(`advanceTripPosition.ts`)와 동일 stamp 추가. 신규 advance 경로를 추가할 때는 반드시 이 헬퍼를 거쳐야 DebugModal Whole Chain backend 칼럼이 [none]으로 비는 재발을 막는다 | 있음(scheduled.test.ts #2861 T3 2건) |
| scheduled.ts `fireBoardingPromptForAnchor` (origin/leg 공통) | 불변식(#2944 H-6 신설) | direction===null의 두 근원 구분 — ①구조적 unavailable(nextWaypoint 없음/cross-line, `directionUnavailable=true`)은 fail-open 유지(line-only), ②inferLegDirection을 실제 호출해 null(동일역/매핑 miss)은 fail-closed. ①을 fail-closed로 합치면 트립 꼬리/route 재계산 경계에서 leg-1/leg-2 boarding-prompt가 영구 미발사되는 과차단 — ②를 fail-open으로 합치면 10/9류 반대 방향 lock 재발 | 있음(scheduled.test.ts `maybeFireOriginBoardingPromptGpsFree` "다음 waypoint가 다른 line"/"waypoints가 빈 배열" 2건, #2944) |
| boardingAnchorResolver.ts `attemptBoardingAnchorResolution`(nextWaypoint.line !== anchor.line) | 확인됨(#2944 ⓖ 판정, 과차단 아님) | `nextWaypoint.line !== anchor.line`일 때 direction=null이 되지만, 그 이전에 `buildLegSegmentStations`가 첫 waypoint에서 line 불일치로 즉시 break해 `legSegment.length===0` → `noneReason:'leg-segment-empty'`로 **direction 계산에 도달하기 전에** 이미 종료된다. 즉 이 케이스는 H-6의 fail-closed 전환이 새로 만드는 과차단이 아니라 기존에 있던 별도(더 이른) 게이트 — direction 값과 무관하게 항상 후보 0 | 있음(boardingAnchorResolver.test.ts "waypoints[0].line이 promptDisplay.line과 다름" 기존 테스트가 이미 고정) |
| scheduled.ts `runLocklessTransfer`/`runLocklessIntermediate` | 갭 | **#2926** (추적 이슈, #2921 PR #2924 `it.fails`의 추적처) — lockless leg 전진 candidate 제한(direction 필터ⓐ+모호후보 차단ⓒ)은 두 함수 모두에 적용했으나, 시간창 게이트(ⓑ, `legBoardingEligibleAt`)는 **destination에만** 적용했다(9/18 실측 재생이 transfer/intermediate 적용 시 정상 완주 트립 과차단을 반증). 그 결과 "leg가 막 시작된 직후, 같은 방향으로 가는 단일(틀린) trainCode"가 intermediate/transfer를 잘못 통과시킬 수 있는 잔존 위험이 남는다 — ⓒ는 **복수** 후보만 모호로 보고, 단일 틀린 후보는 걸러내지 못한다(audit-sides 감사, PR #2924 본문) | 부분(scheduled.test.ts `it.fails` — "(알려진 잔존 위험, 미해결) leg 시작 직후 단일 틀린 trainCode의 intermediate 통과를 ⓒ는 막지 못한다", S-2921 describe 하단, 주석에 **#2926** 링크 + ⓐ현재동작/ⓑ미해결 이유/ⓒ승격조건 명시. #2926 해결 후 이 테스트가 green(일반 `it`)으로 승격되면 갭이 해소됐다는 신호) |
| index.ts:1331-1332 same-session merge(promptGeoContext/promptDisplay 보존) + device `useApnsTripRegistration.ts` Tier1/2 | 함정 | Tier1/2 context-heal은 로컬 GPS 휴리스틱(Tier1=currentStation 전환 필요, Tier2=null+지하 한정, 상호배타)으로만 트리거 — **backend 저장본의 실제 context 소실은 양쪽 트리거 밖**(register 응답이 저장 결과를 echo하지 않음: `{ok,token,confirmedEnv}`뿐). #3042가 same-session 재등록 소실 자체를 막아 노출 빈도를 줄였으나, new-session 첫 등록이 context-null이면 여전히 heal 휴리스틱만이 안전망이다(10/18 RCA) | 부분(#3042 테스트 — same-session만) |
| `MINIMAL_ALARM` 보류 소비자 (`useStationAlarm.ts:1114-1121` · `stationPipeline.ts:611`·`:733` · `stationNotification.ts` `fireLocalAlarmNotification` 본체 · `debugFlags.ts` 플래그 본체) | 함정 | ADR-040 결정 7=(b)로 dormant 발사 모듈은 #3063에서 철거됐으나, 이 소비자들은 #3035 결정(ⓐ/ⓑ/ⓒ)이 소비처 처분을 정하기 전까지 보류한다 — 플래그는 항상 false라 dead 경로이며, 해제 조건 = #3035 결정 후 PR-D2(보류 블록 + 플래그 본체 제거). 함께 남은 `stationNotification.ts` `isRecentLocalBoardingPromptDuplicate` 가드도 마킹 지점이 소멸해 항상 false인 **의도된 잔존**(`LOCAL_BOARDING_PROMPT_FIRE_KIND` 삭제 금지) — PR-D2에서 정리. 이 가드는 완전히 죽은 상태다 — presched `kind`는 transfer/destination/station-passed만(`stationPipeline`의 `PrescheduledKind`), `mapBackendKindToLocalFireKind` 키도 StationWaypointKind뿐이라 `'boarding-prompt'` 마킹 경로가 0이다. **반쪽 상태 경고**: `EXPO_PUBLIC_MINIMAL_ALARM`은 빌드타임 env라 로컬 빌드에서 켜면 보류 블록(`stationPipeline.ts:608`/`:728`, `useStationAlarm.ts:1114`)은 발사하는데 movement 우회(`:503/:636`)·LA 권위 override(`liveActivityPushChannel` flag 피연산자)는 #3063으로 사라진 반쪽 상태가 된다 — **PR-D2(#3035 결정 후) 완료까지 절대 켜지 말 것** | 없음 |
| stationPipeline.ts `evaluateBgHopWindowGate`(#2478 G0-3c) | 갭 | 존재 이유가 철거된 발사 경로(#3063)였고, 유일한 whole-chain replay(`stationPipeline.hopWindowLockBypass.dumpReplay`)도 함께 삭제돼 **mock 단위 테스트만 남았다** — whole 커버 부재. PR-D2 철거 후보(코드 변경 없음, 이번 PR 범위 밖) | 부분 |
| renumberSuccessor.ts `lookupRenumberSuccessor` | 불변식(#3158) | 번호 변경 후속 판정은 시각(시간창)에 의존하지 않는다 — 저녁 실측은 시간표 대비 +8~+16분 어긋난다(10/28 3286->3324 +14분, 아침은 +-2분). 시간표 키는 항목이 1개뿐(평일 448·주말 373키 전수)이라 후속이 유일하고, 오발은 시각이 아니라 leg 게이트(G1 성수 leg / G2 방향 / G3 인접성 / G4 leg당 1회)로 막는다. 키당 항목이 2개 이상이 되는 시간표 갱신이 오면 이 가정이 깨진다 | 있음(renumberSuccessor.test.ts 키당 1항목 데이터 불변식 + replay_20261028_trip180 whole-trip) |
| renumberSuccessor.ts `checkRenumberLeg` / `decideTimetableReattach` | 불변식(#3158) | 시간표 재부착은 leg 방향과 일치해야 한다 — 후속의 시간표 방향이 leg 방향과 다르면(10/3 3174->3212, 내선 후속 vs 외선 leg) 재부착·유예·정정 표식 모두 끈다. leg 방향 미상은 fail-closed. 후속은 성수 또는 leg 방향 다음 역에서 관측돼야 한다 | 있음(replay_20261003_seongsu_euljiro: timetable-successor 행 0 + 단위 사유 assert) |
| renumberSuccessor.ts / `lockSwap.ts` vanish-swap | 함정(#3158, #3161 결정) | #3161 결정 "번호가 바뀌어도 같은 열차를 따라간다"가 시간창 때문에 저녁에 꺼져 있었다(10/28 vanish-swap 3286->2288, 뒤 열차). 번호 변경 leg에서 vanish-swap 후보는 같은 방향 뒤 열차일 수 있다 — picker가 99-only 후보에서 첫 후보를 고르는 모호성은 별도(#3158 PR-2 C). vanish-swap 존속 자체는 U4(ADR 초안) 결정 대상 | 부분(trip 180 replay로 시간표 경로만 강제, picker 모호성은 미강제) |

## 2. Device — alarm / Live Activity / Swift

| 위치 | 종류 | 요약 | 강제 |
|---|---|---|---|
| SubwayActivityAttributes.swift(2벌):5-10 | 불변식 | ⚠️MIRROR 사본 2벌 동시 갱신 필수(pod ↔ widget _shared) | **없음(Swift CI 부재)** |
| LiveActivityManager.swift:198-201 | 함정 | 활성 Activity kill 금지 — adopt(update만). kill-recreate는 tripToken 전환 시만(#2806) | 부분(JS쪽 replay_20260930_bg_la_kill만) |
| LiveActivityManager.swift:76-78 | 갭 | `.stale` Activity도 표시 중 — adopt 후 freshen 필요 | 없음 |
| BoardingIntents.swift:12-16,44-48 | 함정 | App Group suite/key JSON 계약 + ALARM_BACKEND_URL 리터럴이 JS/eas.json과 수동 동기화 | **없음** |
| SubwayWidget.swift:226-228 | 함정 | trip 19분+ stale 노출 회귀 → savedAt 자율 stale감지 | 없음 |
| useEnsureLiveActivity.ts:18 | 불변식 | BG에서 LA start 절대 금지(iOS 거부) — AppState≠active면 no-op | 있음 |
| liveActivityPushChannel.ts:70-73 | 불변식 | LA 세션은 항상 단일(activeTeardown 1개) | 있음 |
| liveActivityPushChannel.ts `reconcileLiveActivityToken` (#3162) | 불변식 | trip 활성 + LA 존재 → backend가 그 LA의 **현재** push token을 가진다(173 유령 LA: 등록 0건). 다음 기회(FG 복귀·LA update/adopt tick·trip register ack)마다 native 재조회로 복구, 토큰 불가 시 **두 번째 kill-recreate**(첫째=tripToken 전환 `ensureLiveActivityRegistered`) — **FG 전용·유예 15s·쿨다운 120s·dismiss sentinel 존중**(BG start 금지), 재생성 시 `backendConfirmed` 해제. BG-only trip은 mirror sync·BG refresh(=silentPushTask) 진입점이 **data 없이**(재생성 없이) reconcile 호출, backend가 토큰을 몰래 지운 경우는 `GET /trips/:token/status`의 `hasLiveActivityToken===false`(필드 부재=구 backend 무동작)로 dedup 해제. **`ACTIVE_TRIP_KEY`=기기 APNs token이라 모든 trip이 같은 값** — 종료 레이스 가드(`lastEndedTripToken`)는 token 값이 아니라 다음 trip register ack(`acknowledgeTripRegistration`)로 해제. cleanup의 native 종료는 `resetLiveActivityChannelAfterExternalEnd`로 권위 상태 정리. 종료 teardown은 **종료되는 trip에 묶인 등록만** 취소(trip 무관 전부 취소하면 새 LA 토큰 유실). `.ended`(시스템 종료)는 user dismiss 아님 — `.dismissed`+`!expectingSystemEnd`만 sentinel(LiveActivityManager.swift handleObservedEnd) | 있음(liveActivityTokenInvariant.test.ts, modules/live-activity nativeContract.test.ts) |
| liveActivityPushChannel.ts `shouldSkipDeviceLiveActivityWrite` (#2735 PR-4, ADR-049) | 불변식 | 3-state 권위 게이트 — **등록 확인(영속 `LA_BACKEND_CONFIRMED_TRIP_KEY`) + lock + 마지막 유효 silent push 수신 공백 ≤ T(10분)**일 때만 backend 단독 저자(D1·D2·D3·D4·D6 skip). 등록 시각은 입력이 아니다. token-missing 응답은 등록 확인을 지워 device 재개. **알려진 한계(U6)**: stamp(`LAST_SILENT_PUSH_RECEIVED_AT_KEY`)가 다른 trip push(zombie)로도 갱신돼 device가 최대 T 침묵 가능 | 있음(liveActivityPushChannel.test.ts · replay_20261028_la_device_authority.test.ts) |
| liveActivityMirrorSync.ts `updateLiveActivityFromMirrorStation` 게이트 (#2659 -> #2735 PR-4) | 함정 | #2659의 mirror 면제는 "backend가 LA를 갱신 중이 아닐 때"로 좁혀졌다 — 권위 active면 mirror 전체 교체(D2/D4)도 skip, 수신 공백 > T면 풀려 LA 13분 정지(#2659)는 재발하지 않는다 | 있음(replay_20261028_la_device_authority.test.ts: trip 180 lock 이후 D2·D3 쓰기 0 + 공백 653s에서 T 지점 재개) |
| liveActivityMirrorSync.ts `updateLiveActivityFromMirrorStation` (#2735 PR-4) | 불변식 | LA update=전체 교체 — mirror가 backend push ETA/배지를 덮지 않도록 권위 active 동안 skip(역 전이당 1회 제한은 권위 해제 구간의 보조 경계) | 있음(replay_20261028_la_device_authority.test.ts) |
| refreshLiveActivityFromBackgroundContext.ts:169-214 | 불변식 | (#2732 gap1 fix) BG LA 경로도 FG와 동일하게 `isBackendSsotRouteRegression`을 거쳐야 얼어붙은 mirror가 트립 꼬리에서 채택되지 않음 — 입력(arc/gpsArcIndex)을 못 채우면 가드 비활성이 안전 기본. GPS 신뢰 proxy 신선도는 반드시 가드 자체의 GPS-경로 stale 임계(`BACKEND_SSOT_ADVANCE_STALE_GPS_MS`, 60s)와 정합돼야 함 — 더 느슨한 창(#2846 P1에서 잡힌 최초 구현의 5분 재사용 버그)을 쓰면 정상 advance 중인 mirror를 묵은 GPS로 오탈락시킬 수 있음(개악 방향) | 있음(refreshLiveActivityFromBackgroundContext.test.ts #2732 gap1 + #2846 P1) |
| refreshLiveActivityFromBackgroundContext.ts:123-134 | 불변식 | (#2732 gap2 fix) destination read 실패만으로 활성 trip(ACTIVE_TRIP_KEY 존재) 중 LA를 end하지 않음 — 둘 다 부재일 때만 end | 있음(refreshLiveActivityFromBackgroundContext.test.ts #2732 gap2) |
| lookupStationFromSsot.ts:33-58 / updateWidgetFromSilentPush.ts:40-71 | 갭 | (#2732 후속, #2846 P3 정정) 위젯의 `resolveFromSsot`는 `resolveBackendSsotMirrorStation`을 재사용하지 않는 **독립 구현**(자체 `findStationByName`/`findStationByNameAndLine` 직접 호출) — 이슈 본문의 "resolveBackendSsotMirrorStation 직행" 서술은 부정확했다(코드 확인 결과 정정). 입력도 persisted `BACKEND_SSOT_MIRROR_KEY`가 아니라 **그 순간 도착한 push의 `payload.ssot` 단발 스냅샷**이라 BG LA 경로(gap1, 오래된 persisted mirror가 advance-tick 등 무관한 트리거로 재평가되는 구조)와 노출 경로가 다르다 — 다만 backend가 여러 push에 걸쳐 동일 station을 반복 송신하면(진짜 tail-stuck) 위젯도 그 값을 그대로 반영하므로 근본 위험(backend SSoT 자체의 정체)은 여전히 남아있다. `lastAdvanceAt`/arc 컨텍스트가 이 경로엔 없어 `isBackendSsotRouteRegression`을 그대로 재사용할 수 없다 — caller 재설계(payload 확장) 필요한 별도 대공사라 스코프 제외 | **없음** |
| useTransferTrainList.ts:111-124 | 갭 | (#2846 P2) `transferCurrentStation`이 `resolveBackendSsotMirrorStation`을 mirror freshness(180s)만으로 채택 — gap1과 동일한 회귀 가드 미경유. 다만 `resolveTransferWaypoint`(findActiveTransferContext.ts:140)가 **이름 완전 일치**만 활성화하므로(직전 역에 멈춰 있으면 활성화 자체가 안 됨 — 안전 방향), 실제 노출 창은 "mirror가 환승역에 정확히 도달한 뒤 그 지점에서 얼어붙고, 사용자가 leg-2로 진행했는데 아직 탭/lock으로 `boardingLine`을 안 바꾼" 좁은 구간뿐이다(그 시점 이후엔 `lock.boardingLine===nextLine` 가드로 자연 해소, :70). 가드 배선에는 이 훅에 없는 origin/arcStations 플러밍(TRIP_ORIGIN_KEY 신규 prop 추가 + caller 체인 변경)이 필요해 위젯과 동급 대공사 — 이번 PR 스코프 제외, 잔여 위험은 좁지만 0은 아님 | **없음** |
| stationNotification.ts:1015-1022 (`classifyMirrorAgainstOrigin`) | 전제 | (#2846 P2 확인 완료, 무해 판정) mirror 해석 결과를 origin과 **이진 비교**(confirmed-same/different/unresolved)만 하는 게이트 — tail-stuck(mirror가 origin이 아닌 다른 역에 얼어붙음)이어도 "origin과 다르다"는 판정 자체는 여전히 참이라 오분류가 없다. 위험 방향(mirror가 실제로 progressed인데 "origin과 같음"으로 오판)은 frozen-at-origin(=아직 출발 안 함) 케이스에서만 발생 가능한데 이는 gap1 클래스(진행 후 얼어붙음)가 아니라 별도 stale/missing 케이스이고, 그 경로는 이미 이 함수 호출부의 "판정 불확실 시 보수=발사(억제 안 함)" 설계로 안전하게 fire 처리됨(문서 :1032-1036) — 배선 불필요 | 부분(설계상 보수적 기본값) |
| liveActivityGpsWriteArbitration.ts:15-18 | 함정 | in-memory 모듈상태 — BG headless 별도 인스턴스에서 비공유 가능 | **없음** |
| useLiveActivityPreBoardingLifecycle.ts:24-35 | 함정 | LA 시작경로 이원화(채널 세션 vs 직접 update) — 서로 인지 못 하면 kill/깜빡임(#2806 root) | 부분 |
| stationNotifCollapseId.ts:11 | 불변식 | collapse id 포맷 변경 금지(backend와 동시 조정) | 부분 |
| tripEndedSentinel.ts:102 | 불변식 | sentinel 기록 후 새 trip이 소비(reset) 금지 | **없음** |
| useStateRehydration.ts (sentinel 소비) | 불변식 | sentinel 소비 지점은 알리지 않는다 — **모든 sentinel 생산자(6곳)가 각자 알리거나 사유가 분류돼 있어야 한다**(PR-3b #3128) | 부분(`sentinelProducerNotices.test.ts`: 생산자 파일·지점 수 고정, 신규 생산자는 분류 필수. 표시 도달은 관측 불가) |
| isBoardableCandidate.ts:2-11 | 불변식 | "탑승 가능 후보"는 단일 함수만 — picker 독자구현 금지(9/16 실증) | 있음 |
| boardingPromptContext.ts:16 | 전제 | 프롬프트는 leg 미시작(탑승 전)에서만 의미 | **없음** |
| safetyNetScheduler.ts:77,261 | 불변식 | tripStart 미확인 시 절대 무장 안 함 | 부분 |
| fgArvlCdFastPath.ts:13 / useStationAlarm.ts:1585 | 불변식 | #640 lock 부재 시 lockless 임의 fire 절대 금지 | 있음 |
| useStationAlarm.ts:1237 | 함정 | GPS-fallback ETA의 `getRouteRemainingSeconds(route)` clamp 상한이 currentStation 기준으로 재앵커링되지 않음(#2811 편측 감사, #2848에서 발견·의도적 미배선) — `estimateTransitEtaSeconds(distM, speedMps, hopBasedSeconds)`가 `Math.min(distanceEstimate, hopBasedSeconds)`이므로 route가 트립 시작 시점 고정값(더 큰 상한)이면 clamp가 실제보다 느슨해진다. `anchorRouteToCurrentStation`으로 앵커링하면 상한이 작아져 `evaluateAlarmPhase`가 소비하는 `etaSeconds`가 달라지고, 이는 곧 early/transfer 알람이 **발사되는 시점 자체**를 바꾼다 — 표시 전용(LA 문구)이 아니라 alarm-critical 경로라 순수 "정거장 수 self-contradiction" fix와 동급 리스크로 취급할 수 없다. ADR-014 "사용자 명시 의향=lock 동급 보호" 원칙상 알람 타이밍 변경은 이 fix의 범위(#2811, ETA/정거장 표시 정합) 밖의 별도 회귀 검증(replay 영향 분석)이 선행돼야 한다. 배선 금지, 기록만 | **없음** |
| backendSsotMirror.ts:134,186-197 | 불변식 | lastAdvanceAt 역행 push 거부(순서 비보장 APNs) — 단 새 trip의 작은 값은 거부 금지 | 있음 |
| boardingLockStorage.ts:12 | 함정 | Lock 필드 추가 시 isBoardingLock 가드 동시 갱신(안 하면 silent parse fail) | **없음** |
| useApnsTripRegistration.ts:626,658 | 함정 | heal flag는 성공 시에만 set / in-flight skip은 재시도 예산 미소모 | **없음** |
| useBoardingLockSync.ts:32,417 | 불변식 | 무기한 대기 금지 — backstop 필수 | **없음** |
| api/signalDumpBackend.ts:176 / telemetryForward.ts:172 | 불변식 | 절대 throw 금지(launch/trip-end critical path) | **없음** |
| tripBoundCleanups.ts:183 | 불변식 | 여러 소스는 같은 chokepoint에서 함께 clear(산발 금지) | **없음** |
| ~~pushReceiptLog.ts / rawSignalBuffer.ts~~ | (해소, #2861 T1) | ~~push-receipt가 fusion cycle(30s)과 cap=300 공유 → 긴 트립 초반 receipt 증발~~ — `pushReceiptBuffer.ts`(cap=60, 독립 채널)로 분리. 신규 push-receipt-유사 관측 채널을 추가할 때는 고빈도(cycle급) 채널과 cap을 절대 공유하지 말 것(gpsDropBuffer와 동일 교훈, lesson_gps_drop_fusion_buffer_pollution 재적용) | 있음(pushReceiptLog.test.ts #2861 긴 트립 320건 cycle 모사) |
| ~~boardingPromptMonitor.ts byDay~~ | (해소, #2861 T2) | ~~"recent 7d" 시계열이 alarmLog 링(cap=200, 전 source 혼합) 재집계라 트립 1회만으로 지난 일자가 증발~~ — `boardingPromptDailyCounters.ts`(쓰기 시점 영속, 14일 rolling)로 분리. ring classify()와 영속 writer의 bucket(outcome/reason) 계약이 둘 다 같은 literal을 봐야 하므로, 신규 boarding-prompt outcome을 추가할 때는 `classify()`와 `logBoardingPromptFired`/`logBoardingPromptResponded`(alarmLog.ts) 양쪽을 **함께** 갱신할 것 — 한쪽만 바뀌면 "최근" 뷰와 "영속" 뷰가 조용히 갈라진다 | 있음(alarmLog.test.ts #2861 T2 교차검증 2건) |

## 3. Device — fusion / shared / 위젯

| 위치 | 종류 | 요약 | 강제 |
|---|---|---|---|
| fusionTierPriority.ts:2-13 | 불변식 | fusion 신뢰 우선순위 단일 SSOT 표 | 있음 |
| pickFusedStation.ts:74-81 | 함정 | arvlCd=1 단발 확정 금지 — 연속 2 cycle | 있음 |
| gpsQualityGate.ts / realtime.ts:189 / routeProgress.ts:33 | 불변식 | GPS 좌표는 결정권 없음(표시만) — gate는 lock 무효화 판단만 | 있음/부분/없음 혼재 |
| positionTrainConsensus.ts:17-18 | 불변식 | GPS 미사용 — baro/accel/cellular 3신호만 | 부분 |
| useRouteProgress.ts:138-139 | 불변식 | 저품질(지하) 좌표 re-seed 금지 | **없음** |
| useNearestStation.ts:752 | 함정 | hydrate가 applyLocation 뒤 resolve되면 신선 fix 덮어씀(race) | **없음** |
| useFusedNearestStation.ts:1972-1982 | 함정 | 비동기 hydration↔render 합성 race — trip context 동일 시만 채택 | **없음** |
| useStickyStation.ts:164-225 | 함정 | hydrate 완료 전 lock/unlock 평가 보류 | 있음 |
| useTripOrigin.ts:35-39 | 함정 | hydration effect가 capture effect보다 먼저 선언(파일 순서 의존) | **없음** |
| useDeferredNavigate.ts:11-14 | 불변식 | hydrated=false 시 navigate 금지 — queue+flush | **없음** |
| arrivalApi.ts:35 / positionApi.ts:97-108 | 함정 | updnLine 형식이 엔드포인트마다 다름(arrival=한글, position=숫자·-1 sentinel) | 부분/있음 |
| pickCandidateTrains.ts:138-140 | 불변식 | 방향 모름(-1) 후보 반드시 제외 | 있음 |
| lookupStationFromSsot.ts / updateWidgetFromSilentPush.ts | 불변식 | SSoT 우선→BG context 폴백 순서 고정, 채택 시 거리=0 | 있음 |
| approachLine.ts:104 | 함정 | mirror 채택 전 cross-line 가드(#2590) 없으면 엉뚱한 노선 | 부분 |
| backendSsotRegressionGuard.ts:96-123 | 불변식 | gpsAhead stale 임계=60s(#2841), deviceAhead(지하)는 180s 그대로 — 두 경로 독립, 공통 임계로 재통합 금지(트립 꼬리 미보호 재발) | 있음 |
| useTransferTrainList.ts:69-105 | 함정 | mirror entry 불변이면 180s 지나도 재평가 안 됨(memo dep에 시간 없음) | 있음 |
| boardingLock.ts(constants):275-290 | 갭 | App Group은 pull 모델(push 없음) — 신선도 게이트+5s 지연이 주석에만 | **없음** |
| findActiveTransferContext.ts:101 | 갭 | lockless trip에서 환승 context 영원히 null 가능(leg-2 회귀 직결) | **없음** |
| useTransferAutoDetect.ts:14 | 불변식 | 사용자 직접 선택 시에만 onAutoLock — 자동 승격 금지 | 있음(추정) |
| loopDirection.ts:7 / journeyAdapter.ts:58 | 불변식 | 순환선 토폴로지·역↔노선 정합 SSOT 단일 출처(재구현 금지, ADR-038) | 없음/부분 |
| useNavigationStore.ts:5 | 불변식 | WhileInUse 사용자도 BG GPS+자동 lock chain 대상(권한 분기 누락 주의) | 부분 |
| stationRoute.ts:94 (`getLineStationsCached`) | 함정 | `sort((a,b)=>a.id.localeCompare(b.id))`가 "id 순서=노선 물리 순서"를 암묵 전제 — 1호선 구로(1-042)↔가산디지털단지(1-100, 공식 인접 idx차 21, forward slice 경로 자체가 틀린데 부호만 "분기 양쪽 모두 fromIdx보다 id가 큼" 우연으로 맞음)는 **여전히 우연 의존**이고 61역 추가 예정(#2954 PR)이 이 배치를 조용히 깨뜨릴 수 있음(범위 밖, #2949가 다루지 않음). 2호선 시청↔충정로 seam은 **#2949가 해결** — 아래 행 참고 | 테스트(`src/data/__tests__/stationIdAdjacency.contract.test.ts`, `src/features/route/utils/__tests__/idAdjacencyContract.test.ts`, backend `legDirection.test.ts` "#2954 K-2" 블록 — 1호선 쌍만 우연 의존으로 고정, 2호선 쌍은 #2949 fix 후 정답값으로 갱신됨) |
| lineLoopPath.ts:130 (`travelDirectionSign`) | 불변식 | closed-loop(2호선 본선) 방향 판정은 `travelDirectionSign` 단일 primitive만 사용한다 — `shortestLinePathIndices`가 만든 경로의 `path[1]`을 idx와 다시 크기 비교해서 방향을 재도출하는 패턴 금지(#2949 재발 원인: 시청 idx=0/충정로 idx=42인 seam station을 기준점으로 쓰면 wraparound 여부와 무관하게 비교 결과가 항상 같은 값으로 고정돼 방향이 오판된다 — 시청 출발 21쌍, 충정로 출발 21쌍, 총 42쌍/1,806쌍이 실제로 틀렸었다). `resolveTripDirection`(tripDirection.ts)·`directionOnLine`(directionOnLine.ts)·backend `inferLegDirection`(legDirection.ts) 셋 모두 이 primitive로 교정·수렴 | **있음**(C-2: `line2SeamDirectionMatrix.test.ts` device+backend 각 84쌍 전수 매트릭스 / C-3: `lineDirectionDerivationGuard.test.ts`가 `path[1]`/`firstStepIdx` 재도출 패턴을 코드 전체에서 금지 / C-4: 동일 테스트가 `isClosedLoopMainStation`/`travelDirectionSign` import 파일 화이트리스트를 강제) |
| pickFusedStation.ts (`applyDirection`) / useFusedNearestStation.ts (`legDirections`) | 불변식 | fused 후보 점수는 route(arc)가 있을 때 leg 방향과 반대인 arrival/position을 쓰지 않는다. route 있는데 방향 미해결이면 점수 0(fail-closed), route 없음은 미적용(#3191 PR-2D, ADR-044) | **있음**(`useFusedNearestStation.directionFilter.test.ts` 10/28 R2 원문 replay, `pickFusedStation.direction.test.ts`, backend `legDirection.deviceParity.test.ts`) |
| useFusedNearestStation.ts (lockless tier6, `trackTrainProgress` 호출) | 갭 | lockless tier6(position-train)는 방향 미필터 — `gps.userLocation` 최근접 역 선택에 가려져 출력 변화를 관측할 수 없어 PR-2D 범위에서 뺐다. 반대 방향 열차가 GPS 최근접역에 있어 tier6가 오채택하는 실측 행이 나오면 그때 판정 | **없음** |
| verdictArrival (useFusedNearestStation.ts) | 함정(무해) | 이미 고른 역에 대한 vote일 뿐 역을 고르지 않는다 — 방향 필터 대상 아님 | 해당 없음 |
| stationaryFixHold.ts / useFusedNearestStation.ts (`gateUserLocation`) | 불변식 | lock 없음 + 지상 + 정지(acc<=30, speed<0.5, 최근접역>=150m) + L 이후 이동 증거(새 fix/기압 하강/ΔP 이벤트) 없음이면 마지막 fix L을 나이와 무관하게 결정 tier 거리 게이트(pickCandidateTrains·positionTrain·fused/route gateOpts·WiFi)와 tier8 `goodGpsOverridesTier8`에 계속 쓴다. `usePositionStability`(#2713 자기강화 방지)·`lockGpsDrift`(lock 범위)는 일부러 `decisionUserLocation` 그대로(#3191 PR-2, ADR-044) | **있음**(`useFusedNearestStation.stationaryHoldWiring.test.ts` T/A 10/18~21 덤프 원문 행 + 거부 행, `stationaryHoldTier8.test.ts` D, `stationaryFixHold.test.ts` 경계값) |
| barometerState.ts (`resetBarometerState`) | 불변식 | ring만 비우고 첫 reading / 마지막 reading 시각 / ΔP 이벤트 추적은 세션 동안 유지한다 — 기압계 관측 가능 판정(D2(b))이 이 값에 기댄다 | **있음**(`barometerState.lastReading.test.ts`) |
| useNearestStation.ts (`applyLocation`) | 불변식 | 같거나 과거 timestamp fix는 표시 경로(좌표/시각/accuracy)에 반영하지 않는다(품질 게이트만 평가). 10/28 06:26:51→06:26:34, 17:25:08→17:24:46 역행 실측 | **있음**(`useNearestStation.bgFixInjection.test.ts`) |
| useNearestStation.ts (BG fix 주입) / useFgPositionUpload.ts | 갭 | trip 없음 + BG + 평지 이동: BG task는 목적지(trip)가 없으면 `BG_LAST_FIX_KEY`를 쓰지 않아 주입할 fix 자체가 없다(알려진 갭, D3). lock 없는 표시는 보장 대상이 아니고 FG 복귀 refresh가 새 fix를 준다 | **없음**(ADR-044 기록) |
| backgroundLocationTask.ts:175 | 함정 | "기압계는 BG에서 무용(FG-only)" 주석은 W 덤프 BG 행의 hpa·baroEvt 갱신과 어긋난다(JS가 살아 있는 BG에서는 reading이 들어온다) — #2345 proxy 전제 재검토 필요(후속) | 해당 없음 |

---

## 4. 테스트 승격 큐 (강제 없음 × 위험도 순 — 3갈래 top 5 통합)

fix가 이 영역을 지나갈 때 해당 항목을 같은 PR에서 테스트로 승격한다. 독립 착수 시엔 위에서부터.

1. **Swift MIRROR/App Group 계약 drift** — 사본 2벌·JSON 키·URL 리터럴이 수동 동기화. 최소 방어: 두 Swift 사본 diff==0을 CI 스크립트로(테스트 아닌 diff 체크로 가능).
2. **trips.ts cron stale-read: prompt dedup ledger 무방비** — 9/30 반복발사 root(b) 그 자체. (b) fix와 함께 승격.
3. ~~**liveActivityMirrorSync #2659 게이트 경계** — mirror까지 막으면 LA 13분 정지 재발, 경계 assert 부재.~~ (승격 완료 #2735 PR-4 — replay_20261028_la_device_authority.test.ts)
4. **scheduled.ts:5615 promptDisplay 불변경** — 깨지면 leg-1 프롬프트 조용히 사망(과거 실발생).
5. **useFusedNearestStation/useNearestStation hydrate↔fresh-fix race** — 표시역 과거값 회귀 가능.
6. **fallback.ts 평가 순서(stale-intermediate ≺ implicit-ACK)** — 순서 뒤집히면 회귀 관측 자체 불능.
7. ~~**boardingAnchorResolver "틀린 열차 lock 금지"** — 모듈 존재 이유인데 리졸버 레벨 직접 테스트 부재.~~ (승격 완료 #3056 — replay_20261018_assertion_departed.test.ts)
8. **boardingLock App Group pull 신선도 게이트** — LA 버튼 회귀 이력 다수(#2805/#2806)인데 게이트 값 미고정.
9. **tripEndedSentinel 소비 금지** — 어기면 trip 종료 오탐/이중 종료.
10. **isNearOrigin "존재 AND 멀다" 분리 판정** — 합치면 #2532 조용히 무력화.
11. **boardingPromptContext leg-전제** — leg 1+ 진입 시 침묵을 직접 assert하는 지점 부재.
12. **BG tick 편승 폴링은 게이트·쿨다운 필수** — 새 폴링 소스 추가 시 quota 소진 재발 경로. 살아있는 앵커: `tripDeathPullBackstop.ts:21`(BG location tick 편승, 같은 상수를 호출 쿨다운으로 사용) · `:95`(쿨다운 내 재호출 skip, 시도 자체 기록으로 hot-loop 방지). (구 앵커 pollWithCooldown은 #3063 철거)
13. **useTripOrigin effect 선언 순서 의존** — 리팩터에 조용히 깨짐.
14. **index.ts KV non-atomic RMW** — 구조적(DO 필요), 테스트 아닌 아키텍처 결정 대상.
15. **findActiveTransferContext lockless null** — leg-2 회귀 계보와 직결.
