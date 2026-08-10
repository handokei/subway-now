# Plan — Device 단일 emitter 탑승 이벤트 루프 (route+arvlCd 즉시발사)

- 작성: 2026-08-10
- 근거 evidence: 2026-08-10 오전 실탑승 덤프(`텍스트-885C779A95BA-1.txt`) + backend D1 trip `b00dd879`
- 신규 ADR: **ADR-032** (fire emitter를 backend 단일 → device primary + backend safetyNet backstop으로 개정. ADR-026 부분 개정)
- 관련: ADR-026(단일 emitter), ADR-031(silent push deadlock), ADR-022(flag-ON backend 권위)

---

## 1. 문제 (pinned root cause)

2026-08-10 오전 7호선→2호선 환승 trip(용마산→건대입구 환승→뚝섬)에서 관측된 3개 증상은 **하나의 구조적 원인**으로 수렴:

1. **2호선 전 구간 무보호** (`lockless-no-user-intent` 100회) — 사용자가 7호선 탑승열차를 직접 선택했음에도 2호선 lock이 안 걸림.
2. **backend fired=0** — cron은 `isBoardingLockActive || infoModeEnabled`일 때만 발사(`scheduled.ts:1286`). 2호선 leg는 lock 없음 → 매 tick skip.
3. **매역 알림이 1홉 늦고 "통과"뿐** — `advanceTripPosition.ts:510`이 "다음역 도착 확인 시 직전역 통과" 발사. Seoul API 지연 + cron 1분 + APNs 35~51s 누적.

**Pinned 원인**: BG 환승 swap(`backgroundTransferSwap.ts:73`)이 새 노선 lock을 **silent push로만** hydrate(HTTP sync 응답의 `autoLockCandidate`를 폐기) → silent push는 구조적으로 죽음(received=0, ADR-031) → 2호선 lock 영영 안 생김. 매역 알림은 backend 단일 emitter(ADR-026)가 push 못 하니 miss. **backend 단일 emitter 전제(신뢰성 있게 쏜다)가 지하 push deadlock으로 붕괴.**

증거: silent push received=0/fired=0, backend lock_attached=0/fired=0, push_failures=0(발사 시도조차 0), 2호선 100x lockless. 코드: FG는 sync 응답 직접 hydrate(`useTransferAutoDetect`), BG는 폐기 후 push 대기(`backgroundTransferSwap:73`).

---

## 2. 설계 — 분업 (backend=위치권위/plan, device=발사/보정)

### 핵심 분업
"위치를 아는 것"과 "제때 알리는 것"을 각자 잘하는 쪽에 맡긴다:

| 역할 | 담당 | 이유 |
|---|---|---|
| **위치/타이밍 권위** | **backend** | trainCode를 Seoul arrival API로 **서버측 추적** — GPS 무관, 지하 robust. (2026-08-10 trip도 07:32~07:38 지하서 backend-ssot 역 전진 관측) |
| **발사/전달** | **device** | 즉시 로컬알림, BG, APNs 지연 0 |
| **다리(transport)** | backend가 연결 창에 **plan(역별 예상 도착시각 + 탑승 이벤트)** 을 device에 내려줌 → device가 로컬 발사 + **live 신호로 보정** | push per-event(지연/deadlock) 대신 plan 1회 + 재조정 |

**순수 device도(지하 위치 약함), 순수 backend도(push 배달 약함) 아닌 분업**이 W1의 구조적 답. backend는 "쏘는" 게 아니라 "위치를 추적해 plan을 준다".

### 탑승 이벤트 primitive
route = 탑승 이벤트 시퀀스:
```
탑승 이벤트 = (역 S, 노선 L, 방향 =목적지쪽)
- 처음 탑승 : (출발역, L1, →D)
- 환승 k    : (환승역k, L(k+1), →D)
```
backend가 각 이벤트/역의 **예상 시각을 plan으로 산출·전달**. device는 그 plan을 들고:
- **탑승 이벤트**: plan의 S 도착 예상 + **motion-resume(가속도계 출발 가속)** consensus → 로컬 "탑승하셨나요?" 즉시발사(`trigger:null`).
- **매역 forward**: plan의 다음역 예상 + live arvlCd 진입(신호 잡힐 때) 보정 → "곧 X" 즉시발사.
- 응답/optimistic motion = intent → leg 추적 → 다음 탑승 이벤트 반복.

