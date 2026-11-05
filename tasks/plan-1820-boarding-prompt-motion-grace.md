# Plan #1820 — backend boarding-prompt motion-not-moving 차단 fix

**SSoT**: 본 문서. 이슈 본문은 작업 컨텍스트, 본 SSoT는 영구 reference.

## 1. 문제

backend boarding-prompt cron이 lockless 사용자에게 표시할 응답 프롬프트를 100% 차단.

### Production evidence (2026-06-25 Day 2 dump)

- backend log 6시간+ 범위 (logs-2026-06-25T08_30_12.817Z.json)
- `boarding-prompt: gate blocked` 36건 (KST 14:19~14:23, 1분 cron)
- **모두 `reason=motion-not-moving + environment=unknown`**
- 같은 trip token=e25e1158 (Day 1 trip 2 + Trip 3 마장→용마산 연장)

### 사용자 가치 손실

- Trip 3 (lockless + 사용자 의향 X) 시: paradigm Phase 1 device fire 0건 ✅ (PR #1819)
- 그런데 lockless 사용자가 알림 받을 길은 boardingPrompt 응답뿐
- backend가 100% 차단 → 사용자 응답 기회조차 없음 → lock attach 0건 → 매역 알림 0건

## 2. 원인

**파일**: `backend/alarm-worker/src/boardingPrompt.ts`

### L242 — motion 게이트가 모든 환경에서 평가됨

```ts
// L242
if (metrics.motion !== 'walking' && metrics.motion !== 'automotive') {
  return { pass: false, reason: 'motion-not-moving', metrics };
}
```

### 게이트 흐름 (L220~L254)

1. silence dedup
2. `isGpsDependentBypassEnv(env)` 평가 — underground/mixed/unknown → GPS 게이트 byPass
3. GPS-bypass 아닐 때만 geometry 게이트 (L234)
4. **L242 motion 게이트 — 모든 환경에서 평가**
5. fused speed 게이트 (GPS-bypass면 skip, L247~)

### 근본 원인

- iOS CMMotionActivity 5~10분 lag ([[lesson_motion_activity_intermittent_signal]])
- trip 시작 직후 `unknown` 상태가 normal
- 지하 환경에서는 motion이 walking/automotive로 수렴하기까지 시간 더 필요
- environment=unknown 100% 회귀 (잔여 #2)와 결합 → 영구 차단

### 코드 주석 (L239~L241)이 명시한 보완 의도

> "CMMotionActivity 기반 신호는 지하에서도 작동 (mem `lesson_motion_activity_intermittent_signal` 의 5~10분 주기 뒤집힘 한계는 caller 의 consensusGate 가 arrival+lockAttachable 합의로 보완)"

→ caller consensus는 보완 의도지만, **이 게이트 자체에서 차단되면 caller에 도달 못함**.

## 3. 방안 옵션 (3개 이상, false binary 금지)

### A. GPS-dependent bypass 환경에서 motion=unknown 허용 (작은 fix)

```ts
if (gpsDependentBypass) {
  // unknown 허용 (warmup grace) — caller consensusGate가 추가 보완
  if (metrics.motion === 'stationary') {
    return { pass: false, reason: 'motion-stationary', metrics };
  }
  // walking / automotive / unknown 모두 통과
} else {
  // GPS 환경: 기존 정책 유지
  if (metrics.motion !== 'walking' && metrics.motion !== 'automotive') {
    return { pass: false, reason: 'motion-not-moving', metrics };
  }
}
```

### B. Trip 시작 첫 90s grace window (중간 fix, trip metadata 필요)

inputs에 `tripStartedAt: number` 추가. 90s 이내면 motion=unknown 허용. 91s 후 기존 정책.

### C. 모든 환경에서 motion=unknown 허용 (가장 풀어주는 fix, 위험)

`stationary`만 차단. `walking | automotive | unknown` 통과. GPS 환경에서도 적용 → false positive 위험.

### D. caller 측 consensus 게이트 우회 추가 (현 게이트 유지)

`boardingPrompt.ts` 변경 없이 caller (`scheduled.ts` 또는 cron)에서 별도 우회 로직. 코드 복잡도 ↑.

## 4. 트레이드오프

| 옵션 | False positive 위험 | 사용자 가치 회복 | 변경 범위 | 회귀 위험 |
|---|---|---|---|---|
| A | 낮음 (지하만, caller consensus 보완) | 높음 (지하 trip 100% 회복) | 1 파일 ~10 LOC | 낮음 |
| B | 낮음 (90s window) | 중간 (지상도 회복) | 1 파일 + inputs 확장 | 중간 (tripStartedAt 전달 필요) |
| C | 높음 (GPS 환경 false positive 가능) | 가장 높음 | 1 파일 ~3 LOC | 높음 |
| D | 0 | 중간 | 별도 모듈 | 높음 (이중 게이트 혼란) |

### A vs B 비교

- A는 environment=unknown이 회복되면 효과 자동 사라짐 (잔여 #2 fix 후 점진적 정상화)
- B는 지상 환경 trip도 첫 90s grace — 더 보편적이지만 false positive 위험 약간 ↑
- A + B 결합도 가능 — 단, 복잡도 ↑

### consensus 보완 신뢰성

L239~L241 주석은 caller consensus가 보완한다고 주장하지만, 실제 caller가 어디고 어떻게 보완하는지 추가 검증 필요. BG agent가 이를 확인 후 결정.

## 5. 결정

**선택: A — GPS-dependent bypass 환경에서 motion=unknown 허용**

이유:
1. evidence 36건 모두 environment=unknown — 정확히 A가 cover하는 영역
2. 변경 범위 최소 (1 파일, ~10 LOC)
3. GPS 환경 false positive 위험 0
4. 잔여 #2 (environment 분류 회복) fix 진행 시 자동 점진 정상화
5. caller consensus가 추가 보완 (코드 주석 명시 의도와 일치)

### Acceptance

- backend `boardingPrompt.test.ts` 추가:
  - underground + motion=unknown → pass
  - underground + motion=stationary → fail (reason=motion-stationary)
  - underground + motion=walking → pass (기존)
  - surface + motion=unknown → fail (reason=motion-not-moving, 기존 유지)
  - surface + motion=walking → pass (기존)
- production cron 1주 측정: `motion-not-moving + environment=unknown` 차단 횟수 0건 수렴

### Out of scope

- environment=unknown 100% 자체 fix는 잔여 #2 별도 PR
- caller consensus 게이트 검증은 보완 차원, 본 PR scope 아님
- A + B 결합은 evidence 추가 시 follow-up

## 6. Wire-completion 5단 self-check

1. Orphan 없음 — fix는 기존 함수 분기만 추가. orphan 없음
2. V/X dashboard — `boarding-prompt blocked` reason 분포 (wrangler tail + Cloudflare Dashboard)
3. 의존 PR — 잔여 #2 환경 분류 fix와 독립. 머지 순서 무관
4. 측정 plan — production cron 1주, motion-not-moving + environment=unknown 차단 0건 수렴
5. Device verify — N/A (backend type+unit only)

## 관련 메모리

- [[lesson_motion_activity_intermittent_signal]] iOS CMMotionActivity 5~10분 lag
- [[project_2026_06_25_day2_pr1819_confirmed]] Day 2 진입점
- [[feedback_user_intent_equal_protection]] paradigm 정신 — lockless 사용자도 boardingPrompt 응답 길 보장
- [[feedback_acceptance_drives_code]] 사용자 가치 → acceptance → 코드
- [[feedback_decision_no_false_binary]] 옵션 3개 이상

## BG agent 위임 지시

- worktree: 격리 필수 (parent 이동 금지)
- 작업: 옵션 A 구현 + `boardingPrompt.test.ts` 신규 케이스 4개 (acceptance) 추가
- 추가 검증: caller consensus 게이트 위치 확인 후 주석에 반영
- 머지 후 worktree 즉시 cleanup
