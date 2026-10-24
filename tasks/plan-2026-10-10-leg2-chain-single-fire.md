# plan 2026-10-10 — leg-2 체인: 단일 발사 · lock 정확성 · 프롬프트 반복

- **상태**: **확정** (2026-10-10 사용자 결정) — P1=**A1** · P2-a=**E1** · P2-b=**C2**(E1과 단일 작업) · P3=**D1+D4**
- **출처**: 2026-10-09 라이드(중곡→광화문, 7→5호선, D1 `trip_metrics` id=156, 토큰 `b00dd879`)
- **사용자 지적**: "단일 발사", "leg-2의 정확하지 않은 lock 상태", "lock 후에도 계속되는 prompt notification들"
- **전제**: backend 배포 10/9 01:37Z = 라이드 1시간 전 → 10/7~8 머지 22건의 첫 실측
- **표기**: confirmed(`file:line`/D1/덤프로 확인) / **candidate**(후보, 미확정)

---

## 사용자 가치

1. 환승 후 **"탔나요?"를 한 번** 받는다 — 2분에 4건이 아니다
2. **응답하면 그 즉시 그 열차로 lock이 걸린다** — 응답이 무효가 되지 않는다
3. **lock 걸린 뒤로는 묻지 않는다**
4. **매역 알림은 역마다 한 번** 뜬다

---

# 1. 원인 특정

## P1 — lock 후 프롬프트 재발사 (confirmed)

**실측**: 11:37:51 lock 부착(`sync-received promotedLock trainCode=5559`) → **11:38:24 `leg-boarding-prompt` 또 fired**.

**원인**: `backend/alarm-worker/src/scheduled.ts:8257` 주석이 자인한다 —

> 이 함수는 **lock 활성 여부와 무관하게** 환승 leg마다 평가되므로

`maybeFireLegBoardingPrompt`의 게이트는 ①`promptOptIn ‖ infoModeEnabled`(`:8260`) ②`evaluateBoardingPromptRepeatGate`(`:8295` — silence / max 3회 / 5분 간격)뿐이다. **"lock이 존재한다"를 보는 게이트가 없다.**

5분 간격이 왜 못 막았나: #2898이 **의도적으로 soft block**으로 완화했다(`:8301` 주석 — 같은 열차 approaching→imminent 재확인 허용, 스펙 ①). 즉 11:38:24 재발사는 **현재 설계상 정상 통과**다. 막아야 할 조건이 "lock 존재"인데 그 축이 코드에 없다.

## P2 — 사용자 응답이 leg-2 lock을 만들지 못한다 (원인 2개)

**실측**: 11:37:39·11:37:43 `boarding-confirm-result {"lockState":"leg1"}` (2회). 실제 lock은 **8초 뒤** 11:37:51 device `sync-received promotedLock`이 만들었다. D1 meta에 `resolveOutcome`이 **없다** → 해석 경로에 진입조차 안 했다는 뜻.

### P2-a — leg-1 lock 잔존이 생성 경로를 봉쇄한다 (confirmed)

`src/index.ts:2240`:
```ts
if (working.boardingLock === undefined) {
```

lock 생성·열차 해석 블록(`:2240~2312`) 전체가 **`boardingLock`이 비어 있을 때만** 실행된다. 10/9 트립은 7호선 leg-1 lock을 갖고 있었으므로(`lock_attached=1`) **이 블록에 진입하지 못하고** `:2313-2314` else로 떨어졌다:

```ts
} else {
  lockState = isLegTwoActive(working, now) ? 'leg2' : 'leg1';
}
```

**이 else는 lock을 만들지 않는다. 상태를 보고만 한다.** 즉 **환승 trip에서는 사용자 응답이 구조적으로 leg-2 lock을 만들 수 없다** — leg-1 lock이 남아 있는 한.

### P2-b — 응답 측 leg 판정이 walk-gate에 묶여 있다 (confirmed 코드 / candidate 발동조건)

`src/index.ts:2445`:
```ts
function isLegTwoActive(trip: Trip, now: number): boolean {
  return trip.currentLegAnchor !== undefined
    && trip.legBoardingEligibleAt !== undefined
    && now >= trip.legBoardingEligibleAt;
}
```
주석: *"`resolveActiveLegOrigin`이 `currentLegAnchor` 분기를 선택하는 조건(**#2515 도보시간 게이트**)과 동일 판정"*.

