# Plan #1864 — F6: trip-scoped environment counter 도입

> Issue: #1864
> 라벨: chore
> 출처: tasks/plan-1843-environment-counter-audit.md §4 결론 "Trip-level 환경 분포가 필요하다면 별도 이슈"
> 의존 PR: #1847 (머지됨)

---

## §1 가치 — Trip-level 환경 분포를 자동 capture

### 1.1 현재 진단 갭

35분 lockless trip에서 사용자가 DebugModal을 열고 7초 후 share dump를 눌렀을 때:

- `observed=7s`, `unknown_warmup=100%` — trip 35분 전체가 아니라 **dump 직전 7s만** 반영.
- trip 동안 `surfaceSSOTActive=false, undergroundSSOTActive=false`였는지 자동으로 알 수 없다.
- 현재는 사용자가 모달을 1분+ 열고 있어야 의미 있는 데이터가 쌓인다.

### 1.2 trip-scoped counter가 채워주는 것

| 질문 | 현재 | trip-scoped counter 도입 후 |
|------|------|----------------------------|
| "이 35분 trip에서 환경이 어땠나?" | 알 수 없음 | trip 종료 시 자동 snapshot 가능 |
| "underground 구간이 몇 분이었나?" | 모달 열린 구간만 | 전체 trip 집계 |
| "unknown이 100%인 trip의 패턴?" | 발생 시 사후 알 수 없음 | Sentry breadcrumb / rawSignal에 포함 가능 |
| "fixture chain runner에서 환경 stage 확인?" | 불가 (모달 없음) | trip 종료 시 snapshot 제공 가능 |

### 1.3 V/X acceptance 연결

- **V/X acceptance 분석**: trip마다 surface/underground/unknown 비율이 기록되면 "X5 (unknown 60%+ trip 비율)" 같은 acceptance metric을 자동 계산 가능.
- **Sentry breadcrumb**: trip 종료 시 환경 분포를 breadcrumb으로 전송 → 알람 실패 사고 분석에서 "이 trip에서 underground였나?"를 사후 질문 가능.
- **fixture chain runner**: `src/testUtils/fixtureChainRunner.ts`의 stage 검증에서 trip 환경을 기준으로 시나리오 분기 가능.

---

## §2 현재 한계 — modal-only window 설계

### 2.1 counter 생성 위치

```ts
// src/features/debug/components/DebugModal.tsx:1574
const envDistributionCounterRef = useRef(createEnvironmentDistributionCounter());
```

- `DebugModalInner` 마운트 시 생성 → 언마운트(모달 닫힘) 시 소멸.
- `observedMs` = 모달 열린 경과 시간.

### 2.2 tick 호출 위치

매 render 시 `buildEnvironmentDistributionMeta` → `counter.tick()`. 모달이 닫히면 tick 없음.

### 2.3 의도적 설계 선택 (코드 주석)

```
// 모달 인스턴스마다 1개. 관찰자 효과 최소화를 위해 모달이 열려있는 동안만 동작.
```

"DebugModal이 BG GPS 폴링을 2배로 만들지 않기 위해" 모달 열린 동안만 관찰.

### 2.4 trip-scoped counter가 해결해야 할 것

- tick 주체를 모달이 아닌 **`useFusedNearestStation` 레벨**(BG polling cycle)로 이동.
- trip 시작 ~ 종료 lifecycle과 counter lifecycle을 동기화.
- tick 비용: 정수 덧셈 × 2 + 비교 × 1 = O(1), polling overhead 무시 가능.

---

## §3 옵션 매트릭스

> false binary 차단: 최소 3개 옵션. "도입 vs 미도입" 이분법 금지.

### 옵션 A: In-memory trip 단위 archive

**구현**: `createEnvironmentDistributionCounter()`를 trip 시작 시(`setTripStartedAt` 호출 지점) 생성, in-memory Zustand 슬롯 또는 module-level ref에 보관. trip 종료(`tripBoundCleanups`) 시 `snapshot()` 호출 후 archive에 저장(AsyncStorage 또는 Sentry breadcrumb).

```
trip start → createCounter() → module ref 보관
  └─ useFusedNearestStation polling cycle마다 tick()
trip end   → snapshot() → AsyncStorage archive OR Sentry breadcrumb → counter null
```

**장점**:
- 구현 범위 최소 (counter 알고리즘 재사용 100%).
- trip 중 storage IO 없음 (trip 종료 1회 write).
- BG 폴링 cycle에 tick() 추가 비용 O(1).

