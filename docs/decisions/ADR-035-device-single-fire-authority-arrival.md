# ADR-035 — 도착알람 도메인 Device 단일 fire 권위 (ADR-026 대체)

- **Status**: DRAFT (2026-08-27, 사용자 방향 승인: "발사 단일화 = device 권위")
- **Supersedes**: ADR-026 (backend 단일 emitter — 현장 전제 실패로 반전, 아래 Context)
- **Consolidates**: ADR-032 (device-primary, HOLD), ADR-033 (매역 Device-FG 권위, Proposed)
- **범위**: **도착알람 도메인만** (station-passed / transfer / destination visible 발사). boardingPrompt·취침알람·trip-end·train-reconfirm은 별도 도메인 — 본 ADR 밖.
- **근거**: 2026-08-27 fire-chain 3방향 전수 audit (device fire 경로 / backend fire 경로 / flag·arbitration)

---

## 첫 줄 원칙

**도착알람의 발사(emit) 권위는 device 하나여야 한다.** iOS 식별자 공간 분리상 emitter가 2개면 이중발사를 물리적으로 못 막는다(ADR-026 §2). ADR-026은 그 emitter를 backend로 골랐으나 현장에서 backend push가 실기기에 안 떠 실패했다. device는 잠금화면 포함 모든 상태에서 발사 가능함이 입증됐으므로(#2379/#2384), 단일 emitter는 **device**다.

---

## ⚠️ 검증 상태 (confirmed vs assumed — 정직, 2026-08-27)

이 ADR은 **가설**이다. 토대 주장의 검증 상태를 명시한다. 커밋/구현 전 ❌ 항목을 실제 검증해야 한다.

| 주장 | 상태 | 근거/필요 |
|---|---|---|
| 잘못된 "역 통과 어린이대공원" = backend visible push | ✅ 확정 | D1 `trip_events`: 08-27 06:32:52 KST backend cron-fire-attempt 어린이대공원 station-passed outcome=sent. device fired엔 없음 |
| 그게 어느 backend 함수(`fireArvlCdStationPush` vs vanish) | ⚠️ 미확정 | D1 `trip_events.kind='cron-fire-attempt'`는 origin 구분 안 함. AE reason(arvlcd/vanish)은 binding commented로 no-op. (ADR은 둘 다 퇴역이라 영향 적음) |
| device↔backend **동일 waypoint** 이중발사 | ✅ **확정** | D1: backend 군자 06:30:52 + device 군자 06:31:00 (8초 차, 동일 역 station-passed). 실증됨 |
| device가 잠금/지하서 도착알람을 **안정 커버** | ❌ 미확인 | 뚝섬 destination은 BG fired 확인, 그러나 종합 커버리지·지하(#2384) 미검증. **Phase1의 실체** |
| backend push가 실기기에 안 뜸 | ⚠️ 08-24 RCA | 현재 빌드/apnsEnv 재검증 안 됨 |
| MINIMAL_ALARM=true (device-authority 활성) | ⚠️ 코드로 확정 불가 | DebugModal로만 확인 (flag audit 명시) |

**함의**: 확정된 문제는 좁다 — "backend가 조율 없이 **잘못된 내용**의 visible push를 쏜다". "동일 waypoint 이중발사"와 "device가 backend 없이 다 커버한다"는 **미검증**. 따라서 backend 퇴역(Phase 2)은 device 커버리지 실증(Phase 1) 없이는 정당화 안 됨 — 아래 sequencing이 hard-gate인 이유.

---

## Context

### 왜 ADR-026(backend 단일)에서 방향이 반전됐나 (현장 근거)
ADR-026은 두 전제 위에 섰고, 둘 다 무너졌다:
1. **"backend push가 device에 도달한다"** → 실패. #2379 RCA(2026-08-24): *"backend push는 실기기에서 표시 안 됨(fired=2인데 화면 0) → 잠금 알람 전멸."* device 로컬 발사를 #2067이 제거해 알람이 0이 됨 → #2379가 device 발사를 **복원**.
2. **"트립 등록이 신뢰성 있다"(ADR-025 선행)** → 미달성. rotation 사가(#1986→…→#2175) + 08-27 덤프 `POST /trips 500` 여전.
그리고 패러다임 결정(`feedback_device_self_contained_fusion`): backend/GPS/WiFi 다 죽어도 device 보장.

### 진짜 결함 = 전환 미완료 (audit로 확정)
#2379는 REPLACE가 아니라 REVERT였다 — **device 발사를 되살리며 backend 발사를 안 껐다.** 결과:
- **device ↔ backend 교차 dedup 부재**: device dedup(`lastNotifiedStationId`/`firedAlarms`)은 프로세스 in-memory라 backend APNs push를 못 봄. backend fire-once(`arvlcdFireOnceTtl`)는 arch flag off라 dormant. → 동일 waypoint 이중발사.
- **잘못된 "역 통과" = backend `fireArvlCdStationPush`(scheduled.ts:2426)** / vanish fallback(scheduled.ts:2922). fire-once dormant로 어린이대공원 반복(코드 주석 "어린이대공원 4회 fire" 존재).
- **device 내부는 이미 조율됨**: FG 3경로(GPS/arvlCd/subsurface)·BG 3경로(GPS/position-train/consensus)가 공유 fire-once 원장으로 1배너 축약. 문제는 device↔backend 뿐.

### 숨은 구멍
device **FG phase(환승/도착) 발사는 #2067로 "기록 전용" 봉인**(`useStationAlarm.ts:1000-1002`). FG에선 device가 phase 배너를 안 쏘고 backend push 의존. BG만 로컬 발사(#2379, flag ON).

---

## Decision — Device 단일 권위 (도착알람 도메인)

### 유지/승격 (device = 단일 emitter)
1. **device FG phase 발사 봉인 해제** — `useStationAlarm.ts:1000-1002`(#2067) → FG에서도 transfer/destination을 P1(`fireLocalAlarmNotification`)로 발사. (backend 퇴역분을 FG가 커버하는 필수 전제)
2. **device station-passed 유지** — FG(1c/1d/1e→P2), BG(2a/2b/2c→P1/P2). 이미 공유 원장으로 조율됨.
3. **`EXPO_PUBLIC_MINIMAL_ALARM` 기본값 승격** — 실험 flag → 상시. device 발사가 flag 뒤 dormant인 상태 종료. (승격은 Phase 1 검증 후)
4. **safetyNet backstop 유지** — outage-only(`outageConfirmed`), 변경 없음.

### 퇴역 (backend visible arrival push)
5. **`fireArvlCdStationPush`(scheduled.ts:2426) intermediate/transfer/destination visible 제거** — '역 통과' 발원지. = #2365 확장.
6. **`fireVanishFallbackStationPush`(scheduled.ts:2922) visible 제거.**
7. **`sendOneFallback`(fallback.ts:124) intermediate 재시도 제거** (1·2의 retry 짝).

### 유지 (backend = SSoT-forward silent만)
8. **`runLocklessIntermediate` silent(scheduled.ts:4468), transfer-release lock-sync silent(scheduled.ts:3966), `maybeReschedulePush` silent(scheduled.ts:4157) 유지** — device에 상태 forward, device가 발사 판정. (backend는 "알림"이 아니라 "SSoT 전달자"로만)

### 범위 밖 (별도 도메인, 유지)
- boardingPrompt/hop-end, `maybeFireSleepAlarm`, `fireTripEndedAlertPush`, `fireTrainReconfirmPush`.

---

## Consequences
- **제거**: backend 매역/환승/도착 visible push 2(+1 retry)경로. device↔backend 이중발사 소멸(emitter 1개).
- **추가**: device FG phase 발사(봉인 해제) + MINIMAL_ALARM 승격.
- **유지**: backend silent SSoT-forward, safetyNet outage backstop, 별도 도메인 visible.

## Trade-offs (정직)
- **device 발사 신뢰성에 전면 의존** — FG는 `AppState==='active'`에서만 발사, 잠금/BG는 TaskManager(#2379/#2384)가 커버. 이 커버리지가 실증돼야 backend 퇴역 안전. **Phase 1 검증이 Phase 2의 hard-gate.**
- **backend outage 시** = safetyNet 단일 backstop 의존 (ADR-026과 동일 trade). 
- **backend+device 양 코드베이스** 수정, 실기기 재검증 필수.
- flag 승격 = 회귀 시 되돌릴 flag가 사라짐 → Phase 1에서 flag ON 실증 후 승격.

## Sequencing (Phase 2는 Phase 1 검증에 hard-gated)
1. **Phase 1 (device 커버리지 완성)**: FG phase 봉인 해제 + 도착알람 도메인이 FG(active)·BG(locked) 모두에서 device 단독 발사됨을 실기기 검증. MINIMAL_ALARM 승격.
2. **Phase 2 (backend 퇴역)**: 5·6·7 backend visible 제거. **Phase 1 실증 후에만** (device 커버 확인 전 제거 시 알람 total loss).
3. **병행 트랙**: fixture replay 전면화 — 08-26/08-27 + 과거 덤프를 red→green fixture로 굳혀 이중발사·오'역통과'·환승알람전멸 회귀를 CI 게이트化.

## Acceptance (PR 머지 = close 금지)
- **backend fire 경로 확정 선행**: 08-27 어린이대공원 push가 `fireArvlCdStationPush`인지 vanish인지 backend tail/metric(origin 필드)으로 확정. (덤프 device측으론 불가 — 검증 상태 표 참고.)
- **동일 waypoint 이중발사 실증**: device fire 원장 + backend push 카운터를 같은 trip에서 교차해 실제 same-waypoint 중복이 있는지 확인(현재 미검증). 없으면 근본은 "backend 오내용 push" 단독 → 범위 재조정.
- **red replay fixture**: 08-27 device측 신호(환경 오분류)는 #2389로 재현. backend 오'역통과'는 backend worker 테스트로 재현 → device 단일 적용 후 backend arvlcd visible=0.
- **field verify 1주**: 이중발사 0 + 잘못된 backend '역 통과' 0 + 환승/도착 알람이 FG·잠금 모두에서 1회씩 도달 + outage 시 safetyNet backstop 1회 도달.
- **관측**: device fire 원장과 backend push 카운터가 동일 waypoint에 중복 안 됨을 DebugModal/backend metric으로.

## 미해결 / 후속
- 별도 도메인(boardingPrompt/취침/trip-end)의 device 단일화는 후속 ADR.
- ADR-025(등록 신뢰성)는 여전히 backend silent SSoT-forward 품질에 영향 — 병행 개선 필요하나 본 ADR의 hard-dep 아님(device가 자립).
