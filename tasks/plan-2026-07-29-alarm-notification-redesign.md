# 알림≠알람 분리 + 단일 결정자 재설계 (2026-07-29)

4-audit 교차 결과 기반 설계. 스펙 SSoT: 사용자 확정 A/A/A (2026-07-29).

## 0. 스펙 (사용자 확정)

| | 알림 (Notification) | 알람 (Alarm) |
|---|---|---|
| 발사 시점 | 매 역 진입 | 환승역/도착역 **1개 역 전** |
| 근거 신호 | backend cron 역 진입 감지 (SSoT) | 동일 |
| 모드 | 일반 모드. **취침모드 mute** | **취침모드 전용** (일반 모드 loud 알람 = 스펙 위반) |
| 제약 | 동일 알림 5분 1회, **서버 단일 dedup** | "1역 전 = 출발역"이면 발사 금지 (환승·도착 동일) + 등록 시 UI 안내 |
| 아키텍처 | **backend visible push 단일 결정자** (device 관여 X) | **논리적 단일 결정자 + 다중 wake 소스 + 결정적 ID 멱등 발사** |

## 1. 진단 종합 — 회귀 2건 root cause (확정)

### 회귀 ① "5분 제약 걸었는데 동일 알림 반복"
5분 제약은 **backend B1(arvlCd fireOnce 5min + KV 1h)에 실존**한다. 그런데 backend는 silent만 쏘고, 실제 사용자 도달은 device 발사 지점들이 담당하는데 그중 다수가 **그 제약 밖**에 있다:
- OS 사전예약 3종(D5 alarmScheduler / D6 tripBoundScheduler / D7 boardingLockScheduler): 예약 후 OS가 자체 발사 → 런타임 dedup 불가, cancel 성공에만 의존. cancel 누락/BG stale queue = 반복 발사
- D4(fireWithGate 매역 배너): **identifier 미지정 → 스택**, intermediate는 dedupKey=null
- D2/D3: in-memory Set만 → **앱 재시작 시 dedup 기억 소실** → backend 재발사 도달 시 재발사
- device 쪽 8분 backstop은 13개 지점 중 3곳(D1/D4/D10)에만 적용

### 회귀 ② "일반 모드에서도 알람"
- 취침 gate 실재 발사 지점 = 13개 중 **D3 하나뿐**
- D1(sendAlarmNotification): sleepMode 인자를 진동/TTS 세기에만 사용, **alarm.wav 발사는 일반/취침 동일**
- OS 예약 3종: 발사 시점 취침 판정 불가 → 일반 모드 alarm.wav
- backend visible 4종(B7/B9/B12/B13): sleep-agnostic 소리 도달

### 구조 발견
- backend 매역 감지 → **silent push만** (fireArvlCdStationPush → sendSilentPush). visible 배관(sendAlertPush)은 이미 존재 → 전환 지점 명확
- `notificationRouter.ts`(D12) = 단일 발사 라우터 시도 흔적, 프로덕션 호출자 0 (dead)
- apnsEnv stuck: 3중 self-heal 코드 존재(env-heal 재발사 + 즉시 persist + device echo), **런타임 evidence 미확인** (wrangler tail `envCorrected` 필요)
- fixture harness = 스냅샷 평가기. race/횟수 재현은 `alarm/utils` dedup 층 단위테스트가 정답 seam. dumpParser는 sleepMode 미파싱

## 2. 목표 아키텍처

### 알림 파이프 (단일 결정자 = backend)
```
Seoul API → cron 판정(arvlCd) → [sleepMode==on? mute] → [KV dedup 5min/역] → sendAlertPush(visible) → iOS 직접 표시
```
- device는 매역 알림에 대해 **아무것도 안 함** (D4/D10 제거)
- 취침 mute는 backend 분기 → **ADR-023 개정 필요**: "backend sleepMode 분기 금지"는 silent+device렌더 구조 전제였음. 알림(notification)에 한해 backend 분기 허용, 알람은 기존대로 device gate 유지
- visible이므로 ACK/60s-fallback 개념 불필요 → B13 범위 축소

### 알람 파이프 (2026-07-29 시나리오 검증 후 확정 — 원격 visible 주 채널)

시나리오 검증에서 발견된 제약: **원격 push와 로컬 알림은 identifier 체계가 달라 서로 멱등 불가.** 취침+kill 시 silent wake 미동작 → 로컬 알람 miss. 따라서:

