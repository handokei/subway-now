# 게이트 전수 감사 종합 — 제거/배선/관측 3분류 + 결정 2건 (2026-09-20)

기준: dev `b02cace4`. 전체 인벤토리(게이트별 file:line·판정·근거)는 동반 문서 2개:
- `audit-2026-09-20-gate-census-backend.md` — backend/alarm-worker 전수
- `audit-2026-09-20-gate-census-device.md` — device(src/) 전수 + 빌드 플래그 실측

판정 기준 5종: ① 약속됐으나 미배선 / ② 모순 / ③ 중복 목적 / ④ 도달불가·상시 동일값 / ⑤ 조용한 억제.
주석 불신 — 모든 판정은 호출 전수 grep으로 확증. 스팟체크 5건(seoul-arvlcd writer 0 / evidence
producer 0 / .env 플래그 / silentPushLocationGate 소비자 0 / evaluateConsensusGate 호출 1곳) 메인 세션 재검증 완료.

## 집계

| | ① 미배선 | ② 모순 | ③ 중복 | ④ 도달불가 | ⑤ 조용한 억제 |
|---|---|---|---|---|---|
| backend | 4 | 7 | 4 | 12 | 3 |
| device | 3 | 3 | 1(스택 13종) | 대량(플래그 2개 하류) | 3 |

