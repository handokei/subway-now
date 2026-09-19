# Plan #1843 — environmentDistributionCounter observed window 의미 분석 (audit 2)

> Parent issue: #1821 audit 목표 §3 "audit 2"
> Issue: #1843
> 라벨: docs

---

## §1 메커니즘 — observed window 정의

### 1.1 counter 알고리즘

`createEnvironmentDistributionCounter()` (순수 클로저, React/AsyncStorage 의존 없음):

- **tick(state, nowMs)**: state별 누적 ms를 시간 적분.
  - 첫 tick: 시각 진입 기록만(`lastTickMs = nowMs`), 누적 0.
  - 연속 같은 state: `nowMs - lastTickMs` 만큼 해당 state 버킷에 더함.
  - 다른 state: 이전 버킷에 직전 경과 플러시 → 새 state로 전환 → `transitions++`.
- **snapshot(nowMs)**: 내부 totals 복사본 + 현재 진행분(`nowMs - lastTickMs`) 추가 → totals/percentages/transitions/observedMs 반환. 내부 상태 불변.
- **observedMs** = `sum(snapshotTotals[state] for state in ALL_STATES)` = tick 첫 호출 이후 흐른 총 ms.

### 1.2 counter 생성 위치

`DebugModal.tsx:1574`:
```ts
const envDistributionCounterRef = useRef(createEnvironmentDistributionCounter());
```

- **counter는 DebugModalInner 마운트 시 단 한 번 생성**된다.
- `useRef`이므로 re-render 간에는 동일 인스턴스가 유지된다.
- **DebugModalInner가 언마운트되면(모달 닫힘) counter는 소멸**된다. 다음 번 모달 열릴 때 새 counter 생성.

### 1.3 tick 호출 위치

`DebugModal.tsx:1575-1580` — **매 render 시** 호출:
```ts
const envDistribution = buildEnvironmentDistributionMeta({
  surfaceSSOTActive,
  undergroundSSOTActive,
  counter: envDistributionCounterRef.current,
  nowMs: Date.now(),
});
```

`buildEnvironmentDistributionMeta` 내부:
1. `currentObservedMs = counter.snapshot(nowMs).observedMs` — tick 전 현재 관찰 시간 산출
2. `state = deriveEnvironmentState({ ..., observedMs: currentObservedMs })` — 환경 state 결정
3. `counter.tick(state, nowMs)` — 적분
4. `return counter.snapshot(nowMs)` — 최신 snapshot 반환

### 1.4 observed window 정의 결론

> **observedMs = DebugModal이 열려 있는 동안 tick이 호출된 총 경과 시간.**

- 모달이 열린 순간부터 tick 첫 호출까지가 t₀.
- 이후 React render마다 tick이 불린다 (state 변경 / `surfaceSSOTActive` 갱신 등).
- **모달이 닫히면 counter 소멸 — 다음에 열 때 0부터 재시작.**

### 1.5 deriveEnvironmentState의 observedMs 역할

```ts
return observedMs < ENV_WARMUP_WINDOW_MS ? 'unknown_warmup' : 'unknown';
```

`ENV_WARMUP_WINDOW_MS = 60_000` (60s).

- observedMs = counter가 적분한 시간 = **모달 열린 경과 시간**이다.
- 의도: "모달 열린 지 60s 미만이면 unknown_warmup, 이상이면 unknown".
- 사용처: `unknown_warmup`/`unknown` 분류를 dump에 노출 → 사용자가 "이 dump를 보내기 직전에 모달을 열었는지" 추정 가능.

---

## §2 Day 2 evidence 해석 — unknown=100% × 35분 trip, observed=7s

### 2.1 상황 재구성

- 사용자가 35분 lockless trip 중 DebugModal을 **열고 7초 후 share dump**를 눌렀다.
- counter는 모달 열린 시점부터 측정 시작 → 7s 후 dump.
- 그 7s 동안 `surfaceSSOTActive=false`, `undergroundSSOTActive=false` (lockless trip, Tier 1 SSOT 미합의).
- `observedMs = 7s` → `observedMs < 60s` → **매 tick이 `unknown_warmup`으로 분류**.
- dump 결과: `unknown_warmup=100%`, `observed=7s`.

### 2.2 "unknown=100%"의 실제 의미

dump에서 `unknown_warmup=100%`로 나왔을 가능성이 높다 (Day 2 dump 텍스트가 `unknown=100%`로 축약 표기됐을 수 있음). 어느 쪽이든 의미는 동일:

- **35분 trip 전체가 아니라 dump 직전 7s만 반영**.
- trip 시작부터 35분의 환경 분포를 볼 수 없다.

### 2.3 핵심 원인

counter가 **모달이 열려 있는 동안만** 측정하도록 설계됐기 때문이다. 코드 주석에도 명시:
```
// 모달 인스턴스마다 1개. 관찰자 효과 최소화를 위해 모달이 열려있는 동안만 동작.
```

이 설계 결정은 의도적이다. "DebugModal이 Background GPS 폴링을 2배로 만들지 않기 위해" 모달 열린 동안만 관찰한다는 comment가 있다 (DebugModal.tsx:1366~1368).

---

## §3 의도된 사용 — counter가 어떤 결정에 영향을 주나

### 3.1 현재 사용처

**측정만(동작 변경 0)**: counter는 dump/UI의 "Environment Distribution" 섹션을 채운다.

