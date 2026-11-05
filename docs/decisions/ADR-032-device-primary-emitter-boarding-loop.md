# ADR-032 — Fire emitter를 device primary + backend safetyNet backstop으로 개정 (route+arvlCd 탑승 이벤트 루프)

- **Status**: **Superseded/HOLD (2026-08-13)**. 설계 척추("motion=ground-truth 발사 게이트", 트레이드오프 절 "단일 급소 = 가속도계 신뢰성")가 2026-08-12 실탑승 spike 판정(CMMotionActivity 발사 게이트 확정 NO-GO — 실제 출발·정차 감지 0건, walking/automotive 역전·오분류, #2269 코멘트)으로 붕괴. 같은 날 #2306 RCA(OS suspend가 지하 leg 알림 25분 전멸의 근본 원인)를 근거로 2026-08-13 사용자가 **O1: backend 자율 전진 + alert push 직접 발사**(ADR-031 Phase 2a로 흡수, backend가 위치 추적뿐 아니라 발사까지 담당)를 근본 축으로 확정하면서 본 ADR의 "발사=device" 분업 전제가 대체됨. **재개 조건**: 재캡처(placement=pocket/bag, GPS 완전 사망 구간 포함)로 raw ua+g low-pass 단독 신뢰성이 확보되고, ADR-031 Phase 2a/2b로 backend-primary 경로가 W1(지하 위치)·W4(miss)를 구조적으로 해결하지 못하는 잔여 갭이 확인될 때만. **raw ua+g low-pass(3s 벡터평균) 계열은 폐기 아님 — 보조 후보로 존치**(spike에서 출발·정차 신호 자체는 확인, 단독 불가·plan-융합 전제부 생존).
- **부분 개정**: ADR-026(단일 emitter = backend) — **단일 emitter 원칙은 불변, primary 권위만 backend→device로 이동**. **Builds on**: ADR-010(miss=오발사 동급), ADR-022(flag), ADR-031(silent push deadlock), feedback_device_self_contained_fusion.
- **분석**: 2026-08-10 오전 실탑승 덤프(`텍스트-885C779A95BA-1.txt`) + backend D1 trip `b00dd879` 교차 RCA.
- **관련 plan**: `tasks/plan-2026-08-10-device-boarding-emitter.md`

---

## Context — backend 단일 emitter 전제의 붕괴

ADR-026은 iOS 플랫폼 제약(로컬 identifier vs push collapse-id는 서로 못 합침 → 둘 다 쏘면 이중발사 물리적 불가피)으로 **emitter를 정확히 1개**로 강제했고, ADR-022(flag-ON) 정합상 그 1개를 **backend**로 정했다. ADR-026 스스로 비용을 경고했다: *"매역 backstop을 없애므로 backend outage/APNs 지연 시 miss. 트립이 등록조차 안 되면 backend가 못 쏜다. miss=오발사 동급."*

### 2026-08-10 evidence — 그 경고의 현실화
7호선→2호선 환승 trip(용마산→건대입구 환승→뚝섬, trip `b00dd879`):
- 사용자가 **7호선 탑승열차를 직접 선택**(명시 의향)했음에도 **2호선 전 구간 무보호** — `lockless-no-user-intent` 100회.
- **backend fired=0** (`scheduled.ts:1286`: `isBoardingLockActive || infoModeEnabled`만 발사. 2호선 leg lock 없음 → 매 tick skip). push_failures=0(발사 시도조차 0), silent push received=0.
- **매역 알림은 1홉 늦고 "통과"뿐** (`advanceTripPosition.ts:510`: "다음역 도착 확인 시 직전역 통과" 발사 + Seoul API 지연 + cron 1분 + APNs 35~51s).

### Pinned 원인 (재탑승 불필요, 코드+데이터로 특정)
BG 환승 swap(`backgroundTransferSwap.ts:73`)이 새 노선 lock을 **silent push로만** hydrate — `/boarding-lock/sync` HTTP 응답에 `autoLockCandidate`가 담겨 반환(`index.ts:1923`)되는데도 BG는 이를 **폐기**(`Promise<unknown>`)하고 silent push 발급을 기다린다. silent push는 구조적 deadlock으로 死(ADR-031, received=0) → 2호선 lock 영영 안 생김. **FG는 응답 직접 hydrate(`useTransferAutoDetect`), BG만 push 의존** — 지하 탑승=화면 꺼짐=BG이므로 정확히 실패.

### 이미 존재하는 지렛대
- **즉시발사 로컬알림 경로 존재**: `fireFgAuxStationPassedNotification`(#2122, `stationNotification.ts:603`)이 `scheduleNotificationAsync({trigger:null})`로 즉시 발사. 단 `AppState==='active' && lock` 게이트로 FG+lock에만 묶임. **시각 예약(사전예약) 아님 → #2202가 지운 stale 큐 문제와 무관.**
- **route에 탑승 이벤트 정보 완비**: `journey.ts` fromLine/toLine/transfer.
- **arvlCd forward 신호 존재**: `arrivalCodes.ts` — 진입(0)/전역출발(3)/전역도착(5). 현재 backend는 이를 "직전역 통과 확정(backward)"에만 사용.
- **backend safetyNet backstop 존재**: `safetyNetScheduler.ts`(ADR-026:36) — device 침묵 확인 시에만 무장.

---

## Decision — 분업: backend=위치권위/plan, device=발사/보정

### 원칙
**단일 emitter 원칙(ADR-026)은 유지(발사는 device만)하되, 역할을 각자 강한 쪽에 분업한다:**
- **위치/타이밍 권위 = backend** — trainCode를 Seoul arrival API로 서버측 추적(GPS 무관, 지하 robust). backend는 "쏘는" 게 아니라 **위치를 추적해 plan(역별 예상시각+탑승 이벤트)을 산출**한다.
- **발사/전달 = device** — plan을 받아 즉시 로컬알림 발사(APNs 지연 0, BG), live 신호로 보정.
- backend는 발사 안 함 → 이 이벤트 push 끄고 **safetyNet backstop만**. 이중발사 방지는 identifier가 아니라 **per-trip 플래그 + temporal 조정**으로.

이유: 순수 device는 W1a(지하 위치) 약하고, 순수 backend는 W1b(push 배달 지연/deadlock) 약하다. 분업이 양쪽 강점을 취한다.

### (a) transport — backend plan → device
backend가 연결 창(신호 잡히는 순간, 대부분 승차 전후 존재)에 device로 **plan** 전달: 역별 예상 도착시각 + 탑승 이벤트 시퀀스. **plan은 blind OS 사전예약이 아니라 device의 "언제 쏠지" 판단 입력** — device가 live 신호(arvlCd/motion)로 시각 보정 + 연결 복구 시 재-sync해 지연 열차 drift를 흡수. 즉시발사(`trigger:null`)라 OS 미래 예약 큐 미사용 → stale 큐 문제 없음.

### (b) 탑승 이벤트 primitive
route = 탑승 이벤트 시퀀스: `(역 S, 노선 L, 방향=→D)`. 처음 탑승 = (출발역, L1), 환승 k = (환승역, L(k+1)). 각 이벤트에서 **plan의 S 도착 예상 + motion-resume(가속도계 출발 가속) consensus** → **로컬 "탑승하셨나요?" 프롬프트 즉시발사**. 지하 위치는 backend train-tracking이 권위, device는 발사 앵커만 motion으로.

### (b) 응답 → intent → leg 추적
프롬프트 응답 = device-local intent 등록 → 그 leg 매역 forward 알림(다음역 arvlCd 진입 즉시발사, 방향 필터). **무응답 시 optimistic**: 가속도계 지속 이동 + route 방향 역 전진 consensus면 탭 없이 추적 진입(guard: 역이 반대로 가면 중단).

### (c) 매역 forward (증상 3)
"통과(backward, 도착 확인 후)" → "진입/접근(forward, arvlCd 3/5/0)" 로컬발사. 완행 우선, 급행은 역간시간/arvlCd consensus로 skip 감지 → 보수적 suppress(오발사 대신 침묵), 정확 급행은 follow-up.

### (d) 단일 emitter 전환 — `emitter=device` 플래그
trip 등록 페이로드에 `emitter=device`. backend 분기: **ON** → station/prompt push suppress + safetyNet backstop만 무장. **OFF**(구 앱/롤백) → 기존 backend 발사. per-trip 등록 시점 확정 → 동시 primary 창 없음.

### (e) backstop (miss 방지, W4)
backend safetyNet 유지. **temporal 조정**: device 로컬 발사 시 경량 ACK(또는 backend가 position 전진 대비 device-fire 부재로 침묵 추론) → backstop은 device 침묵 확인 + 발사 직전 재검증 시에만 1회. device 깨어나 발사=잠잠, 침묵=backstop 발사.

---

### transport 잔여 2개의 해결 (계층 + motion-gate)
- **연결 창 필요** → **1B 등록 시 full plan 프리페치 + 1A 창마다 재-sync + 1C static timetable 오프라인 floor** (3층 방어). 3층 다 뚫림 = "등록 전부터 끝까지 무신호 + timetable 없음" = 사실상 없음.
- **지연 열차 drift** → **2B motion-gated 발사(주축) + 2A live arvlCd 재-anchor + 2C stop-count dead-reckoning**. 핵심 전환: **plan 시각으로 blind 발사 금지 — 발사 트리거는 가속도계 감속→정차(실제 도착).** plan은 "다음 역+대략 언제"만, 발사는 motion. 지연은 motion 게이트가 자동 흡수.
- **공통 귀결**: 두 잔여 모두 "**motion=ground-truth 발사 게이트, plan=맥락, arvlCd=신호 시 보정**"으로 수렴 → 리스크가 **가속도계 train-fingerprint 신뢰성** 한 곳에 집중. 이게 설계 단일 급소(아래 검증 1순위).

---

## 왜 이 방향인가 (ADR-026 대비)

ADR-026은 "backend가 신뢰성 있게 쏜다"를 전제로 backend를 emitter로 택했으나, silent push deadlock(ADR-031)으로 그 전제가 붕괴. 본 ADR은 **위치=backend(train-tracking, GPS 무관 지하 robust), 발사=device(즉시 로컬, 배달 지연 0)** 로 분업 → 순수 backend(배달 약함)·순수 device(지하 위치 약함) 둘 다의 약점을 회피. device도 완전 무신호 극단엔 실패하므로 backend backstop을 남겨 miss를 막는다. feedback_device_self_contained_fusion 패러다임과 정합.

---

## 트레이드오프 / 리스크

- **⚠️ 단일 급소 = 가속도계 신뢰성** — 두 transport 잔여를 "motion-gated fire"로 풀면서 리스크가 가속도계 train-fingerprint 신뢰성 한 곳에 집중. `lesson_motion_activity_intermittent_signal`(CMMotionActivity 5~10분 뒤집힘)이 정통으로 걸림 → **실기기 spike 1순위**. 불안정하면 설계 척추 재검토.
- **W1 지하 위치** — backend train-tracking으로 **구조적 해결**(미해결 아님). 잔여는 transport(위 2개, 완화).
- **급행 정확도(W2)** — MVP 완행 가정. 급행 매역 정확은 follow-up. 단 "건너뛴 역 오발사"는 skip 감지로 0 보장.
- **BG 웨이크 의존(숙제1)** — 즉시발사는 발사 순간 BG tick 필요. motion-resume 앵커로 확률 높이나 실기기 검증 항목.
- **이중발사(W5)** — per-trip 플래그로 원자 전환. flag-OFF 롤백 시 기존 backend 동작(안전).
- **ADR-026 개정** — 단일 emitter 원칙 불변, primary만 이동. flag-OFF로 즉시 롤백 가능.
- **N=1 미검증** — 2026-08-10 단일 trip 기반. 실탑승 다회(노선/급행/지상지하)로 일반화 검증 필요.
- **backend + device 양 코드베이스** 수정 → 같은 파일 직렬 머지, 실기기 재검증 필수.

---

## Acceptance / 검증

- **red replay**: 2026-08-10 덤프로 (a) 환승 후 2호선 무보호, (b) 매역 1홉 lag를 재현(red) → device emitter 적용 후 green(환승 프롬프트 발사, forward 1홉 빠름).
- **field verify**: 실탑승 1주 — 환승 프롬프트 재발 0 + 미탑승/정지/반대방향 오발사 0 + device 침묵 시 backstop 1회 도달 + 이중발사 0.
- **관측**: `boardingPrompt(local)` / forward fire / emitter 분기 카운터를 DebugModal·backend 로그 노출.
- **Close 조건**: PR 머지 ≠ close. 위 field verify 1주 충족.

---

## 선행 조건

- **BoardingLock lifecycle 로깅 복구** — 이번 덤프에서 lifecycle/drift 버퍼가 비어 lock 유실 순간 미포착(#2152 미탑 추정). 다음 실탑승부터 emitter 전환 효과를 로그로 판정하려면 lifecycle breadcrumb가 실기기 덤프에 확실히 남아야 함.
- **ADR-031 Phase 0**(deadlock 완화) 진행 상태 확인 — 본 ADR은 silent push를 primary에서 배제하므로 ADR-031과 상호 정합(backend는 backstop만).
