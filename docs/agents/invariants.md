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
| index.ts:1196 | 불변식 | POST /position에서 마커 stamp 금지(#2450 throttle 보호) | **없음** |
| index.ts:2864 | 함정 | KV read-modify-write는 CAS 없음 — 동시 갱신 stale 덮어쓰기 race 창 | 없음(구조) |
| tripPositionSsot.ts:186 | 불변식 | 이 모듈은 lock 승격 절대 안 함 — device useLockSuggestion만 소비 | 부분 |
| boardingAnchorResolver.ts:36 | 불변식 | 틀린 열차 lock 절대 금지 — 이 모듈의 존재 이유 | 부분 |
| boardingAnchorResolver.ts:126 | 갭 | staleness 상한 의도적 보류(N=1 편향 우려) | 없음(의도) |
| liveActivity.ts:11 | 불변식 | ContentState 필수 3필드(stationName/lineName/lineColorHex) backend가 항상 채움 | 있음 |
| liveActivity.ts:434 | 함정 | 'la-stale-backstop'은 backend 내부 식별자 — 외부 enum 노출 금지 | **없음** |
| advanceTripPosition.ts:716 | 함정 | consensus-tick D1 append는 전이 시에만(#2073 quota) | 부분 |
| lockSwap.ts:15,90 | 불변식 | direction=null이어도 wrong-direction 열차 pool 배제 | 있음 |
| fallback.ts:67,139 | 함정 | stale-intermediate 체크가 implicit-ACK보다 **먼저** — 순서 뒤집히면 회귀 관측 자체가 죽음 | 부분 |
| alarm.ts:41 | 불변식 | ARRIVAL_CODE 숫자 우연 일치해도 타 코드체계 재사용 금지 | **없음** |
| scheduled.ts:7405 | 불변식 | 프롬프트는 임박 열차 있을 때만 발사(#2801 재발 방지, arvlCd∈{0,1,2} OR-fallback) | 있음(#2834 + replay_20260930_leg2_prompt) |
| boardingPrompt.ts:176 / scheduled.ts:6842 | 함정 | boarding-prompt "임박" 게이트 정의가 2벌 공존 — 공유본체(`decideBoardingPromptFire`, leg-1 GPS-free/leg-2)는 arvlCd∈{0,1,2} OR-fallback(관측불가 포함 발사), GPS 9단 경로(`hasArrivedSignal`, archFlag=on 전용)는 arvlCd=1(ARRIVED) 단독 hard check — 의미 drift 주의. 통합은 별도 결정(2026-09-30 교차추적 감사 발견, 이 항목은 기록만 — #2838 범위 아님) | **없음** |

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
| liveActivityPushChannel.ts:363-367 | 불변식 | #2481/#2735 3-state 권위 게이트 — backendConfirmed 신선 시만 backend 단독 저자 | 있음 |
| liveActivityMirrorSync.ts:76-85 | 함정 | #2659 backend-authority 게이트는 GPS-sourced 전용 — mirror까지 막으면 LA 13분 정지 재발 | 부분 |
| liveActivityMirrorSync.ts:102-107 | 갭 | LA update=전체 교체 — mirror가 backend push ETA/배지 덮을 위험, 역 전이당 1회 제한뿐 | **없음** |
| refreshLiveActivityFromBackgroundContext.ts:169-207 | 불변식 | (#2732 gap1 fix) BG LA 경로도 FG와 동일하게 `isBackendSsotRouteRegression`을 거쳐야 얼어붙은 mirror가 트립 꼬리에서 채택되지 않음 — 입력(arc/gpsArcIndex)을 못 채우면 가드 비활성이 안전 기본 | 있음(refreshLiveActivityFromBackgroundContext.test.ts #2732 gap1) |
| refreshLiveActivityFromBackgroundContext.ts:123-134 | 불변식 | (#2732 gap2 fix) destination read 실패만으로 활성 trip(ACTIVE_TRIP_KEY 존재) 중 LA를 end하지 않음 — 둘 다 부재일 때만 end | 있음(refreshLiveActivityFromBackgroundContext.test.ts #2732 gap2) |
| lookupStationFromSsot.ts:33-43 / updateWidgetFromSilentPush.ts:40-71 | 갭 | (#2732 후속) 위젯 경로는 silent push payload 단발 `ssot` 슬라이스만 받아 `isBackendSsotRouteRegression`이 요구하는 `lastAdvanceAt`/arc 컨텍스트가 없다 — BG LA 경로(gap1)와 동일한 tail-stuck 위험이 위젯에도 존재하나 이번 PR 스코프 제외(caller까지 재설계 필요, 과설계 방지) | **없음** |
| liveActivityGpsWriteArbitration.ts:15-18 | 함정 | in-memory 모듈상태 — BG headless 별도 인스턴스에서 비공유 가능 | **없음** |
| useLiveActivityPreBoardingLifecycle.ts:24-35 | 함정 | LA 시작경로 이원화(채널 세션 vs 직접 update) — 서로 인지 못 하면 kill/깜빡임(#2806 root) | 부분 |
| stationNotifCollapseId.ts:11 | 불변식 | collapse id 포맷 변경 금지(backend와 동시 조정) | 부분 |
| tripEndedSentinel.ts:102 | 불변식 | sentinel 기록 후 새 trip이 소비(reset) 금지 | **없음** |
| isBoardableCandidate.ts:2-11 | 불변식 | "탑승 가능 후보"는 단일 함수만 — picker 독자구현 금지(9/16 실증) | 있음 |
| boardingPromptContext.ts:16 | 전제 | 프롬프트는 leg 미시작(탑승 전)에서만 의미 | **없음** |
| safetyNetScheduler.ts:77,261 | 불변식 | tripStart 미확인 시 절대 무장 안 함 | 부분 |
| bgPositionTrainFire.ts:35 | 불변식 | accuracy 게이트보다 먼저 시도(지하 GPS garbage 오인 방지) | 부분 |
| fgArvlCdFastPath.ts:13 / useStationAlarm.ts:1585 | 불변식 | #640 lock 부재 시 lockless 임의 fire 절대 금지 | 있음 |
| backendSsotMirror.ts:134,186-197 | 불변식 | lastAdvanceAt 역행 push 거부(순서 비보장 APNs) — 단 새 trip의 작은 값은 거부 금지 | 있음 |
| boardingLockStorage.ts:12 | 함정 | Lock 필드 추가 시 isBoardingLock 가드 동시 갱신(안 하면 silent parse fail) | **없음** |
| useApnsTripRegistration.ts:626,658 | 함정 | heal flag는 성공 시에만 set / in-flight skip은 재시도 예산 미소모 | **없음** |
| useBoardingLockSync.ts:32,417 | 불변식 | 무기한 대기 금지 — backstop 필수 | **없음** |
| api/signalDumpBackend.ts:176 / telemetryForward.ts:172 | 불변식 | 절대 throw 금지(launch/trip-end critical path) | **없음** |
| tripBoundCleanups.ts:183 | 불변식 | 여러 소스는 같은 chokepoint에서 함께 clear(산발 금지) | **없음** |

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
| useTransferTrainList.ts:69-105 | 함정 | mirror entry 불변이면 180s 지나도 재평가 안 됨(memo dep에 시간 없음) | 있음 |
| boardingLock.ts(constants):275-290 | 갭 | App Group은 pull 모델(push 없음) — 신선도 게이트+5s 지연이 주석에만 | **없음** |
| bgUndergroundArrivalPoll.ts:12 | 불변식 | BG arrival 폴링은 지하+lock 조건부만 — always-on 금지(OS quota) | **없음** |
| pollWithCooldown.ts:12 | 불변식 | 게이트는 호출자 책임(헬퍼가 안 걸음) — 새 폴링 소스는 게이트 필수 | 부분 |
| findActiveTransferContext.ts:101 | 갭 | lockless trip에서 환승 context 영원히 null 가능(leg-2 회귀 직결) | **없음** |
| useTransferAutoDetect.ts:14 | 불변식 | 사용자 직접 선택 시에만 onAutoLock — 자동 승격 금지 | 있음(추정) |
| loopDirection.ts:7 / journeyAdapter.ts:58 | 불변식 | 순환선 토폴로지·역↔노선 정합 SSOT 단일 출처(재구현 금지, ADR-038) | 없음/부분 |
| useNavigationStore.ts:5 | 불변식 | WhileInUse 사용자도 BG GPS+자동 lock chain 대상(권한 분기 누락 주의) | 부분 |

---

## 4. 테스트 승격 큐 (강제 없음 × 위험도 순 — 3갈래 top 5 통합)

fix가 이 영역을 지나갈 때 해당 항목을 같은 PR에서 테스트로 승격한다. 독립 착수 시엔 위에서부터.

1. **Swift MIRROR/App Group 계약 drift** — 사본 2벌·JSON 키·URL 리터럴이 수동 동기화. 최소 방어: 두 Swift 사본 diff==0을 CI 스크립트로(테스트 아닌 diff 체크로 가능).
2. **trips.ts cron stale-read: prompt dedup ledger 무방비** — 9/30 반복발사 root(b) 그 자체. (b) fix와 함께 승격.
3. **liveActivityMirrorSync #2659 게이트 경계** — mirror까지 막으면 LA 13분 정지 재발, 경계 assert 부재.
4. **scheduled.ts:5615 promptDisplay 불변경** — 깨지면 leg-1 프롬프트 조용히 사망(과거 실발생).
5. **useFusedNearestStation/useNearestStation hydrate↔fresh-fix race** — 표시역 과거값 회귀 가능.
6. **fallback.ts 평가 순서(stale-intermediate ≺ implicit-ACK)** — 순서 뒤집히면 회귀 관측 자체 불능.
7. **boardingAnchorResolver "틀린 열차 lock 금지"** — 모듈 존재 이유인데 리졸버 레벨 직접 테스트 부재.
8. **boardingLock App Group pull 신선도 게이트** — LA 버튼 회귀 이력 다수(#2805/#2806)인데 게이트 값 미고정.
9. **tripEndedSentinel 소비 금지** — 어기면 trip 종료 오탐/이중 종료.
10. **isNearOrigin "존재 AND 멀다" 분리 판정** — 합치면 #2532 조용히 무력화.
11. **boardingPromptContext leg-전제** — leg 1+ 진입 시 침묵을 직접 assert하는 지점 부재.
12. **pollWithCooldown 게이트 호출자 위임** — 새 폴링 소스 추가 시 quota 소진 재발 경로.
13. **useTripOrigin effect 선언 순서 의존** — 리팩터에 조용히 깨짐.
14. **index.ts KV non-atomic RMW** — 구조적(DO 필요), 테스트 아닌 아키텍처 결정 대상.
15. **findActiveTransferContext lockless null** — leg-2 회귀 계보와 직결.
