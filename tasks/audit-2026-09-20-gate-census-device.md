# Device 게이트 전수 감사 (src/ 이하, 2026-09-20)

읽기 전용 감사. 기준 아키텍처: 2026-09-03 확정 — backend가 추적·발사 권위, device는 표시(LA/위젯)·탭·업로드.

## 0. 전제 — 빌드 플래그 실측 (모든 판정의 기반)

| 플래그 | 값 | 근거 |
|---|---|---|
| `EXPO_PUBLIC_MINIMAL_ALARM` | **미설정 = OFF** | `.env`에 키 자체가 없음 (2026-09-08 수정본, 직접 확인). `docs/decisions/ADR-038-fork-map-multi-authority-elimination.md:86` "device fire(MINIMAL_ALARM, 현재 OFF)" 명시. 판정 함수: `src/shared/constants/debugFlags.ts:21-23` |
| `EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH` | **true = ON** | `.env`에 `EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH=true`. 판정: `src/shared/config/archFlag.ts:45-50` (env 단독으로 ON, remote 무관) |
| `EXPO_PUBLIC_DEBUG_MODAL` | true | 관측용, 게이트 아님 |

EXPO_PUBLIC_*는 빌드타임 인라인이므로 이 값이 곧 사용자 실기기(로컬 Xcode Release) 빌드의 상태다.
`.env`는 미커밋 파일이라 "현재 빌드 구성 기준" 판정임을 명시한다. 이 두 플래그가 아래 인벤토리의
④(도달불가) 판정 다수를 만든다.

### SIMPLE_ARRIVAL_ARCH=ON이 죽이는 것 (전부 확인)
- `evaluateMovement` 전면 bypass — `movementGate.ts:353` `if (isSimpleArchEnabled()) return { reliable: true }`.
  → FG/BG의 **모든 movement 게이트(정적 misfire 가드)가 무조건 통과**.
- `lookupStationBySsid` 항상 null — `wifiSsidLookup.ts:59`. → WiFi SSID 채널 전체 사망.
- `useBarometer` dormant — `useBarometer.ts:129` (`flag-on-dormant`). → barometerSubsurface 항상 false.
- `fireAlarmOnce` unified ledger **활성** — `useStationAlarm.ts:1098` (flag ON 분기).

### MINIMAL_ALARM=OFF가 죽이는 것 (전부 확인)
- BG 3대 발사 경로: `evaluatePositionTrainFire`(bgPositionTrainFire.ts:55), `evaluateWaypointArvlcdFire`(bgWaypointArvlcdFire.ts:73), `evaluateUndergroundConsensusFire`(undergroundConsensusFire.ts:64) — 함수 첫 줄 return.
- BG/FG device 로컬 visible 발사: stationPipeline.ts:611-613·733-740, useStationAlarm.ts:1068-1074.
- FG 로컬 boarding-prompt 전체: useLocalBoardingPromptGate.ts:57 (마스터 스위치 주석 명시).

## 1. 게이트 인벤토리

판정 범례: 정상 / ①미배선 / ②모순 / ③중복 / ④도달불가(현 빌드 구성) / ⑤조용한 억제.
"④(cfg)" = 코드 자체는 배선돼 있으나 현 플래그 구성에서 상시 dead.

### 1-A. 마스터 스위치

| 게이트 | file:line | 목적 | 배선 | 판정 | 근거 |
|---|---|---|---|---|---|
| isMinimalAlarmEnabled | debugFlags.ts:21 | device 로컬 발사 마스터 | 7개 소비처 | 정상(의도적 OFF) | ADR-038이 device fire 영구삭제 방향 명시 — 하류 전부 ④ |
| isSimpleArchEnabled | archFlag.ts:45 | arrival-SSOT 아키텍처 전환 | 10+ 소비처 | 정상(의도적 ON) | 단, 하류 게이트 문서와 런타임 불일치 다수(아래 ②) |

### 1-B. device 알람 fire 경로 — BG (backgroundLocationTask → processLocationUpdate)