**#2801이 프롬프트 발사에서는 walk-gate를 분리했지만, 응답 처리에서는 분리하지 않았다** — 전형적 편측 fix(`/audit-sides` 방향 축: 발사 ↔ 응답). 그래서 walk-gate가 열리기 전에 뜬 프롬프트에 응답하면 그 응답이 **leg1로 라벨링**된다.

**미확정(candidate)**: 세 조건 중 **어느 것이** false였는지는 확정하지 못했다. D1은 11:37:24에 `intermediate-route 장한평 line=5`(leg-2 처리 중)를, **11:37:51에 `advance 장한평`**(응답 12초 후)을 보여준다 — "응답 시점에 leg-2 전이가 아직 확정되지 않았다"가 유력 후보다. `legBoardingEligibleAt` 값을 D1이 남기지 않아 코드만으로는 특정 불가.

## P3 — 매역 emitter 2개 공존 (confirmed)

**실측**: backend alert **13발**(D1 `cron-fire-attempt` 전부 `sent`) + device 로컬 **2발**(11:49:16 마장 `fg`, 11:58:09·48 광화문 `bg`).

**원인**: device 대리 발사의 조건이 **"backend가 실패했다"가 아니라 "아직 표시 안 됐다"** 다. `#2903`의 `markLocalStationFired` 마커는 **backend push가 표시된 순간에만** 생기고(ADR-040 §맥락 C), device는 **기다리지 않고 즉시** 발사한다. backend 전달이 1~2초 걸리므로 device가 **항상 레이스를 이긴다**.

ADR-035 첫 줄이 예측한 것이 그대로 관측됐다 — *"iOS 식별자 공간 분리상 emitter가 2개면 이중발사를 물리적으로 못 막는다"*.

#2928(유예 타이머)이 이 레이스를 없애려고 만들어졌으나 `EXPO_PUBLIC_LOCAL_FIRE_DEFER`가 `.env`에 없어 **OFF**다(빌드 타임 인라인 — 원격 토글 경로 없음).

---

# 2. 방안 (원인별, 트레이드오프)

## P1 — lock 활성 게이트

| 안 | 내용 | 트레이드오프 |
| --- | --- | --- |
| **A1** | `maybeFireLegBoardingPrompt`에 **"해당 leg의 lock이 실 trainCode를 가지면 차단"** 게이트 추가 | 범위 최소, P1 직결. **leg 스코프를 틀리면 leg-1 lock이 leg-2 프롬프트를 막아 과차단**(10/9가 정확히 그 상태) — 거부 케이스로 고정 필수 |
| A2 | `evaluateBoardingPromptRepeatGate`에 lock 조건 흡수 | 게이트 한 곳으로 모임. 그 함수는 origin 프롬프트와 **공유**라 origin 경로 동작이 같이 바뀐다 — 범위 확대 |
| A3 | lock 부착 시 `legBoardingPromptState.silencedUntil`을 미래로 stamp | 기존 메커니즘 재사용, 신규 게이트 0. **lock 부착 경로가 여러 개**(응답/sync/cron resolve)라 전부 stamp해야 하고 하나 빠지면 편측 |

**추천 A1** — 원인이 "lock 축이 없다"이므로 그 축을 추가하는 것이 직결. A3은 편측 위험이 구조적으로 높다.

## P2-a — leg-1 lock 잔존 봉쇄 → **E1 확정 (2026-10-10 사용자 결정)**

**기각된 전제**: 초안의 B1/B2는 둘 다 "leg-1 해제가 선행"을 깔고 있었다. 사용자 지적으로 그 전제를 폐기한다 — **하차 감지는 체인에서 가장 약한 고리**다(우리가 "하차하셨나요?"를 **묻는 이유 자체가 모르기 때문**). 10/9 실측: hop-end prompt 11:36:24 fired → **11:37:48 silenced**(답 못 받음). leg-2 lock이 leg-1 해제를 기다리면 **영원히 안 걸린다**.

그리고 `feedback_user_intent_equal_protection`이 이미 정해뒀다 — *"boardingPrompt 응답 = 사용자 명시 의향 = **lock 활성과 동급** 정확도 보장 의무"*. 탭은 ground truth이고, 그 효과를 추론(하차 여부)에 종속시킬 수 없다.

