# Backend alarm-worker 게이트 전수 감사 (2026-09-20)

읽기 전용 감사. 기준 커밋: dev b02cace4. 모든 file:line은 `backend/alarm-worker/src/` 기준.
판정: 정상 / ① 약속됐으나 미배선 / ② 모순 / ③ 중복 목적 / ④ 도달불가·상시 같은 값 / ⑤ 조용한 억제.
"추정" 표기 없는 판정은 전부 코드에서 file:line으로 확인함.

## 0. 전제 확인 사항

- **archFlag**: 코드 기본값 `off`(archFlag.ts:23). KV `arch:simple-arrival-v1`로 런타임 전환.
  코드만으로는 프로덕션 현재값을 확정할 수 없음(2026-09-20 세션 기록은 'on').
  `on`일 때 실제로 바뀌는 것(전수):
  - 완화: `evaluateConsensusGate` 무조건 pass(consensusGate.ts:157-159), boardingPrompt #3~#8 skip(boardingPrompt.ts:389-391), Kalman/phase dormant(scheduled.ts:2114-2123, 5113, 6543)
  - 강화: caller-side arvlCd=1 요구 #2022(scheduled.ts:7330-7345), ambiguity 기각 #2014(7360-7371), line-mismatch fallback 차단 #2027(6890-6892), boardingLine 봉인 #2021(2464-2469), arc-overshoot #8 활성(advanceTripPosition.ts:586), fire-once TTL 활성(scheduled.ts:3568), retry/pending queue destination-only #1995
- **hopWindowGate**: backend/alarm-worker 소스에 0건. 현재 코드에 존재하지 않음(과거 제거 또는 device측).
- **SSoT 생성 지점**: `seedSsot` 호출은 scheduled.ts:4224(tryAdvanceAndFireArvlcd), 5361(advanceBoardingLockWaypoint) 단 2곳 — 둘 다 lock 경로. index.ts에는 seed 없음. **한 번도 lock을 가진 적 없는 lockless trip은 SSoT가 영원히 null.**

## 1. 게이트 인벤토리

### A. advanceTripPosition.ts — 단일 mutation 진입점 (게이트 #1~#8)