```
[주 채널] backend cron → (target-1)역 진입 판정 → [취침모드 아니면 skip] → [1역차=출발역이면 skip]
           → [KV dedup] → sendAlertPush(visible, sound=alarm.wav, interruption-level=time-sensitive)
           → 앱 생사 무관 알람음 도달
[부가]     device 깨어있으면 silent push 수신 → TTS·진동만 재생 (배너 생성 금지 — 이중 방지)
[안전망]   OS 예약 1 스케줄러 (취침모드일 때만 등록, backend reschedule로 시각 보정,
           원격 도달 확인 시 cancel. 발사 시각 = 예상 + 버퍼 → backend outage 시에만 발사)
```
- 정책(취침 전용 · 1역 전 · 1역차 금지)의 단일 소유 = **backend** (주 채널 발사자). device는 로컬 경로(TTS/진동·OS 예약)의 gate만 소유
- 잔여 리스크(수용): 앱 kill + 원격 성공 + cancel 불가 시 OS 안전망이 버퍼 뒤 1회 추가 발사 가능 — outage-miss 방지와의 trade로 수용. NSE에서 pending cancel 가능성은 follow-up 조사
- 결정적 identifier `alarm-<tripToken>-<station>-<kind>` (로컬 경로), 원격은 apns-collapse-id

## 3. 발사 지점 처분표

### Device
| # | 지점 | 처분 |
|---|------|------|
| D1 | sendAlarmNotification (loud) | **제거** — 원격 visible 알람이 대체. TTS/진동 부가 모듈로 축소 (스펙상 일반 모드 알람 없음, 취침은 원격 담당) |
| D2 | boarding-prompt 로컬 | **제거** — B7 visible 단일화 (결정 1-A 확정) |
| D3 | sleep-transfer-alarm | **제거** — 원격 visible 알람(B4 개편)이 대체. TTS/진동 부가만 잔존 |
| D4 | fireWithGate 매역 배너 | **제거** — backend visible push가 대체 |
| D5/D6/D7 | OS 예약 3종 | **1 스케줄러로 통합** + 취침 한정 + 결정적 ID |
| D8 | 막차 배너 | 유지 (알림 카테고리, 1일1회 gate 기존) |
| D9 | 현재역 배너 (LA fallback) | 유지 (FG 정보성) |
| D10 | station-passed 무음 | **제거** — backend visible 대체 |
| D11 | trip-ended 로컬 | **제거** — B12 단일화 (결정 2-A 확정) |
| D12/D13 | dead router/adapter | AlarmDecisionAuthority로 부활 또는 삭제 |

### Backend
| # | 지점 | 처분 |
|---|------|------|
| B1 | arvlCd silent | **visible 전환** + sleepMode mute 분기 (핵심 변경) |
| B2 | vanish fallback | B1과 동일 정책 적용 |
| B4 | sleep-transfer | **silent→visible alert 전환** (알람 주 채널: sound=alarm.wav + time-sensitive) + backend dedup 추가 + 정책 3종(취침 전용·1역 전·1역차 금지) 이관 |
| B7 | boarding-prompt visible | 유지 — prompt 단일 채널 (권고) |
| B8 | boarding-prompt silent | **제거 후보** (B7과 이중, 독립 gate 없음) |
| B9/B12 | hop-end/trip-ended visible | 유지 (일반 모드 소리 정책은 알림 규칙 적용 검토) |
| B13 | 60s alert fallback | 축소 — 매역 알림 visible화로 대상 축소, 알람 계열만 유지 |
| B3/B5/B10/B11/B14 | 상태 sync/LA/retry | 유지 (사용자 비도달 채널) |

## 4. fusion 재정의 (리서치 verdict 반영)

리서치 결론: "지하 GPS 무의미" 전제 = **부분참, 실무적으로 유효**. 타 앱(네이버/카카오)의 지하 열차 위치는 사용자 폰 위치가 아니라 **운영 데이터 피드 렌더링**. Transit App/SubwayPS는 관성센서(90%/85.8%). iOS는 raw WiFi 접근 차단, 지하 CLLocation은 65m~km 오차 + 2분 지연/결측.

- 좌표값: 지상에서만 결정 (기존 유지, 근거를 "위성"→"위치서비스 전반"으로 업그레이드)
- 신설: `horizontalAccuracy < 100m AND age < 15s` 게이트를 fusion 입력에 명시. 미달 시 좌표 tier drop
- 좌표 **품질 저하 자체**를 "지하 진입/이탈" transition 이벤트로 소비 (좌표값 아님)
- 지하 결정 신호 = 운영 데이터(도착 API, 이미 SSoT) 1차 + 관성/기압(기보유 barometer/accelerometer) 보조
- 배터리: 지하 판정 구간에서 위치 정확도 요구·폴링 하향 (발열 회귀 완화)

## 5. 검증 계획

