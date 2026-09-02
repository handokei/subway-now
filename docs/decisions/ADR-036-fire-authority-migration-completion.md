# ADR-036 — 발사권위 이전 완결: 지하 device arvlCd 발사 → backend visible 퇴역 (033+035 실행)

## 상태

Proposed — 2026-09-02. **ADR-033(Proposed)·ADR-035(DRAFT)를 실행 계획으로 완결**하고, 두 ADR이 전제한 "device 지하 커버"가 현재 게이트로 **달성 불가**함을 2026-09-02 실탑승으로 확인해 **누락된 Phase 0(지하 device arvlCd 발사)** 을 추가한다. ADR-035를 supersede하지 않고 **실행 SSoT로 확장**한다(035의 적대적 audit·검증표는 그대로 유효).

- **Finalizes**: ADR-033 (매역 device-FG 권위), ADR-035 (도착알람 device 단일 권위)
- **Supersedes 방향 정합**: ADR-026 (backend 단일 emitter — 현장 실패, 035에서 반전됨)
- **범위**: 도착알람 도메인 (station-passed / transfer / destination visible 발사)만. boardingPrompt·취침알람·trip-end·train-reconfirm은 별도 도메인 — 본 ADR 밖.

---

## 첫 줄 원칙

**도착알람의 visible 발사 권위는 device 하나여야 하고, 그 device는 지하에서도 발사할 수 있어야 한다.** 지하철 앱의 사용자 가치는 **지하**에 있다(지상은 GPS로 이미 됨). 따라서 "device 단일 권위"(035)는 **지하 device 발사가 실증되기 전엔 완결되지 않는다.** 두 실패 모드(오발사 false-positive / 미발사 miss)는 비대칭이 아니라 **동급**이다(ADR-010).

---

## 왜 지금 — 2026-09-02 실탑승 증거 (confirmed)

두 트립(오전 outbound 06:31~53 / 저녁 return 17:11~22)을 device 로그 × D1 `trip_events`로 KST 정렬 교차분석. 검증 방법·원문은 세션 RCA 참조.