| 게이트 | file:line | 목적 | 배선 | 판정 | 근거 |
|---|---|---|---|---|---|
| #1 Seed | advanceTripPosition.ts:431 | SSoT 미정착 advance 차단 | 3개 호출 클러스터 전부 사전 lazy-seed(scheduled.ts:4221-4233, 5357-5370) 또는 ssot null 사전 return(6231-6232) | ④(사실상) | wired caller에서 no-seed 도달 불가. 방어용으로는 무해 |
| #2 Motion stationary | :463-469 | 정지 trip advance 차단 | wired | 정상 + ②(부분) | 우회 3종: userIntentDeclared / deviceSyncStale+arvlcd / lock+arvlcd. **단 `ssot.userIntentDeclared`는 seed 시점 스냅샷만**(scheduled.ts:4228, 5364) — cron 게이트들(shouldSkipStationary :1574, reschedule :6073)은 `tripHasDeclaredIntent(trip)` live-OR인데 #2만 stale 스냅샷. 같은 정책이 두 방식으로 갈라짐 |
| cellular hard-reject | :501-508 | 환경-vote 모순 차단 | **`evidence.cellularTechVote` producer 0건** (전수 grep — 5곳 모두 소비측) | ④ | vote 항상 undefined → `cellularContradictsEnvironment` 항상 false. consensusGate.ts:162의 동일 체크도 동반 inert |
| #3 env-consensus | :509-520 | 지하 GPS-only false positive 차단 | evaluateConsensusGate 유일 호출부(:510) | ②+④(부분) | lock+arvlcd(:462), lock+position-train(:489-493) 전부 bypass → **실제 평가 대상은 consensus-train evidence(scheduled.ts:6308) 하나뿐**. 그런데 caller가 `gatePassed:true` 하드코딩(4292/5390/6321) → 'base-gate-failed' reason(:191) 도달불가. surface는 상시 pass, underground는 strongG 상시 pass, **mixed/unknown은 lockAttachable:false 하드코딩(6321) 탓에 상시 reject**(consensusGate.ts:187-193 — mixed 분기에 strongG OR가 없음). 즉 hybrid(FB) 역 + 역명 lookup miss 역에서 consensus-fire 영구 차단 |
| #4 time-only 거부 | :523-525 | ADR-015 §E4 | 'time-only' evidence producer 0건 | ④ | 규범 선언으로만 의미. 실제 시간적분 advance(vanish-fallback)는 `arvlcd-confirmed-train`으로 위장 stamp(scheduled.ts:4911 — 주석 자인)돼 이 게이트를 애초에 안 만남 — 선언과 실태의 괴리(② 성격 겸함) |
| #5 train identity | :529-536 | lock.trainCode 불일치 차단 | wired | 정상 | 매역 fire의 실질 방어선 |
| #5c position-train identity | :542-549 | #2623 P1-1 대칭 방어 | wired(scheduled.ts:5197-5207 stamp) | 정상 | |
| #5b consensus confirmed | :557-567 | confirmed에서만 발사 | wired | ③ | caller(tryFireConsensusTrainLeg:6302-6303)가 justConfirmed tick에만 호출 → 게이트는 같은 조건 재검증. demote-revoke 재평가 목적이라지만 caller가 confirm 외 tick에 호출 자체를 안 하므로 실효 없음 |
| #6 lockless-arvlcd-alone | :570-575 | bare-arvlCd 단독 advance 차단 | **'arvlcd-lockless' producer 0건** | ④(이중) | (1) evidence type 미생산 → 분기 도달 불가. (2) 도달해도 `countStrongEvidence`(:295)는 motionEvidence signal의 `.type/.evidenceType` 키를 찾는데, 유일한 writer `updateSsotMotion`(motionState.ts:218-226)은 `{lat,lng,motion}`만 stamp → 카운트 상시 0 → 상시 차단. 이중 inert |
| #8 arc-overshoot | :586-588 | 시간적분 폭주 차단 | wired(4269, 5374-5382) | 정상(flag 조건부) | archFlag='on'일 때만 활성 |
| #7a jump 가드 | :599-615 | position-train 점프 차단 | wired | 정상 | |
| #7b stale 가드 | :616-621 | Seoul stale snapshot 차단 | 유일 producer가 `positionEntryFetchedAt: now` stamp(scheduled.ts:5201 — 주석 자인 "false reject 없음") | ④ | age 상시 0 → 상시 pass |
| trySeedOverride (E5) | :759-782 | strong evidence 2+로 seed 정정 | **호출부 0건** | ① | 헤더(:57-59)가 E5 기능으로 약속. export만 존재 |

### B. consensusGate.ts