**단점**:
- 강제종료(OS kill) 시 in-memory 소실 — archive 기록 안 됨.
- 여러 파일에 접근 필요 (`useFusedNearestStation`, `tripBoundCleanups`, 선택적 `setTripStartedAt`).

**storage 부담**: trip 종료 1회 AsyncStorage write (JSON ~200 bytes). 부담 없음.

---

### 옵션 B: AsyncStorage persistent ring buffer (trip 단위)

**구현**: trip 시작 시 새 counter 생성 + **매 N분(예: 5분)마다** snapshot을 AsyncStorage에 checkpoint. trip 종료 시 final snapshot. 최대 M trip 보관 ring buffer.

```
trip start → createCounter()
  └─ 5분마다 checkpoint → AsyncStorage TRIP_ENV_CHECKPOINT_KEY
  └─ polling tick() (in-memory)
trip end   → final snapshot → ring buffer append → cleanup
```

**장점**:
- 강제종료 후에도 5분 단위 checkpoint까지 복구 가능.
- 멀티 trip 이력 보관 (ring buffer N trip).

**단점**:
- 5분마다 AsyncStorage write → BG polling에 IO 추가.
- 구현 복잡도 증가 (checkpoint timer, ring buffer 관리).
- 실제 강제종료 빈도가 낮으면 over-engineering.

**storage 부담**: 5분마다 ~200 bytes write. 60분 trip = 12회 = 2.4 KB. 수용 가능하나 polling overhead 존재.

---

### 옵션 C: RAW_SIGNALS KV append (backend 경유)

**구현**: trip 종료 시 rawSignalBuffer dump(기존 `signalDumpBackend.ts`)에 환경 분포 snapshot을 필드로 포함 → backend `RAW_SIGNALS` KV에 저장.

```
trip end → rawSignalBuffer dump → envDistribution snapshot 첨부 → backend KV
         → wrangler kv get / admin API로 조회
```

**장점**:
- 이미 있는 rawSignal dump 경로에 필드 추가만.
- backend KV 조회로 여러 trip 이력 비교 가능.
- device 재설치 후에도 backend에 이력 남음.

**단점**:
- backend 의존 — Phase 6 paradigm "device-only chain" 원칙과 충돌 가능성.
- backend KV TTL 60일 이내만 조회 가능.
- network 실패 시 dump 손실 (graceful 처리 필요, 기존 rawSignal과 동일).

**storage 부담**: 기존 rawSignal dump에 JSON 200 bytes 추가. 무시 가능.

---

### 옵션 D: 현 상태 유지 (modal-only window 개선 없음)

**구현**: 현재 counter 설계 유지. 모달-only window 한계를 문서화하고 trip-level 진단은 rawSignalBuffer(per-entry cellular/subsurface 필드)로 대체.

**장점**:
- 신규 코드 없음. 회귀 위험 없음.
- rawSignalBuffer entry마다 `subsurface`, `cellular.vote` 이미 기록 → trip 전체 재구성 가능(단, 수작업).

**단점**:
- 진단 자동화 없음 — 매번 rawSignal dump 수작업 파싱 필요.
- V/X acceptance metric 자동 계산 불가.
- "unknown=100%" 재발 시 동일한 진단 갭 반복.

**storage 부담**: 없음.

---

## §4 트레이드오프 비교

| 항목 | A (in-memory archive) | B (persistent checkpoint) | C (KV append) | D (현상 유지) |
|------|----------------------|--------------------------|---------------|--------------|
| 구현 복잡도 | 낮음 | 중간 | 낮음 (기존 경로 확장) | 없음 |
| 강제종료 손실 | 있음 | 없음 (5분 이내 손실만) | 없음 | N/A |
| storage IO (BG polling 중) | 없음 | 5분마다 1회 | 없음 | 없음 |
| backend 의존 | 없음 | 없음 | 있음 | 없음 |
| 멀티 trip 이력 | 미정 (별도 구현) | 있음 (ring buffer) | 있음 (KV) | 없음 |
| V/X metric 자동화 | 가능 (trip end) | 가능 (trip end) | 가능 (backend) | 불가 |
| Sentry breadcrumb | 가능 (trip end) | 가능 | 가능 | 불가 |
| fixture chain runner 연동 | 가능 (in-memory) | 가능 | 아님 (backend) | 불가 |
| 회귀 위험 | 낮음 | 중간 | 낮음 | 없음 |
| Phase 6 paradigm 적합성 | 높음 | 높음 | 주의 필요 | 높음 |

### 결정 기준별 권장