| 안 | 내용 | 트레이드오프 | 판정 |
| --- | --- | --- | --- |
| **E1** | **탭이 즉시 그 leg의 lock을 만든다. 이전 lock은 결과적으로 교체(supersede)되며 선행조건이 아니다** | 열차 모호성 없음 — `pickAutoTrainCode`(`boardingPrompt.ts:460`)가 **열차 1개**를 반환하고 본문(`i18n.ts:121-126`)이 그 열차를 명시하므로 **탭 = 제시된 열차 선택**. 하차 감지 의존 제거. **오탑승 탭 시 잘못된 lock**(ADR-010상 false positive도 동급)이고 **자동 교정이 없다** — `lockCorrectionMetrics.ts`는 계측만, 교정은 `BoardingTrainList` 수동 탭 | **채택** |
| E2 | 탭 즉시 lock + leg-1 lock 유지해 **leg별 공존** | 환승 전 조기 탭까지 커버. `boardingLock` **단일 슬롯 → 자료구조 변경**(2~4주, 소비자 전수). ADR-035 첫 줄(단일 권위)과 긴장 | 기각 — 추가 가치가 "조기 탭" 하나뿐이고, leg-2 프롬프트는 `currentLegAnchor`(환승 advance 시 stamp) 없이 뜨지 않아 그 창이 좁다 |
| E3 | 탭은 **의향+열차만 확정**, lock은 그 열차 관측 후 부착 | 오탑승 위험 최소. 10/9처럼 탭 시점에 열차 도착 전이면 **지연 유지**(사용자 가치 2 미충족), 지하 피드 소실 시 영구 미부착 | 기각 |
| E4 | E1 + **자동 교정 경로 신설** | E1의 오탑승 위험을 구조적으로 흡수. 신규 2~3주, 교정 판정이 또 하나의 정확성 문제 | **보류** — E1 배포 후 `recordLockCorrection` 실측이 "수동 교정이 자주 필요하다"를 보일 때 착수. 지금은 근거 없는 선제 작업 |

**부수 효과**: leg-2 탑승 탭은 **leg-1 하차를 함의**한다 → 하차 질문도 함께 해소 가능 → **P1의 "2분 4건 폭주"도 줄어든다.**

## P2-b — 응답 측 walk-gate 결합

| 안 | 내용 | 트레이드오프 |
| --- | --- | --- |
| **C1** | 응답 처리에서 walk-gate 제거 — **#2801을 응답 측으로 확장** | 편측 해소. 프롬프트가 떴다면 응답도 같은 leg로 처리된다(대칭). walk-gate의 원래 목적(도보 중 오탑승 방지)이 **응답 경로에서 사라진다** — 사용자가 실제로 탭했으므로 오탑승 위험은 낮지만 무위험은 아니다 |
| C2 | `isLegTwoActive`를 "**프롬프트를 띄운 leg**"로 판정 — 발사 시 leg를 stamp하고 응답이 그걸 읽음 | 가장 정확(제시=선택). 프롬프트 발사 시 leg stamp 추가 필요 + 그 stamp 신선도 정책 |
| C3 | 응답 시 walk-gate가 안 열렸으면 **보류하고 열린 뒤 적용** | walk-gate 의도 보존. **지연이 남고** 새 pending 상태가 실패 지점 |

**추천 C2 — 그리고 E1과 하나의 작업으로 묶는다.** P2-b의 원인이 "발사와 응답이 서로 다른 기준으로 leg를 판정한다"이므로 기준을 **발사 시점으로 고정**하는 것이 직결이다. C1은 간단하나 walk-gate를 통째로 버린다.

🔴 **E1과의 결합 필수**: E1만 적용하면 탭이 생성 경로에 들어가도 `isLegTwoActive`가 `leg1`을 반환해 **엉뚱한 leg에 lock이 걸린다**(10/9가 정확히 그 상태). 분리 머지 시 중간 상태가 더 나쁘므로 **E1+C2 = 단일 작업 단위**로 처리한다 — "탭 응답이 **그 프롬프트가 제시한 leg·열차**로 lock을 만든다".

## P2 보강 — leg 판정이 틀릴 방향 전수 열거 (2026-10-10 사용자 지적)

초안이 "leg 판정이 틀리면 엉뚱한 leg에 lock이 걸린다"로 뭉갰다. **leg는 GPS와 다르다** — 경로 진행에서 파생되는 **이산·단조** 값이고 지하에서 널뛰지 않는다. 따라서 틀릴 방향이 **유한하며 전부 거부 케이스로 고정 가능**하다.