```ts
// buildEnvironmentDistributionSection — SHARE_SECTIONS 등록
{ title: 'Environment Distribution', build: buildEnvironmentDistributionSection },
```

출력:
```
surface=42.3% underground=18.1% hybrid=3.2% unknown=36.4% unknown_warmup=0.0%
totals: surface=12m30s underground=5m24s hybrid=58s unknown=10m54s unknown_warmup=0s
transitions=5
observed=30m0s
```

### 3.2 결정 영향 없음

counter 값이 fusion 판단 / alarm gate / boardingPrompt / lock 활성 판단에 영향을 주지 않는다. 순수 관찰 목적.

### 3.3 의도된 사용의 한계

모달이 짧게 열렸다 닫히면(share dump 목적) observed가 수 초 ~ 수십 초에 불과해 **trip 전체 환경 분포를 대표하지 못한다**.

설계 문서 (#1430) 주석: "매 render time tick을 push, snapshot은 dump 시 한 번씩 조회."
즉 설계상 "trip 전체 분포"가 아닌 "모달 열린 동안의 분포"가 측정 목표였다.

---

## §4 결론 — 4택 중 1택

### 결론: **"window 짧음" — 의도와 설계는 일치하지만, trip-level 진단 목적으로는 window가 구조적으로 짧다.**

### 세부 이유

| 항목 | 판단 |
|------|------|
| 알고리즘 정확성 | 정상 — tick/snapshot/flushAccumulated 모두 정확히 구현됨 |
| observed window 정의 | 명확 — "DebugModal 열린 경과 시간" |
| 의도와 사용처 일치 | 일치 — 코드 주석 "#1430 — 동작 변경 0, 측정만" |
| Day 2 evidence 설명 | 완전 설명됨 — 모달 7초 후 share dump → observed=7s |
| Trip-level 진단 목적 | **구조적 갭** — 모달 열린 구간만 측정하므로 trip 전체 unknown 비율을 볼 수 없음 |

### "정상 작동" vs "window 짧음" 구분

- counter 자체 알고리즘: 정상 작동.
- 진단 목적(trip 전체 환경 분포): window가 구조적으로 짧다.

두 판단이 충돌하지 않는다. **코드는 설계 의도대로 동작하지만, "35분 lockless trip에서 환경 분포가 어땠는지" 라는 진단 질문에 답하기에는 window가 부족하다.**

### Trip-level 환경 분포가 필요한가?

- #1821 가설("lockless trip 35분 → unknown=100%가 왜 발생하나")을 답하려면, trip 시작부터 모달 열기 전까지의 SSOT 활성 이력이 필요하다.
- 이는 현재 counter 설계 범위 밖이다 (모달-only window).
- counter 설계를 바꿔 trip 시작부터 측정하려면: counter를 useFusedNearestStation 레벨에서 생성하고 trip-scoped lifecycle을 부여해야 한다 (별도 이슈/작업).

### unknown=100%의 실제 원인 (counter와 무관)

35분 trip 동안 `surfaceSSOTActive=false, undergroundSSOTActive=false` 였다는 것이 실제 가설 검증 대상이다. counter는 이를 측정하는 도구가 아니라 모달 열린 구간만 캡처한다. 실제 원인 추적은 Tier 1 SSOT (surfaceSSOT / undergroundSSOT) 활성 여부를 직접 조회해야 한다 (#1821 다른 audit에서 다룰 사항).

---

## §5 코드 수정 여부 결정

**수정 없음** — counter 알고리즘은 설계 의도대로 정확히 동작한다. 진단 갭은 구조적 설계 선택(모달-only window)에서 비롯되며, 그 선택은 "관찰자 효과 최소화"라는 명시적 trade-off 아래 이루어졌다.

Trip-level 환경 분포 측정이 필요하다면 별도 이슈로 trip-scoped counter 도입을 검토한다. 본 PR은 doc-only.

---

## §6 Wire-completion 5단 (PR 본문용)

1. **Orphan**: doc-only — 신규 export 없음. lint:orphan 대상 없음.
2. **V/X dashboard**: counter 값 노출 위치 = DebugModal "Environment Distribution" 섹션. observed=Xs로 모달 열린 경과 시간 직접 확인 가능.
3. **의존 PR**: N/A — 코드 변경 없음.
4. **측정 plan**: Day 3+ trip에서 모달을 열고 1분+ 유지 후 share dump → `observed=60s+` 확인 → `unknown vs unknown_warmup` 구분 가능. trip 전체 분포는 현재 counter로 측정 불가 (설계 한계 명시 후 close).
5. **Device verify**: N/A — doc only. 코드 변경 없음.

---

## §7 요약

| 항목 | 결과 |
|------|------|
| observed window 정의 | DebugModal 열린 경과 시간 (ms) |
| reset 조건 | 모달 닫힘 = counter 소멸, 다음 열릴 때 0부터 재시작 |
| Day 2 observed=7s 원인 | 모달을 7초만 열고 share dump |
| unknown=100% 의미 | 모달 열린 7s 동안 Tier 1 SSOT 미합의 상태 |
| counter 알고리즘 정상 여부 | 정상 |
| 진단 갭 | Trip 전체 환경 분포를 볼 수 없음 (설계 한계) |
| 결론 | **window 짧음** (알고리즘 정상, 진단 목적 구조적 한계) |
| 코드 수정 | 없음 (doc-only) |