| 게이트 | file:line | 목적 | 판정 | 근거 |
|---|---|---|---|---|
| MINIMAL 3대 BG 발사 경로 진입 | backgroundLocationTask.ts:197-214, 243-249 | lock 열차 직접 추적/waypoint arvlCd/지하 consensus 발사 | ④(cfg) | 플래그 OFF 첫 줄 return. 내부 게이트 전부 동반 ④: #2407 pending-traincode skip(bgPositionTrainFire.ts:61), passesLockedStationGate(:157), isImminentByArrivalCode(bgWaypointArvlcdFire.ts:127), underground-profile+WiFi 게이트(undergroundConsensusFire.ts:69-74) |
| undergroundConsensusFire WiFi 게이트 | undergroundConsensusFire.ts:72-74 | WiFi로 candidate 확보 | ④ **이중 dead** | MINIMAL OFF + `lookupStationBySsid`가 flag ON으로 항상 null(wifiSsidLookup.ts:59). MINIMAL을 켜도 이 경로는 영원히 no-op — **플래그를 켠 dogfood에서도 죽어 있는 함정** |
| gate-age (isLocationFresh) | backgroundLocationTask.ts:220 / locationGates.ts:10 | stale 좌표 차단(15s) | 정상 | logSuppressedGate 관측 있음 |
| gate-accuracy (≤200m) | backgroundLocationTask.ts:227 / location.ts:7 | 지하 노이즈 좌표 발사 차단 | 정상 | underground 강등 카운터 연동(#2345) |
| gate-jump (isPlausibleJump) | backgroundLocationTask.ts:293 / locationGates.ts:40 | 텔레포트 차단(50m/s) | 정상 | |
| gate-motion-stationary | backgroundLocationTask.ts:406 | 주머니 정지 오발사 차단 | ④(cfg) | evaluateMovement가 flag ON에서 항상 reliable(movementGate.ts:353) → 이 return 도달 불가 |
| POSITION_UPLOAD 쿨다운 | backgroundLocationTask.ts:312-314 | 업로드 폭주 방지(발사 게이트 아님) | 정상 | |
| evaluateAlarmPhase dedup(firedAlarms) | stationPipeline.ts:440-452 | phase 재발사 차단 | 정상 | dedup-alarm 로그 |
| gate-not-departed (#2688) | stationPipeline.ts:434-436, 455-462 | 출발 전 early 발사 보류 | 정상 | lock 있을 때만, FG(#2703)와 대칭 |
| dismiss-silence | stationPipeline.ts:466-490 | 사용자 dismiss 후 5분/200m 침묵 | 정상 | |
| movement 게이트 (BG phase/SP) | stationPipeline.ts:503, 636 | 정적 misfire 차단 | ④(cfg)+② | flag ON으로 movementSignal.reliable 항상 true → 분기 dead. 주석의 #2483 "MINIMAL ON에서도 GPS-static 억제 유지" 약속은 현 빌드에서 거짓(전역 bypass) |
| hopWindowGate (#2373/#2478) | stationPipeline.ts:277-317, 516-526 | GPS drift 조기 발사 차단 + lock 확증 forward 우회 | 정상 | BG GPS 경로에서 도달 가능. #2478 우회 4조건 배선 확인 |
| sleep first-hop | stationPipeline.ts:497-502, 527 / shouldSuppressBySleepRule.ts:55 | 취침 첫 hop suppress | 정상 | |
| cross-category 30s | stationPipeline.ts:534 / crossCategoryStationDedup.ts:196 | SP↔phase 동일역 중복 | 정상·③ | 아래 dedup 스택 참조 |
| trip-scoped 5s | stationPipeline.ts:544 / :251 | cross-station cascade | 정상·③ | |
| phase↔phase 3s | stationPipeline.ts:562 / :291 | leg 전환 race | 정상·③ | |
| channel-agnostic 8min | stationPipeline.ts:580 / :332 | cross-channel 중복 backstop | 정상·③ | |
| MINIMAL 로컬 발사 | stationPipeline.ts:611, 733 | 잠금화면 로컬 배너 | ④(cfg) | 통과 시 산출물 = markStationFired + alarmLog + 위젯/LA 갱신뿐(visible 없음) |
| station-passed lastNotifiedStationId | stationPipeline.ts:660-662 | 동일역 재알림 차단 | 정상·③ | |

**주의**: 현 구성에서 BG 파이프라인의 "fired"는 사용자 노출이 0인 **ledger 기록 행위**다(visible은 backend push).
게이트 사슬의 실효 목적은 dedup ledger 정합 유지다.

### 1-C. device 알람 fire 경로 — FG (useStationAlarm)

| 게이트 | file:line | 목적 | 판정 | 근거 |
|---|---|---|---|---|
| hydrationPhase='ready' (H5) | useStationAlarm.ts:1127, 1481, 1641, 1786 | hydrate race 차단 | 정상 | |
| firedAlarmsRefDestId 일치 (#699) | :1134, 1381, 1645, 1789 | destination 전환 race | 정상 | |
| trip 경계 reset (#1893) | :832-857 | 동일 destination 재시작 carry-over | 정상 | |
| HYDRATE_WARMUP 10s (gate-phase-warmup / station-passed-warmup) | :139, 1167, 1483 | hydrate 직후 조기 발사 차단 | 정상 | 씨앗 목록의 'gate-phase-warmup'·'gate-station-passed-warmup' 실체 |
| gate-phase-accuracy (200m, lock-exempt #2728) | :1152-1159 | ETA 계산 신뢰성 | 정상 | lock 활성은 exempt+계측만 |
| gate-phase-time-integration / weak-source (#1817/#2204) | :1185-1201 | 약한 source 조기 발사 차단 | 정상 | lock+fusionSource 명시 시 exempt |
| train-feed ETA 1순위 (#2728) | :1208-1230 | GPS 거리 의존 제거 | 정상 | 게이트 아닌 소스 전환 |
| dismiss-silence (phase/imminent/SP) | :1285, 1391, 432 | 사용자 침묵 | 정상 | |
| movement 게이트 (phase/imminent/SP) | :1307-1326, 1412-1422, 1548-1556, 1471-1474 | 정적 misfire | ④(cfg) | flag ON 전역 bypass. `movementSuppressionReason` 항상 null |
| fireAlarmOnce ledger (#1984) | :1098-1119 / fireAlarmOnce.ts:111 | 동일 초 이중 dispatch | 정상(flag ON에서 활성)·③ | 30s 윈도우 — cross-category 30s와 목적 중첩 |
| fireAndLog in-flight (#754) | :877-879 | await race | 정상 | |
| lockless-no-user-intent (#1816/#2387) | :203-205, 892-901, 1567, 1804 | 무의향 lockless 발사 금지 | **②** | `infoModeEnabled`가 **안내 시작에서 자동 ON**(HomeScreen.tsx:439) → "명시 의향" 전제 붕괴. useUserIntentStore.ts:5 "stamp 진입점은 2개뿐" 문서와 모순. lesson_gpsfree_prompt_path_no_gates_infomode의 실증 그대로 잔존 |
| sleep rule | :902-920 | 취침 첫 hop | 정상 | |
| cross-cat/trip-scoped/phase-phase/channel-agnostic | :924-1008 | dedup 4겹 | 정상·③ | BG와 동일 스택 |
| SSoT Gate A (fireAndLog) | :1013-1031 / ssotFireGate.ts:108 | backend 기결정 재발사 차단 | 정상 | 확정 아키텍처 정방향(backend 권위) |
| SSoT Gate A/B (SP 3경로) | :1572-1580, 1725-1733, 1808-1816 | 〃 | 정상 | |
| MINIMAL 로컬 발사(FG) | :1068-1074 | FG 배너 | ④(cfg) | 통과 산출물 = ledger+alarmLog+(sleepMode 시 in-app overlay)만 |
| **API imminent 경로 전체 (#396)** | :1375-1450 | lock 열차 arvlCd 즉발 | **①** | `trackedTrainCode`의 writer(`setTripTrainCode`/`captureTripTrainCodeIfAbsent`, tripTrainCode.ts:51/79)가 **프로덕션 호출 0건**(grep 전수) → 항상 null → isImminentByArrivalCode(imminentArrivalSignal.ts:19)가 항상 false. 효과 내부 게이트(silence/movement/imminentKey) 전부 동반 dead. :734 주석 스스로 "미배선 경로" 인정 |
| gate-passed-event-on-lock-origin (#1599) | :421-427 | lock 출발역 SP 차단 | 정상 | 씨앗 목록 게이트 실체, runSilenceGateAndDispatch 최상단 |
| hop-window (FG SP/fg-arvlcd) | :1503-1539, 1686-1719 | 미래 hop 발사 차단 | 정상 | no-source 60s dedup 로그 포함 |
| accuracyOk ∥ arrivalConfirmed | :1459-1463, 1488 | SP GPS 게이트 | 정상 | |
| fg-arvlcd fast-path lock 가드 (#640) | :1657-1663 | lockless 임의열차 발사 금지 | 정상 | lock.trainCode 사용(→tripTrainCode와 무관, 살아있음) |
| subsurface verdict SP 경로 (#1290/#1298) | :1784-1847 | 지하 ≥2합의 발사 | ④(cfg) | `subsurfaceStationDetected`는 barometer subsurface 전제 — useBarometer dormant로 사실상 항상 false |
| FG aux SP 배너 (#2122) | :376-389 / stationNotification.ts:903 | APNs 지연 우회 로컬 배너 | 정상 | **현 구성에서 유일하게 살아있는 device 가시 station 배너**(AppState active+lock 한정). MINIMAL 무관 |

### 1-D. silent push 핸들러 (silentPushTask.ts)

| 게이트 | file:line | 목적 | 판정 | 근거 |
|---|---|---|---|---|
| unknown control kind fail-closed (G6) | :980-995 | 계약 스큐 차단+관측 | 정상 | |
| etaSeconds/phase 값 스큐 (G2) | :605-611 | 계약 drift 관측 후 drop | 정상 | |
| mirror write trip-token mismatch (R11-b) | :1024-1052 | cross-trip mirror 부활 차단 | 정상 | |
| trip-ended tripToken/corrId 가드 | :1116-1148 | 좀비 종료 push 차단 | 정상 | |
| station kind 무발사 (#2064) | :1392-1415 | backend visible 단일 채널 | 정상(아키텍처 정방향) | skip 로그+receipt 관측 |
| boarding-prompt silent no-op (#2069) | :1214-1229 | 구버전 호환 | 정상(전환기 no-op) | |
| sleep companion: sleepMode+ledger | :1590-1634 / alarmLocalAuthority.ts:156 | 취침 TTS/진동 | 정상 | persisted ledger 1h |
| skew-fallback generic 발사 | :1647-1666 | station-like 스큐 안전 발사 | 정상 | |
| **checkSilentPushLocationGate** | silentPushLocationGate.ts:249 | (구)fire 위치 게이트 | **④=사실상 ①** | 소비자(fireWithGate)가 #2064에서 제거된 뒤 **프로덕션 호출 0건**(grep 전수). 333줄 모듈 통째 dead. silentPushTask.ts:151/169/730 주석이 여전히 "silentPushLocationGate가 처리"라고 약속 — 오도 |
| isFallbackDuplicate (firedPushIds) | stationNotification.ts:177/265 | silent 기처리 pushId alert 억제 | 정상 | FG 한정(문서화된 한계) |
| isRecentLocalAuxFireDuplicate / BoardingPromptDuplicate | stationNotification.ts:183-192 | 로컬 발사 후 늦은 backend push 억제 | 정상 | 2차 방어선. boarding-prompt 쪽은 로컬 발사 자체가 ④라 실질 미작동 |

### 1-E. boardingPrompt (device 측)

| 게이트 | file:line | 목적 | 판정 | 근거 |
|---|---|---|---|---|
| useLocalBoardingPromptGate 전체 | useLocalBoardingPromptGate.ts:57-86 | FG 로컬 프롬프트 안전망 | ④(cfg) | MINIMAL OFF 첫 줄 return. HomeScreen.tsx:1141 배선은 존재 |
| evaluateLocalBoardingPromptGate (근접+도착열차) | localBoardingPromptGate.ts:61 | 오탐 방지 2게이트 | ④(cfg) | 상동 |
| #2591 mirror 억제 스택 (legAdvance/corrId/fresh/classify) | stationNotification.ts:992-1103 | 여정 진행 중 프롬프트 억제 | ④(cfg) | fireLocalBoardingPromptNotification 호출자가 위 훅뿐 — 통째 dead. 정교한 5단 로직이 죽은 코드로 유지되는 중 |
| prompt TTL dedup (fire/suppress kind) | stationNotification.ts:1060-1065 | 재발사/재평가 스팸 | ④(cfg)+⑤ | dedup hit 시 로그 0(살아나도 조용) |
| displayed dedup persist (#2677) | useBoardingPromptDisplayLogger.ts:73-125 | 재계수 차단(계측) | 정상 | 관측 전용 |
| boardingPromptContext 빌더 가드 | boardingPromptContext.ts:111-127, 161-201 | backend 등록 컨텍스트 | 정상 | 발사 게이트 아님(등록 입력). backend 프롬프트의 device 측 입력은 살아 있음 |

### 1-F. GPS/fusion 게이트 (표시·후보 채택)

| 게이트 | file:line | 목적 | 판정 | 근거 |
|---|---|---|---|---|
| position-train TTL/거리/consensus/노선/arc/forward 6겹 | useFusedNearestStation.ts:1006-1099 | pt 후보 오채택 차단 | 정상 | #2728 trainMatchArc 거리 우회 배선 확인 |
| lockless 4-signal consensus (#1926) | :1056-1063 | GPS 미사용 결정 원칙 | 부분 ④ | barometer dormant + WiFi dead로 신호원 축소 — accel/cellular만 실효. 문서상 4-signal, 실효 2-signal |
| fusedPasses/routePasses + gpsFallbackStale | :1163-1185 | 거리/staleness | 정상 | |
| WiFi tier | :1205-1228 | WiFi 후보 | ④(cfg) | lookupStationBySsid 항상 null → wifiStation null(useWifiStation도 폴링 skip) |
| detectionVerdictAccepts (≥2합의+0.5km) | :1282-1286 | 지하 verdict 채택 | 사실상 ④(cfg) | barometer-stop 신호 부재로 합의 성립 어려움(arvlcd+motion만 잔존) |
| backend-ssot 채택: line-guard + cross-line guard | :1308-1341 | mirror 오채택 차단 | 정상 | LA(useForegroundLaMirrorSync)와 동일 함수 공유 |
| ssotRouteRegression (#2669/#2686) | :1390-1400 / backendSsotRegressionGuard.ts:72 | 얼어붙은 mirror 역행 차단 | 정상 | stale+ahead 2경로 OR, 배선 확인 |
| **silentPushHealthy 파라미터** | :527 | (구)mirror 신뢰 AND-gate | **①** | #2261에서 소비 제거 후 파라미터만 잔존 — 본문에서 읽는 곳 0. HomeScreen.tsx:257-258이 여전히 계산·전달. useSilentPushHealthCheck 자체는 useSafetyNetScheduler(outage 판정)로 살아 있음 — fusion 배선만 dead |
| sticky unlock 게이트 4종 | stickyStationGates.ts:51-138 | sticky 오해제 차단 | 정상 / 부분 ④ | subsurface 조건(D6)은 barometer dormant로 항상 false → "지하 hold" 분기 dead, 지상 동작은 정상 |
| movement 기반 fusion downgrade (shouldDowngradeFusion ≥2합의) | movementGate.ts:246-288 | fu 튐 차단 | 정상 | flag guard 미적용(헤더 명시) — evaluateMovement와 달리 살아 있음 |
| MAX_ACCURACY_M 이름 충돌 | movementGate.ts:73(100m) vs shared/constants/location.ts:7(200m) | — | ② 주의 | 동명 상수 2개, 값 상이. movement 쪽은 현재 dead라 실해 없음, drift 함정 |
| candidateRejectBuffer / reevalInstrumentation (#2594) | nearest-station/utils | 관측 전용 | 정상 | 게이트 아님 |
| useBoardingLockSync GOOD_FIX 50m + WiFi bypass | useBoardingLockSync.ts:59, 83-86 | 관측 sync 품질 | 정상 / WiFi bypass는 ④(cfg) | WiFi 인자 공급원이 죽어 bypass 분기 도달 불가 |
| useArrivalAutoClear (500m/2s + placeholder 확증 #2716/#2741) | useArrivalAutoClear.ts:63-90 | 도착 자동 종료 | 정상이나 ⑤ | 발동/미발동 모두 로그 0 — trip을 끝내는 부수효과 치고 관측 공백 |

### 1-G. LA/표시 게이트

| 게이트 | file:line | 목적 | 판정 | 근거 |
|---|---|---|---|---|
| shouldSkipDeviceLiveActivityWrite (3-state #2481→#2735) | liveActivityPushChannel.ts:335-356 | backend LA 권위 시 device GPS 쓰기 양보 | 정상 | backendConfirmed+5분 staleness backstop, 상태전이 계측 |
| LA dismiss sentinel (#926) | refreshLiveActivityFromBackgroundContext.ts:110, liveActivityMirrorSync.ts:63 | dismiss 후 부활 금지 | 정상 | |
| GPS write arbitration 5s (#2610) | liveActivityGpsWriteArbitration.ts:22-34 | mirror의 ETA blank 덮어쓰기 방지 | 정상 | in-memory, cross-process 한계 문서화 |
| update-only 가드 (hasActiveLiveActivity) | liveActivityMirrorSync.ts:83 | BG 유령 LA 생성 방지 | 정상 | |
| mirror 단조성 가드 (#2593) | backendSsotMirror.ts:156-194 | 늦은 push 역행 write 차단 | 정상·⑤경계 | 차단 시 logger.info만(콘솔) — alarmLog/덤프 관측 없음 |
| mirror freshness 180s | backendSsotMirror.ts:355 | stale mirror 차단 | 정상 | 3소비처 단일 진입점 |
| mirror-advance dedup (역명:노선) | refreshLiveActivityFromBackgroundContext.ts:225-248 | BG tick마다 LA 깨우기 방지 | 정상 | 환승 노선 키 포함 확인 |
| FG mirror sync dedup+cross-line | useForegroundLaMirrorSync.ts:76-99 | 〃 FG | 정상 | applied=true일 때만 dedup 기록 |
| LA fallback content dedup (#2687) | stationNotification.ts:132-160 | 동일 내용 배너 폭주 차단 | 정상 | suppress 로그 있음 |
| LA mirror 갱신 skip 사유 | liveActivityMirrorSync.ts:64,78,85 | — | ⑤ | 전부 logger.info(콘솔 전용) — 덤프에 안 남음. "LA가 왜 안 움직였나" 진단이 또 막힐 수 있는 지점 |

### 1-H. trip 등록/해제·OS 예약

| 게이트 | file:line | 목적 | 판정 | 근거 |
|---|---|---|---|---|
| hydration null≠종료 storage 가드 (#2673) | useApnsTripRegistration.ts:831-852 | hydrate 순간 trip DELETE 방지 | 정상 | |
| lock-release / route-change debounce (#767/#2197) | :1015-1044 | POST 폭주·transient 해제 차단 | 정상 | 성공 기준 ref 분리 확인 |
| same-trip 재등록 mirror clear 금지 (#2683) | :962-969 | mirror 29회 소거 회귀 차단 | 정상 | |
| register retry/heal 상한 | :384-397 외 | rate limit 보호 | 정상 | |
| safetyNet: sleepMode+outageConfirmed 무장 | useSafetyNetScheduler.ts:45-56, safetyNetScheduler.ts:283-286 | 취침+backend outage 한정 백업 | 정상 | outage 판정=useSilentPushHealthCheck(60s) |
| safetyNet fire-time 재검증 4단 | scheduledAlarmReceiver.ts:228-282 | stale 예약 발사 차단 | 정상 | suppress 시 OS queue+tray 정리 포함 |
| presched 재검증 3단 + cancel류 | scheduledAlarmReceiver.ts:295-317, silentPushTask.ts:1387, stationPrescheduler.ts:45/108 | (퇴역 채널) | ④(무해) | stationPrescheduler에 **schedule 함수가 없음**(cancel/read만 export) — #2202 퇴역. 남은 재검증/cancel은 구빌드 잔존 큐 청소용 레거시 |
| trip-bound cleanups (dedup/mirror/intent reset) | tripBoundCleanups.ts | trip 경계 상태 소거 | 정상 | crossCategoryDedup clear 등 배선 확인 |
| duplicateBoardingLock (#2722) | duplicateBoardingLock.ts:25 | 이중 lock 생성 차단 | 정상 | 3 진입점 공유 확인 |
| lock suggestion 'consensus' 승격 금지 (#2330) | useBoardingLockController.ts:272-275 | 자동 lock 금지(탭 SSoT) | 정상 | 확정 아키텍처 정방향 |
| lastTrainAlarm 7단 skip | lastTrainAlarm.ts:46-82 | 막차 알람 조건 | 정상 | sleepMode 전용 |
| tripDeathPullBackstop 쿨다운 | tripDeathPullBackstop.ts:84-110 | pull 빈도 제한 | 정상 | |

## 2. 주요 경로별 AND 겹 수 (현 빌드에서 살아있는 겹만)

| 경로 | 살아있는 AND 겹 | dead 겹 | 통과 시 실제 산출물 |
|---|---|---|---|
| (a) BG 알람 fire (GPS 파이프라인) | 9 (age/accuracy/jump/dest/dedup/departed/silence/hopWindow/sleep + dedup4종) | 4 (motion, MINIMAL 3경로) | **ledger+alarmLog+위젯/LA만** — visible 0 (backend push가 visible) |
| (b) FG phase fire | 15 (hydration/refId/warmup/accuracy/weak-source/dedup/silence/ledger/in-flight/no-intent/sleep/dedup4/SSoT-A) | 2 (movement, MINIMAL 발사) | ledger+alarmLog+(sleepMode overlay)만 — visible 0 |
| (c) FG station-passed | 10~12 | 2 (movement, subsurface 경로) | FG+lock 한정 aux 배너(유일한 device 가시 station 배너) |
| (d) boardingPrompt 표시 | device 측 0 (backend remote alert 단일) | 로컬 안전망 전체(≈8겹) ④ | backend alert만 |
| (e) LA/표시 갱신 | 6~8 (skip-write/sentinel/arbitration/update-only/단조성/freshness/cross-line/regression) | 0 | LA 갱신 |
| (f) trip 등록/해제 | 5 (storage 가드/debounce 2종/재등록 가드/retry 상한) | 0 | POST/DELETE |

## 3. ①~⑤ 요약 (조치 후보)

### ① 약속됐으나 미배선
1. **#396 API-imminent 경로 사망** — `trackedTrainCode` writer 0건(`setTripTrainCode`/`captureTripTrainCodeIfAbsent` 프로덕션 호출 없음, tripTrainCode.ts:51/79) → useStationAlarm.ts:1375-1450 효과 전체가 상시 no-op. #2728(:734)이 이미 인지 — 경로 삭제 또는 lock.trainCode로 대체 결정 필요.
2. **silentPushHealthy 파라미터** — useFusedNearestStation.ts:527 선언만, 본문 소비 0(#2261 제거). HomeScreen.tsx:257-258 전달부와 파라미터 제거 후보. (훅 자체는 safetyNet outage 판정으로 유효.)
3. **silentPushLocationGate.ts 모듈 전체(333줄)** — 호출 0. silentPushTask.ts:151/169/730의 "silentPushLocationGate가 처리" 주석이 오도. 삭제 후보.

### ② 모순
4. **infoModeEnabled 자동 ON** — HomeScreen.tsx:439(안내 시작)이 자동 stamp → `isLocklessNoUserIntent`(useStationAlarm.ts:203) 게이트와 "명시 의향=lock 동급" 계약(useUserIntentStore.ts:5 "진입점 2개뿐" 문서 포함)이 붕괴. lesson_gpsfree_prompt_path_no_gates_infomode 실증 그대로 잔존. 최우선 결정 항목.
5. **movement 게이트 문서-런타임 모순** — stationPipeline.ts:503/636의 #2483 "flag ON에서도 GPS-static 억제 유지" 서술 vs movementGate.ts:353 전역 bypass(현 빌드 ON). 정적 phantom 방어가 실제로는 0겹.
6. **MAX_ACCURACY_M 동명 이값** — movementGate.ts:73(100m) vs location.ts:7(200m).

### ③ 중복 목적 (dedup 스택 13종+)
7. fire dedup만 나열: firedAlarms(phase) / fireAlarmOnce 30s / cross-category 30s / trip-scoped 5s / phase-phase 3s / channel-agnostic 8min / SSoT Gate A/B / lastNotifiedStationId / recentLocalStationFires 2min / firedPushIds 5min / AlarmLocalAuthority ledger 1h / collapse-id / isRecentLocalAuxFireDuplicate. 특히 **fireAlarmOnce(30s, station+line+kind+phase) ↔ cross-category(30s, station) ↔ channel-agnostic(8min, station+kind+phase)** 3종은 키 공간이 거의 포개진다. visible 발사가 backend로 단일화된 현 아키텍처에선 device dedup의 실효 목적이 "ledger 정합"뿐이라 축약 여지 큼(ADR-038 device fire 영구 삭제와 함께 정리 후보).

### ④ 도달불가 (현 빌드 구성)
8. MINIMAL_ALARM OFF: BG 발사 3경로+내부 게이트 전부, BG/FG 로컬 visible 발사, **로컬 boarding-prompt 안전망 전체(#2422/#2591 mirror 억제 5단 포함)**. #2591의 정교한 억제 로직이 죽은 채 유지·테스트되고 있음.
9. SIMPLE_ARRIVAL_ARCH ON: movement 게이트 전체(FG/BG), WiFi SSID 채널 전체(fusion tier·BG upload 역명·undergroundConsensusFire — 후자는 MINIMAL과 **이중 dead**: 플래그를 켜도 안 살아남), barometer 및 subsurface 파생 게이트(subsurface SP 경로, sticky D6 hold, lockless 4-signal 중 1-signal).
10. presched 채널 잔재: 재검증/cancel 함수들은 구빌드 큐 청소용 레거시(무해하나 표면적).

### ⑤ 조용한 억제
11. **LA 갱신 skip 사유 전부 콘솔 전용** — liveActivityMirrorSync.ts:64/78/85, persistBackendSsotMirror stale-skip(backendSsotMirror.ts:169/180) → 덤프(alarmLog)에 안 남음. "LA가 왜 멈췄나" RCA를 반복해온 이력 대비 관측 공백.
12. **useArrivalAutoClear** — trip을 자동 종료시키는 부수효과인데 발동/억제 로그 0 (useArrivalAutoClear.ts:76-90).
13. 로컬 boarding-prompt TTL dedup hit(무로그) — 현재는 ④라 실해 없음, 부활 시 주의.

## 4. 총평

확정 아키텍처(backend 발사 권위) 기준으로 device는 이미 "표시+ledger+업로드"로 수렴했고, 그 방향과
정합하는 게이트(SSoT Gate, LA 권위/역행 가드, trip 등록 가드)는 대체로 건강하다. 문제는 두 가지 축:
(1) **레거시 발사 시절의 게이트 더미가 두 빌드 플래그 뒤에서 대량 dead 상태로 유지**되며 주석은 여전히
살아있는 것처럼 서술한다(감사 없이 코드만 읽으면 "movement 게이트가 지켜준다"고 오판하게 됨).
(2) 살아있는 fire 경로의 산출물이 visible 0(ledger)인데도 15겹 AND가 걸려 있어, 게이트 1개의 오작동이
ledger 불일치→backend push dedup 오류로 이어지는 경로만 남았다. ADR-038(device fire 영구 삭제) 실행 시
①③④ 항목이 함께 정리 대상이다.