1. **dedup 층 다중소스 시퀀스 테스트**: unifiedFireDedup/crossCategoryStationDedup/fireAlarmOnce에 fg+bg+silentPush 이벤트 시퀀스 주입 → **발사 횟수 assert** (현재 부재한 유일 재현 수단)
2. **fixture 확장**: dumpParser에 sleepMode 파싱 + mode-aware chain stage ("일반 모드에서 알람 발사 = fail")
3. **APNs env 런타임 검증**: wrangler tail `envCorrected` stat + silentPushReachMetric 비-0 evidence (Phase 0)
4. **실기기**: 일반 모드 trip 1회(알림만, 알람 0) + 취침 모드 trip 1회(1역 전 알람 1회, 중복 0) — epic close 조건

## 6. 이슈 분해 (의존 순서)

- **Phase 0 — 런타임 evidence**: APNs env self-heal 실동작 tail 확인 (visible push 전환의 전제)
- **Phase 1 — 알림 전환**: B1/B2 visible화 + backend sleepMode mute + 서버 5분 dedup 단일화 + ADR-023 개정 + D4/D10 제거
- **Phase 2 — 알람 결정자**: AlarmDecisionAuthority 신설 (persisted ledger + 정책 3종) + D1 경유 + OS 예약 3종 통합·취침 한정 + 결정적 ID 전면 적용 + "1역차 금지" UI 안내
- **Phase 3 — 이중 채널 정리**: B7 단일화(B8/D2 제거) + B12 단일화(D11 제거) + B13 축소 + D12/D13 정리
- **Phase 4 — fusion 신호 재정의**: accuracy/age 게이트 + 품질저하 transition + 폴링 하향
- 각 Phase: Wire-completion 5단 + coverage 100% + 검증 계획 항목 매핑

## 7. 사용자 결정 (2026-07-29 확정)

1. boarding-prompt 채널: **1-A 확정** — B7 visible 단일, B8·D2 제거
2. trip-ended 채널: **2-A 확정** — B12 visible 단일, D11 제거
3. 일반 모드 소리: **3-B 확정** — 응답 요구 prompt류(B7·B9)는 sound:default 유지, 정보류(B12)는 무소리 배너. 근거: prompt 응답 = 사용자 확정 flow의 chain 전제 → 놓치면 취침 알람 miss로 전이

## 8. 시나리오 검증 결과 (2026-07-29, 탁상 시뮬레이션 10종)

S1 일반·FG·직행 ✅ / S2 일반·kill (기존 silent 의존 붕괴 지점 → visible로 해결) ✅ / S3 취침·환승 ⚠️→알람 원격 visible 주 채널로 보완(§2 반영) / S4 1역차 금지 ✅ / S5 Seoul API outage → OS 안전망 발사 ✅ / S6 재시작 재발사 → persisted+서버 dedup ✅ / S7 arvlCd 재감지 스택 → 서버 dedup+collapse-id ✅ / S8 WhileInUse-only ✅ / S9 FG visible 수신 → handler 표시 정책 명시 필요(Phase 1-device) / S10 지하 순단 stale push → **apns-expiration 60~90s** 필수(Phase 1-backend)

다운로드 가치: 매역 정확 안내·알람 miss·중복 근절·배터리 모두 개선, WhileInUse 1차·사용자 명시 의향 부합. self-contained 원칙은 **알림에 한해 의도적 이탈** (backend 단일 결정자, 사용자 확정) — ADR에 경계 명시.

## 9. 이슈 분해 (self-contained, code=medium 실행 전제)

| # | 이슈 | 의존 |
|---|---|---|
| E | Epic (close = 실기기 일반 1 + 취침 1 trip evidence) | — |
| I0 | Phase 0: APNs env self-heal 런타임 evidence | — |
| I1 | Phase 1-backend: 매역 알림 visible 전환 + sleepMode mute + expiration/collapse + 서버 dedup | I0 |
| I2 | Phase 1-device: D4/D10 제거 + FG 표시 정책 | I1 |
| I3 | ADR-023 개정 + ADR 신설(알림≠알람 스펙) | — |
| I4 | Phase 2-backend: 알람 원격 visible (B4 개편 + 1역전 판정 + 1역차 금지 + dedup) | I0, I3 |
| I5 | Phase 2-device: 알람 로컬 정리 (D1/D3 제거→TTS/진동 부가 + OS 예약 3→1 통합·취침 한정 + persisted ledger + 1역차 UI 안내) | I4 |
| I6 | 검증 하네스: 다중소스 시퀀스 발사횟수 테스트 + dumpParser sleepMode + mode-aware stage | — (선행 가능) |
| I7 | Phase 3: 이중 채널 정리 (B8/D2/D11 제거 + B12 무소리 + B13 축소 + D12/D13 정리) | I1, I4 |
| I8 | Phase 4: fusion 지하 신호 재정의 (accuracy/age 게이트 + 품질저하 transition + 폴링 하향) | — |