| 게이트 | file:line | 판정 | 근거 |
|---|---|---|---|
| evaluateConsensusGate | consensusGate.ts:149 | ① | boardingPrompt.ts 주석 3곳(:24-27, :197-201, :365-369; 추가 :407-409)이 "caller(scheduled.ts)가 evaluateConsensusGate로 별도 검증"을 약속하나 scheduled.ts 호출 0건 — 유일 호출부는 advanceTripPosition.ts:510 (#2641 재확인). **environment-bypass로 GPS 게이트를 skip한 boardingPrompt는 약속된 2차 합의 검증 없이 발사됨.** archFlag=on 분기만 caller-side 검증(#2022/#2014)이 실존 |
| underground strongCB/strongDB | :177-178 | ④ | positionTrainAgreement는 lockless position-train caller가 없어, wifiSsidMatch는 'wifi-ssid-match' producer가 없어 상시 undefined |
| mixed 분기 | :186-193 | ② | underground에는 strongG(consensusConfirmed) OR가 있는데(:182-183) mixed에는 없음 → consensus-train(lockAttachable=false)이 mixed/unknown에서 상시 reject. 설계 SSoT(#2323 "confirmed=lockAttachable surrogate")와 모순 |
| isLockLineAllowed / computeAllowedLines | :245, :211 | 정상 | lockSwap.ts:102, legCandidateFilters.ts:61에서 실사용 |

### C. boardingPrompt.ts (게이트 함수 자체)

| 게이트 | file:line | 판정 | 근거 |
|---|---|---|---|
| repeat gate(silence/cap3/5분 간격) | boardingPrompt.ts:261-282 | 정상 | GPS 경로·GPS-free 경로가 동일 ledger 공유(#2531) — 더블발사 구조 차단 확인 |
| GPS geometry #3~#6 | :288-331 | 정상(surface 한정) | underground/mixed/unknown + archFlag=on에서 bypass — bypass 시 약속된 consensusGate 보강이 미배선(위 ①) |
| motion #8 | :414-426 | 정상 | bypass env에서는 stationary만 차단 |
| fused speed #7 | :337-352 | 정상(surface 한정) | |
| 'window-too-small' reason | :147-160 유니온 | ④ | MIN_WINDOW_SAMPLES=1 이후 boardingPrompt 자체에서는 미생산 — 유일 생산처는 buildSignalsFromEvidence의 synthetic fail(advanceTripPosition.ts:367)인데 gatePassed 상시 true라 그 분기도 도달불가 |
| evaluateSilenceGate(already-fired) | :225-240 | 정상 | hop-end/leg-2 전용 1회 정책 |

### D. cron 매역 fire 경로 (fireArvlCdStationPush + 주변)

| 게이트 | file:line | 판정 | 근거 |
|---|---|---|---|
| sleep mute | scheduled.ts:3480-3494 | 정상 | #2662로 D1 전이 기록 추가됨(⑤ 해소) |
| stationPassedFiredKey 경로무관 dedup(#2571) | :3501-3517 | 정상 | 실질 SSoT dedup. 3경로(arvlCd/position/vanish) 공유 |
| stale SSoT 가드(3분) | :3519-3559 | ④ | 주석 자인(:3524-3526): 호출 직전 advanceTripPosition이 lastAdvanceAt=now 갱신 → staleMs≈0 상시. 두 진입 경로(tryAdvanceAndFireArvlcd:4342, tryFireConsensusTrainLeg:6343) 모두 advance 성공 후에만 호출 |
| fire-once TTL(flag=on) | :3567-3601 | ③+④(부분) | stationPassedFiredKey(trainCode 포함 키)가 앞서 차단 — fire-once가 추가로 잡는 건 vanish-swap으로 trainCode가 바뀐 케이스뿐. ENTERING 전용 bucket(:2317-2322, #2448)은 stationFiredKey가 역당 1개를 강제해 "진입 1회+도착 1회" 정책이 이미 사문화(#2506이 재결정) — bucket 분리 자체가 vestigial |
| arvlCdFireKey dedup | :3602-3629 | ④ | stamp가 stationFiredKey와 항상 동시(:3798, :3801, 동일 TTL 1h)이고 stationFiredKey 검사가 선행(:3501) → 이 검사에서 히트할 수 있는 상태가 존재하지 않음 |
| cross-station 45s 윈도우(#1367) | :3634-3666 | 정상 | 다른 역 연속 발사 억제 — 여전히 도달 가능 |
| legacyGate evaluateArvlCdFireGate | :2394-2404, 호출 :5120 | ③+④ | @deprecated 자인(:2389-2392). lock-expiry 절반은 상류 isBoardingLockActive(동일 now)와 모순돼 도달불가(:5150-5155 주석 자인). 실효는 "arvlCd null?" 분기 하나 — 그마저 #2571로 vanish-fallback 발사로 회수됨 |
| T7 transferDestinationGate(arvlCd 경로) | :4241-4264 | 정상 | 2 cycle(≈180s) 관용. deviceSyncStale 시 신선도 절반 dormant(transferDestinationGate.ts:203-208) — 위치 일치 절반은 유지 |

### E. vanish-fallback / release 경로

| 게이트 | file:line | 판정 | 근거 |
|---|---|---|---|
| sleep mute | :4436-4443 | 정상 | ⑤ 성격: 이 경로 sleep skip은 D1 기록 없음(log only — #2662가 arvlCd 경로만 커버) |
| stationPassedFiredKey | :4446-4454 | 정상 | |
| vanishFallbackFireKey / vanishReleaseFireKey | :4455-4476 | ④+② | stamp가 stationFiredKey와 동시(:4638-4640) + stationFiredKey 검사 선행 → 도달불가. 또한 origin별 키 분리의 원 의도(:4402-4409 "release 후 재부착 시 같은 역 재발사 허용")는 #2571 station 단위 dedup이 무효화 — 의도와 실동작 모순 |
| T7(vanish, cycles=0) | :4488-4509 | 정상 | 약한 evidence에 더 엄격한 관용치 — 계층 의도대로 |
| motion 게이트(isFallbackAdvanceBlockedByMotion) | :4846(fallback), :4938(release) | 정상+② | 실사용 중인데 함수 선언부(:489-503)는 @deprecated "신규 호출 X" — 문서와 실태 모순(코드 자체는 유효) |
| hop-elapsed 시간 게이트 | :4834-4835 | 정상 | FALLBACK_HOP_SEC 90s |

### F. consensus 경로 (tryFireConsensusTrainLeg + transferLegConsensus + legCandidateFilters)

| 게이트 | file:line | 판정 | 근거 |
|---|---|---|---|
| SSoT null / currentStationId 없음 사전 return | scheduled.ts:6231-6232 | ②(구조) | seedSsot는 lock 경로 2곳만 → **한 번도 lock이 없던 C-OFF trip은 consensus 경로가 영구 no-op**. 도달 가능한 건 leg-1에서 lock을 가졌다가 환승 release된 trip뿐. legConsensus 프로덕션 출력 0(ADR-037) 정황과 일치 |
| filterCandidateLine | :6245 | ④ | 인자가 후보 열차가 아니라 `waypoint.line` — computeAllowedLines가 waypoints line을 union에 포함(consensusGate.ts:228-230)하므로 항등 참. 루프 불변식이라 후보별 필터 역할 0. 직전 :6244 matchLine이 실질 필터 |
| filterCandidateDirection | :6246-6250 | 정상 | 후보 isUp vs 추론 방향 |
| filterCandidateBranchTerminus | legCandidateFilters.ts:124 | ① | #2328 설계 필터 ③(지선) — 호출부 0건 |
| filterCandidateExpressStop | legCandidateFilters.ts:161 | ① | #2328 설계 필터 ④(급행 not-applicable) — 호출부 0건. 급행 후보의 미정차역 미관측이 mismatch로 오집계될 수 있는 채로 방치 |
| outage hold | transferLegConsensus.ts:315-318 | ④(미배선) | caller tick은 `{now, observations}`만 전달(scheduled.ts:6296) — outage 플래그 미전달 → Seoul 장애 tick에도 confidence hold가 안 걸리고 missedTicks 누적→mismatch→suppress로 흘러갈 수 있음 |
| stale 관측 hold(fetchedAtAgeSec) | :187-189, :230-232 | ④(미배선) | observations에 fetchedAtAgeSec 미전달 → isStale 상시 false |
| ambiguous-near-terminus suppress | :280-295 | ④(미배선) | hopsRemainingToTerminus 미전달 → ambiguous는 영구 ambiguous(발사 없음) — suppress floor 공급도 이 분기로는 발생 불가 |
| CONFIRM_MIN_MATCH_COUNT=2 (연속확증) | :37, :259-273 | ② | #2754 실증 그대로: 다음 waypoint arrivals에 2 tick 연속 남아야 confirm — 사용자가 탄 열차는 그 역에 도착 즉시 출발해 창(~30s)이 cron 60s와 엇갈리면 구조적으로 confirm 불가. "타고 떠난 열차 구조적 배제" |
| init 창 hard-reject + 빈 후보 → terminal suppress | :127-135 + :246-257, t0=lastAdvanceAt(scheduled.ts:6291) | ②(추정) | lastAdvanceAt이 오래됐으면 창 [t0+0.5W, t0+1.5W+H]이 전부 과거 → 후보 0으로 init → 다음 tick survivors=0 → 'suppressed(all-mismatch)' terminal(:311-313). 잘못된 t0 하나로 leg 전체 발사권 영구 소멸 경로. 실측 미확인이라 추정 |

### G. boardingPrompt 발사 경로들 (scheduled.ts)

leg-1 GPS 경로 `evaluateAndMaybeFireBoardingPrompt`(:7051):
F2 lock(:7065) → legAnchor(:7083) → geo/display(:7096) → cross-leg #2351(:7116-7126) → 신선도 15분(:7163-7176) → too-far(:7179-7189) → 30분 auto-dedup(:7201-7213) → 9단 게이트(:7248) → [flag=on: arvlCd=1(:7330)+ambiguity(:7360)] → 후보 0건(:7375) → trainCode dedup(:7391) → 발사. — 전부 wired, 판정 정상. 단 bypass env에서 consensusGate 약속 미배선(①, 위 B).

GPS-free 경로 `maybeFireOriginBoardingPromptGpsFree`(:7700):
legAnchor → display → infoMode → lock → #2653 거리가드(corroboration 조건부) → repeat gate → trainCode dedup → 후보 0건. — 판정 ③/②(비대칭):
- **GPS 경로에 있는 15분 신선도 게이트(PROMPT_FRESHNESS_MS)가 없음** — GPS 죽은 지하에서 스냅샷 distrust되면 trip 수명 내내(최대 6h lifecycle까지) 발사 가능. cap 3회로만 상한.
- **#2351 cross-leg stale 가드(headWaypoint.line != display.line) 없음** — origin leg 이탈 후에도 origin 프롬프트 발사 가능(레거시 KV 케이스).
- AUTO_PROMPT_DEDUP_WINDOW(30분) 미적용.
같은 목적의 두 경로가 서로 다른 게이트 집합 — #2651("게이트 0개")은 #2653으로 부분 보강됐으나 완전 대칭은 아님.

leg-2 `maybeFireLegBoardingPrompt`(:7934): walk-gate(:7964-7977) + hop-end silence(:7979) + 후보 0건 — 정상.
hop-end `maybeFireHopEndPrompt`(:8071): state map + KV 마커(:8106-8108) + silence — ③(3겹 dedup)이나 요청-병렬 race 대응 의도 명시(:2347-2358) — 정상.

### H. cron 메인 루프 / 인프라 게이트

| 게이트 | file:line | 판정 |
|---|---|---|
| hasActiveTripsMarker(#2452) / cronIdleGate(#2073) | activeTripsGate.ts:90, cronIdleGate.ts:57 | 정상 — 실패 시 보수(강행) 방향 |
| lifecycle silence/force-end(#1652) | scheduled.ts:1526-1548 | 정상 |
| POLLING_WINDOW 사전 skip | :1550-1553 | 정상 |
| shouldSkipStationary(V8d) | :413-429, 호출 :1567-1588 | 정상 — 우회 3종 전부 wired |
| isBoardingLockActive(#640) | :1186-1191 | 정상 |
| leg-2 streak(#2539) | :1620-1656, boardingAnchorResolver.ts:124 | 정상 |
| walk-gate(resolveActiveLegOrigin) | boardingAnchorResolver.ts:303-307 | 정상 — allowLegTransfer와 무관하게 강제 |
| recptnMs>0 신선도(resolver) | boardingAnchorResolver.ts:170-172 | 정상 — #2751(recptnMs 상시 0)이 이 게이트를 영구 차단시켰던 결함, 5b5ead8e로 해소 |
| la-stale backstop + survived-silence(#1933/#2322) | :1714-1744 | 정상 |
| boardingCommittedSuppressed(#2524) | :1820-1827 | 정상 |
| dedupeTripsByDeviceToken(#2175) | :1438 | 정상 |
| destination cross-check(#1707)+backstop(#2230) | :5444-5513 | 정상 |
| maybeReschedulePush: motion+15s 임계+dedup(#2230) | :6063-6100 | 정상 — no-ssot fallback은 legacy 통과(카운터로 관측) |
| LA 게이트(30s dedup/90s heartbeat/즉시 trigger) | :5991-6021 | 정상 |
| sleep/prepare alarm trigger+1h dedup+rollback | :2733-2749, :2806-, :3022- | 정상 — 상호배타 확인(:3024-3027) |
| kill switch lockless intermediate(#1967) | :6604-6611 | 정상(deps 주입, 기본 off) — push만 게이트, advance/취침알람 비대상 확인 |

### I. runLocklessIntermediate 내부

| 게이트 | file:line | 판정 | 근거 |
|---|---|---|---|
| phase 게이트(#825) | :6558-6569, stationPhase.ts:294-298 | 정상(조건부 dormant) | nearestStationDistanceM 미수신 또는 archFlag=on이면 null → 허용 방향 dormant |
| motion 게이트(#1315) | :6584-6595 | ②(자인) | 주석(:6576-6583) 스스로 ADR-014 위반 인정 — 지하 C-토글 trip의 ENTERING을 stationary/unknown에서 보류. lock 경로에는 없는 게이트라 명시의향 동급 보장 미달. 근본 해소는 lock 승격 트랙(#2560 등)으로 이관됨 |
| lastFiredPhase dedup | :6549-6552 | ④(사실상) | 'imminent' set(:6765) 후 같은 호출에서 shift(:6805)+reset(:6813)+putTrip(:6817) — persist되는 값은 항상 undefined. 'imminent'가 저장되는 경로는 중간 crash뿐(추정) |
| lockless waypoint shift가 advanceTripPosition 미경유 | :6805 | ②(구조) | ADR-017 "단일 mutation 진입점"의 예외 — lockless intermediate/transfer(completeWaypointAdvance :6415)는 SSoT 게이트 없이 waypoints를 직접 shift. SSoT.currentStationId는 lockless 진행을 따라가지 못함 |

### J. index.ts 관련 (참고 — 요청 범위의 경계)

- `/boarding-lock/sync` → advanceBoardingLockWaypoint(**evidence=undefined**, index.ts:2607-2616) — T5 SSoT 6단 게이트 전체를 의도적으로 skip하는 살아있는 경로. #2624 monotonic 가드(:2853)+accuracy≤50m+5s 디바운스가 대체 방어. 문서화된 의도지만 "모든 advance는 6단 게이트"라는 ADR-017 선언 기준으로는 ② 예외.
- tripRegisterRateLimit(:817) — 정상.

## 2. 주요 경로별 AND 겹 수

| 경로 | 통과해야 하는 게이트(순서) | 총 겹 | 그중 ④(inert/상시 동일값) |
|---|---|---|---|
| (a) cron 매역 fire (lock+arvlCd 확증) | expiry → lifecycle → polling-window → stationary-skip → lock-active → estimate.arrived → legacyGate → [T7(transfer/dest만)] → adv#1 → adv#2(lock bypass) → cellular → adv#3(bypass) → adv#4 → adv#5 → adv#8(flag) → sleep → stationFiredKey → staleSSoT → fire-once(flag) → arvlCdFireKey → cross-station45s | **19~21** | **6** (legacyGate 절반, adv#1, cellular, adv#4, staleSSoT, arvlCdFireKey) + bypass로 상시 통과 2(adv#2/#3) |
| (b) boardingPrompt leg-1 GPS 경로 | F2 → legAnchor → geo/display → cross-leg → 신선도15분 → too-far → 30분dedup → repeat(silence/cap/간격) → [GPS #3~#7 또는 env-bypass] → motion#8 → [flag=on: arvlCd=1+ambiguity] → 후보0건 → trainCode-dedup | **13~17** | 0 — 단 env-bypass 시 약속된 consensusGate 층이 ①로 부재 |
| (b') boardingPrompt GPS-free 경로 | legAnchor → display → infoMode → lock → 거리가드(조건부) → repeat → trainCode-dedup → 후보0건 | **8** | 0 — 대신 GPS 경로 대비 3개 게이트(15분 신선도/cross-leg/30분 dedup) 결여 |
| (c) advanceTripPosition 자체 | #1 → trip존재 → #2 → cellular → #3 → #4 → #5 → #5c → #5b → #6 → #8 → #7a → #7b | **13 슬롯** | **5** (cellular, #4, #6, #7b, + #1 사실상) / 상시-통과 1(#3 surface·gatePassed 하드코딩) |
| (d) leg-2 자동 lock (cron) | lock-inactive → infoMode → walk-gate → subwayId → direction(관용) → recptnMs 신선도 → 단일후보(unambiguous) → streak≥2 | **8** | 0 (전부 실효 — 단 #2751 이전엔 recptnMs 게이트가 상시-거짓 ④였음) |
| (e) consensus-train fire (C-OFF leg-2) | intermediate-kind → SSoT 존재(구조 제약) → arrivals>0 → arvlCd≠null → matchLine → line필터(④) → direction필터 → window eligible → 단일생존+match≥2 → adv#2(우회없음) → cellular(④) → adv#3(mixed 상시 reject) → adv#5b → fireArvlCd 체인(위 6겹) | **~19** | 4+ (line필터, cellular, adv#3 base-fail, staleSSoT…) + 구조적 도달 제약(SSoT/2-tick) |

## 3. ①~⑤ 요약 (조치 후보)

### ① 약속됐으나 미배선 — 4건
1. **evaluateConsensusGate ↔ boardingPrompt** (boardingPrompt.ts:24-27/197-201/365-369 vs 호출 advanceTripPosition.ts:510 1곳) — #2641 재확인. env-bypass 발사 경로에 약속된 2차 합의 층이 없음. 조치: 배선하거나 주석 3곳의 약속을 삭제해 실태와 일치시킬 것.
2. **trySeedOverride(E5)** (advanceTripPosition.ts:759) — 호출 0건. seed 오정착 자가치유 기능이 통째로 미배선. 조치: wire 또는 제거.
3. **filterCandidateBranchTerminus / filterCandidateExpressStop** (legCandidateFilters.ts:124/161) — #2328 설계 필터 ③④ 미배선. 급행 후보 mismatch 오집계 방어 부재.
4. **transferLegConsensus tick 입력 3종** (outage/fetchedAtAgeSec/hopsRemainingToTerminus — scheduled.ts:6296이 미전달) — outage hold·stale hold·ambiguous suppress가 전부 죽어 있음. Seoul 장애 tick에 mismatch 누적→오suppress 위험.

### ② 모순 — 7건
1. **consensusGate mixed 분기에 strongG 부재** (consensusGate.ts:186-193) — consensus-train이 lockAttachable:false 하드코딩(scheduled.ts:6321)과 결합해 hybrid/unknown 역에서 상시 reject. underground와 정책 비대칭.
2. **연속확증 2회(CONFIRM_MIN_MATCH_COUNT)** (transferLegConsensus.ts:37) — #2754 실증: 타고 떠난 열차 구조적 배제. 게이트 목적(오매칭 방어)과 지배적 실사용 케이스가 충돌.
3. **vanish origin별 dedup 키 의도 무효화** (scheduled.ts:4402-4409 vs :3501/:4446 stationFiredKey 선행) — "release 후 재부착 재발사 허용" 의도가 #2571로 사라짐.
4. **adv#2 userIntentDeclared가 seed 스냅샷** — cron 게이트들은 live-OR(tripHasDeclaredIntent), advance #2만 stale 필드. 같은 ADR-014 정책의 이중 구현.
5. **GPS-free 프롬프트 경로의 게이트 비대칭** — GPS 경로의 15분 신선도/cross-leg/30분 dedup 부재.
6. **lockless waypoint shift가 단일 mutation 진입점 미경유** (scheduled.ts:6805, completeWaypointAdvance 경유 lockless transfer 포함) + `/boarding-lock/sync` evidence=undefined 우회(index.ts:2607) — ADR-017 선언과 실태 불일치(후자는 문서화된 의도).
7. **runLocklessIntermediate motion 게이트**(scheduled.ts:6584) — 자인 주석대로 ADR-014 동급 보장 위반 상태로 잔존.

### ③ 중복 목적 — 4건
1. arvlCdFireKey ↔ stationPassedFiredKey ↔ fire-once TTL ↔ cross-station 윈도우 ↔ APNs collapse-id — 매역 fire dedup 5겹. 실효는 stationFiredKey+cross-station+collapse-id 3겹, 나머지 2겹은 ④ 또는 vestigial.
2. staleSSoT 가드(3분) ↔ T7 신선도(180s) — 주석 자인 사실상 동일 임계(scheduled.ts:2599-2608), 게다가 staleSSoT는 ④.
3. legacyGate ↔ advanceTripPosition — @deprecated 자인, T4~T7 migration 완료 후 미제거.
4. adv#5b ↔ caller justConfirmed 조건 — 동일 조건 이중 검증.

### ④ 도달불가/상시 동일값 — 12건 (위 표 참조)
cellular hard-reject(×2곳), adv#4 time-only, adv#6(이중), adv#7b stale, adv#1(사실상), staleSSoT 가드, arvlCdFireKey, vanish origin-key, filterCandidateLine, 'window-too-small'/'base-gate-failed' reason, fire-once ENTERING bucket, lastFiredPhase dedup(사실상), consensusGate strongCB/strongDB.
→ 이들은 "지키고 있다"는 착시만 주는 죽은 방어층. 특히 **cellular/wifi/accel/time-only/arvlcd-lockless 5개 evidence type은 생산자가 0**이라 STRONG_EVIDENCE_TYPES 기반 로직 전체(countStrongEvidence, seedOverride 요건 포함)가 공회전.

### ⑤ 조용한 억제 — 3건 (대부분 #2662로 해소됨)
1. **hasArvlcdTrainProgress**(motionState.ts:113-129) — 'seoul-arvlcd' evidence writer 0건 → 상시 false. 결과: 지하 GPS 정지 + 실제 열차 진행 중인 trip이 'stationary'로 판정돼 stationary-skip/adv#2에 걸리는데, 이 오판을 D1 어디에도 남기지 않음(motion-transition은 wrangler tail console.log뿐, motionState.ts:168-180). ④+⑤ 복합 — 사용자 영향 있는 최상위 후보.
2. vanish 경로 sleep mute(scheduled.ts:4436) — log only, D1 기록 없음(#2662는 arvlCd 경로만).
3. tryFireConsensusTrainLeg의 `ssot===null` 조기 return(scheduled.ts:6232) — 카운터/로그/D1 전무. lockless-미seed 구조 제약과 겹쳐 "consensus가 안 도는 이유"가 관측 불가.

## 4. 씨앗 목록 대비 확인 결과
- evaluateConsensusGate 미배선: **확증** (①-1).
- stale SSoT 가드: 존재하나 ④ (자인 주석 포함).
- dedup skip / legacyGate mismatch / fire-once / hopEndPromptFiredKey / walk-gate / phase 게이트+면제(#2711 lock-trainCode 면제=adv#2/#3 bypass) / leg-consensus streak / motion gate: 전부 위 표에 판정.
- hopWindowGate: **현재 코드에 존재하지 않음** (grep 0건).
- archFlag 'on'이 skip하는 게이트: §0 전수 목록 — "게이트 #3~#8 skip"은 boardingPrompt(9단 중 #3~#8)에 대한 서술로 정확. advanceTripPosition 쪽은 #8을 오히려 켠다.
- GPS-free 경로 #2532/#2651: #2653 거리가드로 부분 보강, 잔여 비대칭은 ②-5.