1. **지하 도착 알림 = 아무도 못 쏨** (confirmed). 저녁 종점 용마산(7호선 지하, GPS acc **2270~2546m** garbage):
   - device gate-free 경로(#2383, `backgroundLocationTask.ts:171`)가 저녁 leg서 **engage 실패**(position-train cycle 0회, 오전엔 작동) → gate-accuracy(2270m) 경로로 fall.
   - fall 후 arvlCd 유효신호를 `gate-accuracy`+`gate-hop-window`+`gate-phase-time-integration`이 **4중 억제**(로그 확인) — device가 정확한 종점(용마산)을 집었는데도 게이트가 죽임.
   - backend = destination visible 미발사. D1 오늘 `cron-fire-attempt` waypointKind = **station-passed 20 + transfer 2뿐, destination/entering 0건**(독립 재확증).
   - → **지하 종점 도착 = 커버리지 공백.**
2. **backend가 "OO역 통과" visible을 계속 발사** (confirmed). `scheduled.ts:2677` "visible alert push 직접 발사"(#2063). device는 같은 신호를 `legacy-station-kind-ignored`로 버림(`silentPushTask.ts:1358`, #2064) — **ADR-033 D1("backend station-passed 발사 제거")이 결정만 되고 미구현.**
3. **동일 waypoint 이중발사 잔존** (confirmed). 오전 건대 환승: backend transfer 06:41:51 + device transfer 06:41:49 = 8초 차 same-waypoint. ADR-035가 "미검증"으로 남긴 항목이 9/2에도 재현.
4. **"됐다 안 됐다"(flip-flop)의 정체** (diagnosis). 두 권위(ADR-023/026 backend-visible + ADR-035 device-authority)가 **안 합쳐진 채 공존** → GPS/환경분류/flag 상태에 따라 매순간 승자가 바뀜. 지상 GPS 양호 → device 발사, 지하 garbage → device 억제→backend만, 지하 종점 → 둘 다 실패. 환경분류(subsurface) 자체가 오락가락(barometer flip)해 같은 자리서 다르게 판정.

**한 줄 결론**: 발사권위 이전이 **반만 됐다** — device 발사를 되살렸으나(#2379/#2395) backend visible을 안 껐고(ADR-033 D1 미구현), device 지하 발사는 gate-free 경로(#2383)가 engage 못 하거나 fall 후 게이트가 죽인다. 이 세 개를 **순서대로** 닫아야 완결된다.

---

## ⚠️ 검증 상태 (confirmed vs assumed — 2026-09-02 갱신)

| 주장 | 상태 | 근거 |
|---|---|---|
| 지하 종점 도착 = device 억제 + backend 미발사 = miss | ✅ 확정 | 저녁 로그 gate-accuracy/hop-window + D1 destination 0건 |
| backend가 station-passed visible을 발사 중 | ✅ 확정 | scheduled.ts:2677 #2063 + D1 sent |
| device가 station-passed를 legacy로 버림(ADR-033 D1 미구현) | ✅ 확정 | silentPushTask.ts:1358 #2064 |
| 동일 waypoint 이중발사(transfer) | ✅ 확정 | 9/2 오전 건대 backend+device 8초차 |
| device가 지하 arvlCd 신호를 **보유** (발사 소스로 살아있음) | ✅ 확정 | `undergroundConsensusFire`(#2381), position-train-lock(#2383) |
| 저녁 lock의 trainCode = 실코드 (PENDING 아님) | ✅ **확정** (정정) | File B line 282 `autolock-success 7·건대입구` — 건대 탑승응답 → Seoul 도착정보로 실코드 잠김. **초기 "PENDING 가능성"은 오진** |
| device가 지하서 arvlCd로 **올바른 종점(용마산)을 집었나** | ✅ **positive n=1** | File B `17:22:29 fg-arvlcd … station-passed 용마산` — arvlCd가 정확한 종점 식별 |
| 그 arvlCd 발사가 지하서 **일관되게** 정확한가(전 구간·전 트립) | ❌ **미확인** | n=1 positive지만 fusion 티어 회귀 이력(tier-lock/arc/motion flip) → 누적 실탑승으로만 close. **AC7** |
| (축1) 저녁 leg에서 gate-free 경로 #2383가 **engage 안 함**(false 반환) | ✅ **확정** (증상) | File B 저녁 leg position-train cycle 0회. 오전엔 동일 코드로 작동 → 런타임 원인(정적 아님) |
| 그 #2383 false의 **런타임 원인**(poll empty / 피드 드롭 / cadence skip 중 무엇) | ❌ **미확인** | poll-레벨 로그 부재. **G0-1 자가진단 로그로 다음 탑승이 확정** — 유일하게 남은 미확정 |
| (축2) device가 도착을 쏘려 **시도했으나 게이트 스택이 억제** | ✅ **확정** (핵심) | File B 17:22:05~29 `destination early 용마산` = gate-accuracy(2270m)+gate-hop-window+gate-phase-time-integration+gate-hop-window-no-source 4중 억제. "device가 못 잡음"이 아니라 "게이트가 죽임" |

**함의**: Phase 0(지하 device 발사)의 신뢰성이 실증되기 전엔 Phase 2(backend 퇴역) 정당화 불가 — 순서가 hard-gate인 이유. ❌ 항목은 커밋 전 실기기로 닫는다.

---

## 근본 진단 — 두 병이 아니라 하나

- **flip-flop(안정성)** 과 **통과 noise(불필요 발사)** 와 **지하 도착 miss(필요 발사 누락)** 는 **같은 병의 세 증상**이다: 발사권위가 backend·device로 쪼개져 공존하고, device 지하 발사가 게이트로 막혀 있다.
- 따라서 tactical fix(게이트 하나 조정, 통과 문구 하나 끄기)는 whack-a-mole이다(lesson: tactical fix systemic). **권위 이전을 완결**해야 셋이 동시에 죽는다.

---

## Decision

### 종착 상태 (end-state)

```
visible 발사(도착알람 도메인) 권위 = device 단일
  ├ 지상: GPS 기반 fusion 발사 (기존, 게이트 유지)
  └ 지하: arvlCd 발사 (경로는 존재 #2383 — Phase 0: engage 신뢰성 + 게이트 arvlCd-인지)   ← 핵심
backend = SSoT-forward "silent(content-available)"만
  ├ station-passed/transfer/destination visible(aps.alert) 전면 제거
  └ arvlCd/position/lock-sync를 device로 forward (발사 판정은 device)
safetyNet = backend outage 확인 시에만 단일 backstop (변경 없음)
```

### Phase 0 — 지하 device arvlCd 발사 신뢰성 (2026-09-02 **corrected**)

> **정정 (초안 오진 폐기)**: 애초 초안은 "`gate-accuracy` 면제 분기를 **신설**"로 잡았으나 **오진**이었다. 그 면제 경로는 **이미 존재한다** — `evaluatePositionTrainFire`(#2383)가 `backgroundLocationTask.ts:171`에서 **gate-accuracy(:191)보다 먼저**, GPS/accuracy와 독립으로 locked trainCode 열차의 현재역을 arvlCd로 직접 판정해 발사하고, 성공(fired) 시 early-return한다. 9/2 저녁 return leg의 실패는 "면제 분기 부재"가 아니라 **두 축의 복합**이다(오전 outbound에선 #2383이 정상 작동해 뚝섬 발사 성공 → **정적 버그 아님**).

**문제**: 지하 garbage GPS에서 device가 도착을 못 쐈다. 근본은 하나가 아니라 둘 — (①) 이미 존재하는 gate-free 경로(#2383)가 저녁 leg서 engage하지 않았고, (②) fall-through 후 게이트 스택이 arvlCd 유효신호를 과억제했다.

#### 축 1 — #2383 지하 engage 신뢰성 (런타임 원인 규명 + hardening)
- **증상 (confirmed)**: 저녁 leg position-train cycle 0회 = `evaluatePositionTrainFire`가 계속 false 반환 → gate-accuracy(2270m) 경로로 fall. 오전엔 **동일 코드**로 작동(뚝섬 발사).
- **원인 후보 (런타임, 정적 아님)**: (a) 지하 네트워크로 arvlCd/position 폴링 empty·실패, (b) 열차 realtimePosition 피드 드롭, (c) BG cadence(25s 쿨다운)로 fresh poll 부재. `lock.trainCode`(arrivals `btrainNo`) vs realtimePosition `trainNo` 매칭은 Seoul서 동일 열차번호 + 오전 작동 → **매칭 자체는 정상**. poll-레벨 로그 부재로 셋 중 뭔지 미확정 — 하나 확정 못 해도 fix를 막지 않는다.
- **G0-1 (자가진단 로그, 선행 머지)**: `evaluatePositionTrainFire`가 false를 반환한 **이유**(poll empty / 피드 드롭 / cadence skip / trainCode 매칭 실패)를 alarmLog에 구분 적재. → **다음 평범한 탑승이 스스로 원인을 확정**한다("덤프 한 번 더" 전용 진단세션 불필요).
- **G0-2 (hardening)**: G0-1 로그로 확정된 원인에 맞춰 poll 재시도(지하 네트워크 백오프)·열차매칭 견고화·cadence 하 fresh-poll 보장. **원인 확정 전엔 G0-1만 먼저 머지**(관측 먼저, 추측 hardening 금지).

#### 축 2 — 게이트 arvlCd-인지 (fall-through 시 유효신호 과억제 차단)
- **증상 (confirmed)**: #2383이 false로 fall한 뒤 arvlCd가 정확한 종점을 집었는데도 게이트가 죽임 — `17:22:29 fg-arvlcd 용마산`이 `gate-hop-window-no-source`·`gate-phase-time-integration`으로 억제(`useStationAlarm.ts` fg-arvlcd fast-path + hop-window). GPS 지상복귀(20m) 후에도 hop-window가 용마산 도착을 막음.
- **G0-3 (게이트 우회)**: FG/BG 도착 경로에서 **locked trainCode의 arvlCd가 대상 waypoint를 ENTERING/ARRIVED로 확증하면** `gate-hop-window`·`gate-phase-time-integration`을 **우회**한다. 이 게이트는 fusion jitter 방어용인데 arvlCd 확증은 fusion보다 강한 ground truth이므로, **arvlCd 확증이라는 강한 조건에서만 여는 additive 우회**로 추가(#2433 lock+trainCode arvlcd motion-gate 면제 패턴의 도착 확장).
- **G0-4 (오발사 방어 유지)**: 우회는 "게이트 제거"가 아니라 "arvlCd로 대체". arvlCd 확증이 없으면 기존 게이트 그대로(false-positive 방지, AC2). 게이트를 전역으로 느슨하게 하지 않는다.

#### 보조 — PENDING 해소
locked trainCode가 `PENDING` sentinel이면 arvlCd 확증 자체가 불가 → PENDING→실코드 해소(realtimePosition/arrival 매칭)가 선행 조건. **9/2 저녁 lock은 실코드였음이 확정**돼 이 케이스는 아니었으나(초기 "PENDING" 추정은 오진), 타 트립서 발생 가능 — 해소 전엔 miss 허용/오발사 금지, 해소 즉시 발사.

### Phase 1 — device 커버리지 완성 + 실증 (035 Phase 1 + Phase 0 반영)

- **D1**: device FG phase(transfer/destination) 발사 봉인 해제(#2067 → #2395, `useStationAlarm.ts` 기록전용 해제). MINIMAL_ALARM 승격은 **실증 후**.
- **D2**: 매역 문구 표준 "OO역 도착 / {대상}까지 N정거장" (ADR-033 D2, count/target 배선).
- **D3**: 도착알람 도메인이 **FG(active)·BG(locked)·지하(arvlCd)** 3환경 모두에서 device 단독 발사됨을 실기기로 검증. ← **Phase 2의 hard-gate.**

### Phase 2 — backend visible 퇴역 (035 items 5·6·7 + 033 D1)

**Phase 1 실증 후에만.**
- **R1**: `fireArvlCdStationPush`(scheduled.ts:2426) intermediate/transfer/destination **visible 제거** (= 통과 noise 발원지 + 이중발사 소멸). ADR-033 D1 + 035 item5.
- **R2**: `fireVanishFallbackStationPush`(scheduled.ts:2922) visible 제거.
- **R3**: `sendOneFallback`(fallback.ts:124) intermediate retry 제거.
- **유지**: `runLocklessIntermediate`/transfer-release/`maybeReschedulePush` **silent(content-available)** — device 상태 forward. safetyNet outage backstop.

### 옵션 비교 (ADR-014 no-false-binary, 3+ + threshold 카테고리)

| 옵션 | 내용 | 판정 |
|---|---|---|
| **A (본 ADR)** | device 단일 권위 + 지하 arvlCd 발사(Phase0) + backend silent-only | **채택** — 지하 중심·단일 emitter·035 정합 |
| B (hybrid) | 지상 device / 지하 backend visible 유지 | 기각 — emitter 2개 = 이중발사 물리적 방지 불가(ADR-026 §2), flip-flop 존속 |
| C (backend 단일, ADR-026 회귀) | backend가 전부 발사 | 기각 — 현장서 backend push 미도달 실패(035 Context) |
| **D (threshold 선행)** | 권위 변경 전 **지하 위치-진실(arvlCd+trainCode consensus) 정확성부터 실증** | **Phase 0에 흡수** — D를 A의 선행 게이트로 편입(정확성 게이트 보강이 A의 전제) |

---

## Acceptance (사용자 가치 → acceptance → 코드; PR 머지 = close 금지)

| # | 항목 | 검증 | close 게이트 |
|---|---|---|---|
| AC1a | (축1) #2383 gate-free 경로가 지하서 engage — false 반환 시 **사유가 로그로 관측**됨 | G0-1 자가진단 로그 + 다음 평범 탑승 dump | 실기기 지하 (관측) |
| AC1b | (축2) #2383 fall 시에도 arvlCd 확증이 게이트를 우회해 지하 종점 도착 발사(저녁 용마산 재현) | red replay fixture(garbage GPS + arvlCd 확증 → hop-window/phase-time 우회 발사) | CI + **실기기 지하** |
| AC2 | arvlCd 확증 없으면 발사 안 함(오발사 0) | unit(G0-4 우회 조건 negative) | CI |
| AC3 | 지상 도착/환승 발사 **불변**(회귀 0) | red fixture(오전 뚝섬 케이스 발사 유지) | CI |
| AC4 | backend visible station-passed/transfer/destination = 0 (Phase 2 후) | backend worker 테스트 + D1 waypointKind visible 0 | CI + 측정 |
| AC5 | 동일 waypoint 이중발사 0 | device fire 원장 × backend push 카운터 교차 | **실기기 1주 측정** |
| AC6 | trainCode PENDING→실코드 해소가 지하서 동작 | 로그/D1 | 실기기 지하 |
| AC7 | 지하 fusion 매역/도착 **정확성**(올바른 역/열차) | — | 🔴 fusion 신뢰성, **탑승 전용 close** |
| AC8 | field verify 1주: 오발사 0 + 지하 도착 miss 0 + 통과 noise 0 + FG/잠금/지하 도착·환승 각 1회 도달 + outage safetyNet 1회 | 실탑승 dump ↔ D1 | **1주 재발 0 → epic close** |

- **순서 hard-gate**: AC4(backend 제거)는 **AC1a+AC1b+AC7(지하 device 발사·정확성 실기기 확인) 후에만**. 역전 시 지하 도착·매역 전면 공백(ADR-033 A6/A7 계승).
- **정확성 게이트**: AC7은 CI로 증명 불가 — 실탑승으로만 close(fusion 티어 신뢰성 = 프로젝트 핵심 미해결).
- **회귀 금지**: AC3이 지상 발사 불변을 못박는다. Phase 0 면제는 게이트를 전역으로 느슨하게 하지 않는다("되는 걸 후퇴 = 최악").

---

## Sequencing (Phase는 앞 Phase 검증에 hard-gated)

```
Phase 0  지하 device arvlCd 발사 신뢰성(축1 #2383 engage + 축2 게이트 arvlCd-인지)  ── 자가진단 로그 → red fixture → 실기기 지하 발사 실증
   │        (backend visible은 그대로 = 지하 백업 유지, 공백 없음)
   ▼
Phase 1  device FG 봉인해제 + 문구/count 배선 + 3환경 실증        ── FG/잠금/지하 device 단독 발사 확인
   │        MINIMAL_ALARM 승격
   ▼
Phase 2  backend visible 퇴역(통과 noise + 이중발사 동시 소멸)     ── Phase0+1 실증 후에만
```

- **Phase 0이 backend visible을 안 끄고 device 지하 발사를 먼저 켠다** → 검증 기간 중 지하 백업(backend)이 살아있어 공백 0. 실증 후 Phase 2에서 backend를 끈다.
- **병행 트랙**: 08-26/08-27/09-02 덤프를 red→green replay fixture로 굳혀 이중발사·오'통과'·지하 miss를 CI 게이트化(035 병행 트랙 계승).

---

## Trade-offs (정직)

- **device 발사 신뢰성 전면 의존** — Phase 2 후 backend는 silent-only. device 지하 arvlCd 발사가 부정확하면(AC7 미달) 지하 도착이 틀린다. → Phase 0 정확성이 hard-gate.
- **backend outage 시** = safetyNet 단일 backstop(ADR-026과 동일 trade).
- **양 코드베이스 수정 + 실기기 재검증 필수** — 에이전트 device-갭(CI는 type+unit만).
- **flag 승격** = 되돌릴 flag 소멸 → Phase 1 flag ON 실증 후 승격.
- **면제 분기의 오발사 리스크** — arvlCd 확증 조건이 느슨하면 지하 오발사. G0-c(확증 없으면 억제)로 방어하되 실탑승 측정 필수.

---

## 구현 지점 (참조)

- Phase 0 축1(#2383 engage 신뢰성): `src/features/alarm/utils/bgPositionTrainFire.ts`(`evaluatePositionTrainFire`) + `src/features/nearest-station/tasks/backgroundLocationTask.ts:171`(gate-accuracy :191보다 **먼저** 호출, fired 시 early-return). 자가진단 로그(G0-1)는 `src/features/alarm/utils/alarmLog.ts`에 false-사유 reason 추가. consensus 보조: `undergroundConsensusFire.ts`(#2381).
- Phase 0 축2(게이트 arvlCd-인지): `src/features/alarm/hooks/useStationAlarm.ts` fg-arvlcd fast-path(~:1571) + `gate-hop-window`/`gate-hop-window-no-source`/`gate-phase-time-integration` 우회 조건. trainCode 해소(보조): position-train-lock(#2383) 경로.
- Phase 1: `useStationAlarm.ts`(FG 봉인 해제 #2067 지점), `stationNotification.ts`(문구/count), locale `src/shared/i18n/locales/*.json`, `debugFlags.ts`(MINIMAL_ALARM 승격).
- Phase 2: `backend/alarm-worker/src/scheduled.ts`(`fireArvlCdStationPush`/`fireVanishFallbackStationPush` visible 제거), `fallback.ts`, backend `i18n.ts`.

---

## 관련

- **ADR-033** — 매역 device-FG 권위 + 문구/취침 경계. 본 ADR이 D1(backend station-passed 제거)을 Phase 2로 실행.
- **ADR-035** — 도착알람 device 단일 권위. 본 ADR이 실행 계획으로 완결 + Phase 0(지하 arvlCd 발사) 신설.
- **ADR-026** — backend 단일 emitter(현장 실패, 035에서 반전).
- **ADR-010** — 두 실패 모드(false-positive/miss) 동급.
- **ADR-014** — 결정 프로세스(no false binary / field verify close / 사용자 명시 의향 동급).
- **#2381/#2383** — 지하 arvlCd BG 자가감지 + position-train-lock (Phase 0 신호 소스).
- **#2433** — lock+trainCode arvlcd면 motion-gate 면제 (Phase 0 면제 패턴의 선례).
- **#2122** — FG 보조 발사(APNs 35~51s 우회).