### 원칙
- **단일 emitter 유지** — 발사는 device만. backend는 plan 전달 + safetyNet backstop만(발사 안 함). 이중발사는 `emitter=device` per-trip 플래그로 원자 차단.
- **plan은 blind 사전예약 아님** — device가 live 신호(arvlCd/motion)로 시각 보정 + 연결 복구 시 재-sync. 지연 열차 drift 흡수.
- **즉시발사(`trigger:null`, #2122 경로)** — OS 미래 시각 예약 큐 미사용 → stale 큐 문제 없음. plan은 "언제 쏠지 판단 입력"이지 OS 예약이 아님.

세 증상이 하나의 루프로 접힘:
```
backend: trainCode 추적 → plan(역별 예상시각) ──연결 창──▶ device
device:
  [탑승 이벤트] plan S예상 + motion-resume → 로컬 프롬프트 "탑승?"   (= 증상 1·2 해결)
     │ 응답/optimistic = intent
     ▼
  [leg 추적] plan 다음역 + live arvlCd 보정 → 로컬 forward 알림       (= 증상 3 해결)
     │
     ▼
  [다음 탑승 이벤트 = 환승] 반복
backend: device 침묵 확인 시에만 safetyNet backstop 1회(W4)
```

---

## 3. 약점 + 대응 (adversarial)

**공통 척추**: 모든 W의 해법은 **가속도계 motion(지하서도 동작) + route 방향 consensus**로 수렴한다. GPS/push가 죽어도 이 둘로 발사·추적·guard를 세운다. 완전 무신호 극단만 backend backstop(W4)이 받는다.

### W1. 지하 위치 검출 (분업으로 구조적 해결)
- 문제 분해: **W1a 위치를 아는 것** + **W1b device에 전달하는 것**. device 단독이 약한 건 W1a(지하 GPS 동결).
- **W1a → backend가 권위**: trainCode를 Seoul arrival API로 서버측 추적 = GPS 무관, 지하 robust. device가 지하 위치를 검출할 필요 없음 — backend가 열차를 따라감(아침 trip 07:32~07:38 지하 backend-ssot 전진이 증거).
- **W1b → device가 담당**: backend가 연결 창에 **plan(역별 예상시각)** 을 내려주면, device는 즉시 로컬알림으로 전달(APNs 지연 0, BG). "backend가 쏜다"가 아니라 "backend가 위치→plan, device가 발사".
- device는 plan을 **live 신호로 보정**: 발사 앵커는 **가속도계 motion-resume**(정지→출발 가속, 지하 동작) + 신호 잡힐 때 arvlCd. plan 예상 + live consensus.
- **잔여 + 해결**:
  - (1) **plan 수신 연결 창** → 계층 방어: **1B 등록 시 full plan 프리페치 + 1A 창마다 재-sync + 1C static timetable 오프라인 floor**. 3층 다 뚫림 = 등록 전부터 무신호+timetable 없음 = 사실상 없음.
  - (2) **지연 열차 drift** → **2B motion-gated 발사(주축) + 2A live arvlCd 재-anchor + 2C stop-count**. 핵심: plan 시각 blind 발사 금지, **발사는 가속도계 감속-정차(실제 도착)** 로. 지연 자동 흡수.
  - (3) 공통 귀결 = "**motion=발사 게이트, plan=맥락, arvlCd=보정**" → 리스크가 **가속도계 신뢰성** 한 곳 집중(단일 급소, `lesson_motion_activity_intermittent_signal`). **실기기 spike 1순위.**
  - (4) 완전 실패 시 → W4 backend backstop 최종 방어.

### W2. 급행/완행 (완행 우선 + 감지 follow-up)
- 문제: trainCode 없으면 급행 탑승 시 건너뛴 역 오발사.
- MVP: **완행 가정**, route 매역 forward 발사.
- 급행 감지: 탑승 후 **역간 시간 + arvlCd 패턴** 관측. 우리 열차가 X를 건너뜀(X 도착 arvlCd 없이 X+1 도착) → X를 skip 표기 → **X forward 알림 suppress**(오발사 대신 침묵).
- → 급행이어도 "건너뛴 역 오발사" 0. 정확한 급행 매역은 follow-up(#G).

### W3. 무응답 = 무추적 (optimistic motion consensus)
- 응답 있으면 → 확정 intent → 완전 추적.
- **무응답 시**: (a) 가속도계 train 지속 이동 + (b) route 방향대로 역 전진 → **탭 없이도 "탑승 추정" → 매역 추적 진입.** 탭은 정확도만 강화, 필수 아님.
- **guard**: 역이 route 반대로 가거나 정지 지속 → 우리 trip 아님 → 추적 안 함(오발사 차단).

### W4. backstop 상실 = miss (temporal 조정)
- 문제: backend를 끄면 device가 BG서 못 깨어날 때 backstop 0 → miss(ADR-026 "miss=오발사 동급").
- backend safetyNet(`safetyNetScheduler.ts`) **유지**, ADR-026:36 그대로.
- **이중발사 방지는 identifier가 아니라 시간으로** — device 로컬 발사 시 backend에 경량 ACK(또는 backend가 position 전진 대비 device-fire 부재로 침묵 추론). backstop은 **device 침묵 확인 + 발사 직전 재검증** 시에만 무장.
- → device 깨어나 발사 = backstop 잠잠. device 침묵(BG 미웨이크) = backstop 1회. miss 방지 + 중복 없음.

### W5. 마이그레이션 이중발사 (per-trip 원자 플래그)
- 문제: device ON·backend OFF가 원자적이 아니면 둘 다 쏘는 창 = ADR-026 재발.
- trip 등록 `emitter=device` 플래그. backend 분기:
  - **ON**(신규 앱): 그 trip station/prompt push **suppress**, safetyNet backstop만.
  - **OFF**(구 앱/롤백): 기존대로 backend 발사.
- 플래그가 **등록 시점 per-trip** 확정 → 같은 trip이 device·backend primary 동시인 창 **없음**. device 발사 코드와 backend suppress가 **같은 앱 버전** → 항상 정합.

**정직한 메타 약점**: 이 설계는 "지하에서 내 위치·도착정보를 안다"를 마법으로 풀지 않는다. silent-push deadlock + APNs 지연을 제거하고 device-local 신호(motion/기압계/즉시 로컬알림)를 활용할 뿐. 지하 무신호 극단에선 device도 실패 → 그래서 **backend safetyNet backstop이 필수**.

---

## 4. 숙제 3개 해법

1. **BG 웨이크** → **motion-resume 앵커.** 도착 정시가 아니라 정지→이동 전환(탑승해 열차 출발) 시점 발사. iOS significant-motion/location이 깨움. "탔냐?"는 열차 이동 시점이 도착 순간보다 정확 → 약점의 기능적 반전. 기존 `backgroundLocationTask` + CMMotionActivity 재사용.
2. **복수 열차** → **탑승 이벤트당 1회 발사** + dismiss/cooldown 재무장(기존 `dismissSilence`). 급행/완행은 완행 우선 + 급행 감지 follow-up.
3. **backend push-off** → trip 등록 `emitter=device` 플래그 → backend가 그 trip station/prompt push suppress + safetyNet backstop만.

---

## 5. 확정된 결정 (추천 default 채택)

- **D1. backstop**: device primary + **backend safetyNet backstop 유지**. (순수 device 미채택 — W4 miss)
- **D2. 급행/완행**: **완행 우선 + 급행 감지 follow-up.** (지금 막지 않음)

> 사용자 override 가능. override 시 4·6절 acceptance/이슈 재조정.

---

## 6. Acceptance (V/X) — 사용자 가치 기준

정의 순서: 사용자 가치 → acceptance → 코드. 권한 매트릭스(WhileInUse/Always × FG/BG/취침) × 환경(지상/지하/환승) 커버.

- **V1 처음 탑승 프롬프트** — 출발역서 방향 맞는 열차 탑승(motion-resume) 시 로컬 프롬프트 발사. FG/BG 모두. 지상/지하 모두(지하는 backstop 포함).
- **V2 환승 탑승 프롬프트** — 환승역서 새 노선 탑승 시 로컬 프롬프트. **silent push 0건에도 발사**(핵심 회귀 방어).
- **V3 매역 forward 알림** — 다음역 arvlCd 진입 시 "곧 X" 로컬발사. "통과(backward)" 대비 1홉 빠름.
- **V4 단일 emitter** — 동일 이벤트 이중발사 0건(device 발사 시 backend suppress 확인).
- **V5 backstop** — device 침묵(BG 미웨이크) 시 backend safetyNet 1회 도달.
- **X1 오발사 0** — 미탑승/정지 중, 반대방향/급행 오탑승 프롬프트 0건.
- **X2 무응답 graceful** — 프롬프트 무응답 시 spam 0(cooldown), optimistic 추적은 motion consensus 충족 시만.

**Close 조건**: 실탑승 1주 — V2(환승 프롬프트) 재발 0 + X1 오발사 0 + V5 backstop 도달 확인. (PR 머지 ≠ close.)

---

## 7. Wire Matrix

| 신호 | 생성 | 소비/관측 | Dead 금지 검증 |
|---|---|---|---|
| 탑승 이벤트 감지(motion-resume+S+L) | `backgroundLocationTask` / FG detector | 로컬 프롬프트 발사 | 발사 카운터 DebugModal 노출 |
| 로컬 프롬프트 발사 | `fireLocalBoardingPrompt`(신규, #2122 확장) | 알림센터 + alarmLog | `boardingPrompt(local)` 카운터 |
| 프롬프트 응답 | 사용자 탭 | intent store → leg 추적 진입 | 응답률 DebugModal |
| 매역 forward(arvlCd 진입) | leg 추적기 | 로컬발사 + alarmLog | forward fire 카운터 |
| `emitter=device` 플래그 | trip 등록 페이로드 | backend push suppress + safetyNet 무장 | backend 로그 `emitter` 분기 |
| safetyNet backstop | backend(device 침묵 시) | APNs 1회 | backend fire-once 카운터 |

---

## 8. 이슈 분해 (tracer-bullet 수직 슬라이스, 각 결함=PR 1개)

- **#0 [SPIKE] 가속도계 train-fingerprint 신뢰성 실기기 검증** ★1순위 — 감속-정차/출발-가속 검출 정확도 + CMMotionActivity flip 빈도(`lesson_motion_activity_intermittent_signal`). **설계 단일 급소** — 여기 깨지면 척추 재검토. spike 후 본구현.
- **#A ADR-032 작성** — 분업(backend=위치/plan, device=발사) 개정. 결정 D1/D2 근거. (docs-only) ✅작성됨
- **#B 탑승 이벤트 primitive 추출** — route → 탑승 이벤트 시퀀스 pure 함수 + 테스트. (shared/route util)
- **#H backend plan endpoint** — trainCode train-tracking → plan(역별 예상시각+탑승 이벤트) 산출 + 연결 창 전달. 등록 시 full plan 프리페치(1B). (backend)
- **#I device plan 수신/캐시/재-sync + static floor** — 1B 수신 + 1A 창마다 재-sync + 1C static timetable 오프라인 floor. (device)
- **#C 로컬 프롬프트 즉시발사(BG)** — #2122 `fireFgAux…`를 route/plan 기반·BG 허용으로 확장. FG+lock 게이트 제거, **motion-gated 발사(2B)**. Part of ADR-032.
- **#D 프롬프트 응답 → intent → leg 추적** — 응답 시 device-local intent 등록, 매역 forward 진입. optimistic(무응답+motion consensus) 포함.
- **#E 매역 forward 트리거** — plan 다음역 + **motion 감속-정차 게이트(2B)** + live arvlCd 보정(2A). "통과(backward)" → "진입/접근(forward)". 방향 필터.
- **#J stop-count dead-reckoning** — 정차 사이클 카운트로 창-사이 역 전진 추정(2C). #E 보조.
- **#F backend `emitter=device` suppress + safetyNet 유지** — backend가 플래그 trip의 station/prompt push 끔, safetyNet backstop만(temporal 조정). (backend)
- **#G 급행 감지 (follow-up)** — 역간 시간/arvlCd consensus로 급행 판정 → 매역 forward 보정. (D2 후속)

의존: **#0 spike가 #C·#E·#J 선행(급소 검증).** #B는 #H·#I·#C·#D·#E 선행. #H↔#I 짝. #C·#D·#E는 #B·#I 선행. #F는 #C와 원자 배포(이중발사 창 차단). #A 병행(작성됨).

---

## 9. Wire-completion 5단 (모든 PR)

1. **Orphan 없음** — `npm run lint:orphan` pass. 신규 export caller 존재.
2. **V/X dashboard** — 신규 카운터(`boardingPrompt(local)`, forward fire, emitter 분기)를 DebugModal / backend 로그에 노출.
3. **의존 PR** — #C↔#F 원자 배포. 각 PR 본문 명시.
4. **측정 plan** — 실탑승 1주 시나리오 캡처(환승 프롬프트 발사, 이중발사 0, backstop 도달) + backend `emitter` 로그 query.
5. **Device verify** — 실기기 필수(BG 웨이크/지하/환승은 device-only). 시나리오: 처음탑승·환승·급행·무응답·지하.

---

## 10. 남은 검증 인프라 (선행 권장)

- **BoardingLock lifecycle 로깅 복구** — 이번 덤프에서 `BoardingLock Lifecycle`/`Drift` 버퍼가 비어 lock 유실 순간을 못 잡았음(#2152가 아침 빌드에 없었거나 미탑). 재현 진단 위해 lifecycle breadcrumb가 실기기 덤프에 확실히 남도록 검증 → 다음 실탑승부터 emitter 전환 효과를 로그로 판정 가능.