**모델 확인 (confirmed)**: `scheduled.ts:5872` — `trip.currentLegAnchor = { boardingStation: waypoint.stationName, line: nextLegWaypoint.line }`. **환승마다 재stamp되는 "현재 leg" 모델**이다(일반 처리, 환승 횟수 무관). `countRouteTransfers`(`:8173`)도 `route.type` 기반 데이터 주도다. 쓰기 지점은 전부 3곳뿐 — `scheduled.ts:5872`(cron 전이), `index.ts:2287`(tapAdvance), `index.ts:1221`(carry-over).

| # | 방향 | 발동 조건 | 10/9 | 거부 케이스 |
| --- | --- | --- | --- | --- |
| **W-1** | **지각** — 환승 후인데 leg-1로 판정 | `now < legBoardingEligibleAt` (walk-gate 미개방) | **실측 확정**(`lockState=leg1`) | 환승 advance 완료 + walk-gate 미개방 상태에서 탭 → **현재 leg로 lock** |
| **W-2** | **조기** — 환승 전인데 현재 leg로 판정 | `currentLegAnchor` stamp 후 사용자가 아직 leg-1 열차에 있음 | — | leg-1 주행 중 탭 → **leg-1 lock 유지**(교체 금지) |
| **W-3** | **anchor 부재** — 환승 후인데 anchor 없음 | `scheduled.ts:5872` 미실행 | #2693이 "정상(아직 환승 전)/결함" 구분 이미 도입 | anchor 없음 + 탭 → **leg-1으로 처리**(오배치 금지) |
| **W-4** | **지난 프롬프트에 늦은 응답** | C2 stamp를 읽을 때 사용자가 **이전 leg** 알림을 뒤늦게 탭 | — | stamp가 현재 leg와 불일치 → **거부**(stamp 신선도 정책 필요) |
| **W-5** | **프롬프트 없는 응답** | `useTransferTrainList.ts:245` 직접 탭이 **로컬에서 lock 생성** — stamp 없음 | — | stamp 부재 경로도 **현재 leg로 정확히** 배치 |
| **W-6** | **route 재계산으로 leg 경계 이동** | `route-signature-mismatch` → stamp된 leg가 다른 leg를 가리킴 | **실측 약 30회** | 서명 불일치 후 탭 → **stale stamp로 lock 금지** |
| (W-7) | leg 3+ **라벨** 부정확 | `lockState: 'leg1'\|'leg2'` 이진 | — | **라벨만** 부정확 — lock 배치는 `currentLegAnchor`가 일반 처리. D1 관측 정확성 이슈로 분리 |

**W-6이 유일하게 실제로 "널뛴" 축이다** — GPS가 아니라 **route signature**다. 10/9에 약 30회 났고(device가 군자 기준 낡은 route를 계속 POST), stamp 기반 C2 설계의 가장 큰 리스크다. stamp에 **route signature를 같이 묶어** 불일치 시 거부하는 것이 방어선.

**W-7은 기능 결함이 아니다** — `currentLegAnchor`가 환승 횟수와 무관하게 동작하므로 lock은 올바른 leg에 걸린다. 다만 D1 `lockState`가 leg-3를 `leg2`로 보고하므로 **관측이 거짓**이 된다(L20 룰 ④ 동류 — 지표가 진실을 못 담음). W2 범위에 포함하되 별도 항목으로.

## P3 — 단일 발사

| 안 | 내용 | 트레이드오프 |
| --- | --- | --- |
| **D1** | **#2928 유예 타이머를 기본값화**(플래그 제거) | 설계된 답, 이미 구현됨. backend 미수신 시 대리 발사로 miss 방지. **유예만큼 체감 지연** + ADR-040 §리스크("타이머 버그 시 miss") → **양방향 replay 필수** |
| D2 | device 매역 로컬 발사 **완전 제거** | 가장 단순, 플래그 0. ADR-040 §대안 1의 기각 근거(backend 35~51s)가 10/9 1~2s로 소멸. 단 **10/7 아침에 backend 4발 / device 0수신**이 실제로 있었다 → 전달 실패 시 대체 없음 |
| D3 | 플래그 유지 + **원격 kill-switch** 추가 | 라이드 중 즉시 OFF. 켜기는 **여전히 재빌드**(`EXPO_PUBLIC_*` 빌드 타임 인라인) → 절반만 해결. 원격 채널 신설 작업(arch flag 선례 존재) |
| D4 | **전달률/지연 분포를 90일 보존처에 적재한 뒤 결정** | AC를 실제로 판정 가능해진다. 현재 `silentPushLatency` 원천이 KV TTL 2~5분으로 **소급 불가**. 1~2주 지연 |