**핵심 진단**: cron 매역 fire는 명목 19~21겹 AND 중 실효 ~11겹. device는
`MINIMAL_ALARM`(OFF)·`SIMPLE_ARRIVAL_ARCH`(ON) 두 빌드 플래그가 게이트 절반을 dead로
만들었는데 주석은 살아있는 것처럼 서술(#2483 등) — 코드만 읽으면 "movement 게이트가
지켜준다"고 오판하는 상태. 죽은 방어층은 "지키고 있다"는 착시만 준다.

## 결정 2건 (2026-09-20 사용자 확정)

### D1. 무의향 lockless trip = 완전 침묵
안내 시작조차 안 한 trip은 알림 0이 맞다. 따라서 봉인된 consensus lockless fire 경로
(`tryFireConsensusTrainLeg`)는 **봉인 해제가 아니라 제거**. 이중 봉인(ssot=null 영구
no-op + lockAttachable:false 하드코딩)으로 프로덕션 출력 0이었으므로(ADR-037 정합)
삭제해도 잃는 것 없음. 명시의향 trip의 lock 공백 구간(leg-2) 매역 push는
`runLocklessIntermediate`(infoModeEnabled 게이트)가 담당 — 유지.

### D2. 명시의향 stamp 원설계 복원 (#1923 진입점 2개)
"안내 시작"은 trip 등록+프롬프트 수신 opt-in일 뿐, 명시의향이 아니다.
- 안내 시작 안 누름 → lockless → 침묵 (D1)
- 안내 시작 → 탑승 프롬프트만 (거리/신선도 게이트 통과 시)
- 프롬프트 [탑승] 응답 / 열차 직접 탭 → 그때 stamp → lock급 추적+매역 알림
- 프롬프트 무응답 → stamp 없음 → 침묵 유지

fix = HomeScreen.tsx:439 자동 `setInfoModeEnabled(true)` 제거(#1973 wire 철회).
**전제 조건**: `infoModeEnabled` 소비자 전수 downstream 매트릭스 — "안내시작만 한 trip"이
true로 타던 분기 전부가 false로 바뀌는 게 의도와 맞는지 한 줄씩 판정 후 착수. → #2651에 기록.

## 3분류 조치 플랜

### A. 제거 — 삭제해도 동작 불변 (④ 위주)

| 대상 | 근거 (상세는 동반 문서) | 이슈 |
|---|---|---|
| backend evidence 4종(wifi/cellular/accel/time-only) 타입+소비 게이트(adv#4·#6, cellular hard-reject ×2, consensusGate strongCB/strongDB, countStrongEvidence, trySeedOverride, legCandidateFilters 미배선 필터 2종) | 생산자 0건 확증. 폐기된 device-fusion 패러다임 잔재 (2026-09-03 확정 아키텍처) | 신규 |
| backend 도달불가 dedup/가드 4종: arvlCdFireKey·vanish origin키(stationPassedFiredKey 선행으로 히트 불가)·staleSSoT 3분 가드(상시 신선, 주석 자인)·legacyGate(@deprecated 자인) | ④ 전수 표 D·E 섹션 | 신규 |
| backend `tryFireConsensusTrainLeg` 진입점 (D1 결정) | 이중 봉인·출력 0. transferLegConsensus 모듈 자체는 #2754/#2761 재설계 범위라 이 이슈에서 안 건드림 | 신규 |
| device `silentPushLocationGate.ts` 333줄 + 오도 주석 3곳 | 소비자 #2064에서 제거, 호출 0 | **#2759 (기존)** |
| device #396류 API-imminent 경로 (useStationAlarm.ts:1375-1450) | trackedTrainCode writer 프로덕션 0건 → 상시 no-op, 내부 게이트 동반 dead. fg-arvlcd fast-path(#640, lock.trainCode)는 별개 — 유지 | 신규 |
| device MINIMAL_ALARM 하류 dead 경로 전체 + dedup 스택 13종 축약 | ADR-038(device fire 영구 삭제) 실행과 묶는 큰 정리 — 단독 이슈로 쪼개지 않고 ADR-038 착수 시 일괄 | ADR-038 트랙 |

### B. 배선 — 약속됐는데 끊긴 것

| 대상 | 근거 | 이슈 |
|---|---|---|
| **`seoul-arvlcd` motionEvidence writer** (최우선) | writer 0건 → hasArvlcdTrainProgress 상시 false → "GPS 정지+열차 진행" trip이 stationary 오판(stationary-skip·adv#2). 지하 침묵 클래스의 살아있는 root 후보. 확정 아키텍처(서버 열차데이터 권위)와 정합하는 유일한 지하 motion 신호 | 신규 |
| evaluateConsensusGate ↔ boardingPrompt 약속 (env-bypass 2차 검증) + GPS-free 경로 게이트 비대칭(15분 신선도/cross-leg/30분 dedup 부재) | ①-1, ②-5 | **#2641 (기존)** + #2757 |
| transferLegConsensus tick 입력 3종(outage/fetchedAtAgeSec/hopsRemainingToTerminus) + init t0 문제 + CONFIRM_MIN_MATCH_COUNT=2 | leg-2 자동 lock 재설계와 같은 모듈 | **#2754/#2761 (기존)에 기록** |

### C. 관측 추가 — ⑤ (기존 skip 지점에 한 줄씩, #2662 패턴)

| 대상 | 이슈 |
|---|---|
| lock 생성 판정 16곳 무기록 | **#2756 (기존)** |
| device: LA 갱신 skip 사유(콘솔 전용) + useArrivalAutoClear 발동/억제 로그 0 | 신규 |
| backend: vanish 경로 sleep mute D1 무기록 / stationary 오판 D1 무기록 | B의 seoul-arvlcd 이슈에 동봉 (같은 지점) |

### 잔여 소항목 (이슈 없이 기록만 — 착수 시 이 문서 인용)

- MAX_ACCURACY_M 동명 이값(movementGate.ts:73=100m vs location.ts:7=200m) — movement 쪽 현재 dead라 실해 없음, drift 함정.
- stationPipeline.ts:503/636 #2483 주석 "flag ON에서도 GPS-static 억제 유지"는 현 빌드에서 거짓 — 주석 정정 필요.
- adv#2 `userIntentDeclared` seed 스냅샷 vs cron live-OR — 같은 ADR-014 정책 이중 구현.
- silentPushHealthy 파라미터 잔재(useFusedNearestStation.ts:527 미소비, HomeScreen.tsx:257 전달부).
- fire-once ENTERING bucket vestigial(#2506 재결정으로 사문화), adv#5b caller 이중 검증.
- presched 채널 잔재(cancel/read만, 구빌드 큐 청소용) — 무해.
- lockless waypoint shift의 ADR-017 단일 진입점 예외 2곳(scheduled.ts:6805, index.ts:2607 evidence=undefined) — 후자는 문서화된 의도.