| 목표 | 권장 옵션 |
|------|-----------|
| 구현 최소 + 진단 자동화 | **A** |
| 강제종료 내성 최대화 | **B** |
| 멀티 trip 이력 + backend 조회 | **C** (rawSignal 경로 재사용) |
| 신규 코드 없이 현 상태 유지 | **D** |

---

## §5 결론 — 사용자 결정 필요

현재 단계에서 특정 옵션을 확정하지 않는다. 아래 질문에 대한 사용자 결정이 구현 방향을 결정한다.

### 결정 질문 1: 강제종료 내성이 필요한가?

- **Yes** → 옵션 B (checkpoint) 또는 C (KV).
- **No (trip 종료 archive로 충분)** → 옵션 A.

현실: iOS BG kill은 앱이 foreground로 돌아오기 전에 드물게 발생. trip 35분 중 kill 비율은 낮다. 옵션 A가 대부분의 trip을 커버.

### 결정 질문 2: backend 의존을 허용하나?

- **Yes** → C가 기존 rawSignal 경로 재사용으로 가장 저비용.
- **No (Phase 6 device-only)** → A 또는 B.

### 결정 질문 3: 진단 자동화 vs 현상 유지?

- 동일한 `unknown=100%` 재발을 자동으로 잡으려면 A/B/C 중 1택.
- 수작업 rawSignal 파싱으로 충분하면 D.

### 권장 기본값 (에이전트 의견)

옵션 A — 구현 최소, 강제종료 손실은 낮은 빈도, Phase 6 paradigm 적합. 구현 시 다음 연결:

1. `src/features/nearest-station/hooks/useFusedNearestStation.ts` — polling cycle마다 `counter.tick()`.
2. `src/features/alarm/store/tripBoundCleanups.ts` — trip 종료 시 `counter.snapshot()` → AsyncStorage archive 또는 Sentry breadcrumb.
3. `src/features/debug/components/DebugModal.tsx` — 기존 modal counter는 유지 (모달-only window 진단 목적은 여전히 유효). trip counter snapshot을 추가로 표시.

---

## §6 Acceptance

> 사용자 결정 후 별도 구현 PR에서 acceptance를 정의한다. 아래는 구현 PR의 예시 acceptance.

옵션 A 기준 (결정 후 조정):

- trip 활성 중 polling cycle마다 counter tick이 발생한다.
- trip 종료 시 `snapshot().observedMs` ≈ 실제 trip 시간(5% 오차 허용).
- trip 종료 시 snapshot이 AsyncStorage 또는 Sentry breadcrumb에 기록된다.
- share dump에 trip-level 환경 분포가 포함된다.
- `unknown=100%`인 35분 trip이 재발하면 trip counter에서 자동 캡처된다.
- DebugModal 기존 modal-only counter는 영향받지 않는다.

---

## §7 Wire-completion 5단 (plan doc PR)

1. **Orphan**: N/A — plan doc only. 신규 export 없음.
2. **V/X dashboard**: 구현 후 share dump / Sentry breadcrumb에 trip 환경 분포 자동 포함. V/X metric 자동화 가능.
3. **의존 PR**: #1847 머지됨.
4. **측정 plan**: 구현 후 1주 trip 캡처 → trip 시작~종료 `observedMs` vs 실제 trip 시간 비교. unknown 비율 trend 추적.
5. **Device verify**: 구현 후 실기기 trip 1회 → share dump에서 `trip-level env dist` 섹션 확인. `observed ≈ 실제 trip 시간` 검증.

---

## §8 관련 메모리 / 참고

- `memory/feedback_v_x_acceptance_full_table.md` — V/X acceptance 전체 표. V5 (environment 분류 정확도) 관련.
- `memory/feedback_phase0_measurement_infra_pattern.md` — Phase 0 측정 인프라 패턴. Sentry + analytics 채널.
- `tasks/plan-1843-environment-counter-audit.md` — audit 결론 §4 "window 짧음".
- `src/features/nearest-station/utils/environmentDistributionCounter.ts` — 재사용 가능한 counter 알고리즘.
- `src/features/observability/utils/rawSignalBuffer.ts` — AsyncStorage ring buffer 패턴 참고.
- `src/features/alarm/store/tripBoundCleanups.ts` — trip lifecycle cleanup 훅. counter cleanup 추가 지점.
- `src/features/alarm/utils/tripStartStorage.ts` — trip 시작 시점. counter 생성 위치 후보.
- `src/features/alarm/api/signalDumpBackend.ts` — 옵션 C 경로.