**추천 D1 + D4 병행** — D1으로 emitter를 하나로 만들고, D4로 "유예가 miss를 만들지 않는가"를 측정 가능하게 한다. D2는 10/7 전달 실패 사례가 반증.

---

# 3. Acceptance

| # | 축 | 조건 | 판정 |
| --- | --- | --- | --- |
| AC1 | 프롬프트 | lock 부착 이후 같은 leg의 `leg-boarding-prompt` fired **0건** | D1 backfill(10/9 트립) + replay |
| AC2 | lock | 응답이 **그 응답으로** 해당 leg lock 생성. 응답→lock **≤2초** | D1 `boarding-confirm-result`가 leg2 + `resolveOutcome` 존재 |
| AC3 | 단일 발사 | 같은 역에 backend·device 양쪽 발사 **0건** | 덤프 `Whole Chain` (#2933 전제) |
| AC4 | 회귀 | lock 없는 leg 프롬프트는 그대로 발사 (#2801/#2898 보존) | replay 거부 케이스 |
| AC5 | 회귀 | leg-1 lock이 leg-2 프롬프트/응답을 막지 않는다 | replay 거부 케이스 |
| AC6 | 회귀 | 매역 알림 총량 불변 (지상·지하) | replay 19/19 + D1 역별 발사 수 |

**close 조건**: PR 머지 ≠ close. AC1~AC3은 **10/9 실측 트립 replay red→green** + 배포 후 D1 backfill 0건.

---

# 4. 실행 순서 (TDD)

각 단위는 **이슈 스펙만 보고 실패 테스트 먼저 → red 커밋 → 최소 구현 green**. 커밋 순서가 증거(CLAUDE.md "TDD 필수").

| # | 원인 | 방안 | 파일 | 의존 |
| --- | --- | --- | --- | --- |
| **W1** | P1 | A1 — lock 활성 게이트 | `backend/.../scheduled.ts` | 없음 |
| **W2** | **P2-a + P2-b** | **E1 + C2** — 탭이 제시된 leg·열차로 lock 생성 | `backend/.../index.ts` + `scheduled.ts`(발사 시 leg/train stamp) | W1 후(동일 파일) · **열거 선행** |
| **W3** | P3 | D1 — 유예 기본값화 | device `useStationAlarm.ts`·`debugFlags.ts` | 없음 — **병렬** |
| W4 | P3 측정 | D4 — 지연 분포 90일 보존처 적재 | backend | W3 후 |

**W2 거부 케이스 — §P2 보강의 W-1~W-6 전부를 TDD 제약으로 고정한다.** 추가 선행 작업으로 **`boardingLock` 소비자 전수 열거**(L20 룰 ①): 표시/판정/발사 축으로 소비자를 열거해 **"lock 교체 순간"을 각 소비자가 어떻게 보는지** 확정한다. #2696("잘못된 lock 하나가 trip 전체 알림을 죽인다")이 그 위험의 선례다. 열거 결과는 E1을 막는 게 아니라 **E1의 거부 케이스를 정의**한다.

# 5. 기존 이슈 매핑

- **#2939** — P1/W1. **plan 확정 전 생성(순서 위반)**. 내용은 A1과 일치 → 본문에 본 plan 링크 추가해 재사용
- **#2780** ("leg-2 전이 확증이 사용자 탑승 증거 없이 lock") — P2의 **반대 방향**. 같은 root(leg-2 lock이 사용자 응답과 분리)의 다른 면 → W2·W3을 여기 매핑하거나 교차 링크
- **#2801** — walk-gate 분리. P2-b가 그 **미완 측면** → 교차 링크
- **#2898** — 5분 soft block(의도된 설계). AC4가 보존 대상
- **#2696** ("잘못된 lock 하나가 trip 전체 알림을 죽인다") — B1/B2의 위험 선례
- **#2905** — D4 측정 적재처

---

# 6. 범위 밖 (별도 트랙)

- GPS 동결 → LA arbitration (ADR-039 표시 축 권한, 옵션 a~d 미결)
- `boardedAt` 기준점 (탐지 시각 → 실제 도착 시각)
- `MINIMAL_ALARM` dormant 코드 처분 (ADR-040 §열려있는 결정 7)
- 릴리스 파이프라인 (main 마지막 커밋 2026-05-14, 미출시 2,440 커밋, PR #2060 7/22부터 개방)
