# Lessons — subway-now

세션마다 같은 실수를 반복하지 않기 위한 영구 룰. 글로벌 CLAUDE.md §6 "Self-Improvement Loop"가 가리키는 파일.

형식: `- [실수 내용] → [방지 룰]` (한 줄 우선) 또는 한 블록 (메커니즘 + 룰 + 출처).

---

## 결정 / acceptance 정의

### L1 — 옵션 제시 시 false binary 금지 (2026-06-11 사고)
사용자 가치 결정 옵션을 "강제 적용 vs 완전 면제"로 제시 → 사용자가 면제 선택 → ADR 첫 줄 원칙 위반.
→ **결정 옵션 최소 3개 보장.** "정확성 게이트 보강 (신규 작업 필요)" 같은 제3의 옵션을 현재 코드에 없어도 결정 테이블에 반드시 포함.
- 출처: `memory/feedback_decision_no_false_binary.md`, `memory/lesson_2026_06_11_b3_false_binary.md`
- 점검: B1~BN 같은 일괄 결정 PR 머지 전 "사용자가 한쪽 극단 선택 시 ADR 첫 줄 원칙 위반?" 자가 점검

### L2 — Epic close는 PR 머지로 충분하지 않음 (2026-06-11 사고)
Epic #896 close 기준이 "Seam A~G 7개 PR 머지". 본문 evidence(`13:19~14:01 KST 용마산→성수→환승 건대입구→용마산`)가 acceptance에 없어 다음 날 사용자 trip 재발.
→ **Epic close 조건에 본문 evidence 시나리오 실기기 재발 0건 또는 1주 측정 필수.** PR 머지는 진행 척도일 뿐 close 기준 아님.
- 출처: `memory/feedback_epic_close_field_verify.md`
- 점검: close PR 머지 직전 "epic 본문 evidence가 acceptance에 1:1 매핑되는가?" 자가 점검

### L3 — Acceptance가 코드를 정의, 코드가 acceptance를 정의 X (2026-06-11 사고)
Epic #1008 §7.1 회귀 7개 정의를 "Epic A에서 머지된 sub-issue 본문" 기준으로 설정 → lockless over-fire 회귀가 정의에 안 들어감 → 사용자 trip lockless라 0건 매칭.
→ **사용자 가치 기준으로 acceptance 먼저 정의 → 그 acceptance가 어느 작업이 필요한지 sub-issue로 발행.** "이미 머지된 sub-issue"는 진행 척도일 뿐.
- 출처: `memory/feedback_acceptance_drives_code.md`
- 점검: 회귀/acceptance 정의 시 "lock 활성 / lockless 둘 다 카테고리에 들어 있는가?" + "권한 매트릭스 / 환경 매트릭스 모두 커버?" 자가 점검

### L4 — 사용자 명시 의향 trip은 lock 활성과 동급 보장 (ADR-010 첫 줄 출처)
ADR-013 B1에서 C 토글을 "정보 표시용"으로 격하 → 정확성 게이트 의무 없음 → 사용자가 토글 ON으로 켠 trip에서 잘못된 역 알람.
→ **C 토글 ON / boardingPrompt 응답 / BoardingTrainList 직접 탭 = 사용자 명시 의향 = lock 활성과 동급 정확도 보장 의무.** "정보용" 라벨은 UI 텍스트로만, acceptance/게이트는 동급.
- 출처: `memory/feedback_user_intent_equal_protection.md`, `docs/decisions/ADR-010-sensor-fusion-policy.md` 첫 줄
- ADR-010 첫 줄 인용: "두 실패 모드(false positive / miss)는 비대칭이 아니라 **동급**."

---

## BG agent / worktree

### L5 — 동시 BG agent는 isolation:worktree 필수
공유 working tree에서 stash race 사고. → `Agent` 호출 시 `isolation: "worktree"` 명시.
- 출처: `memory/feedback_bg_agents_need_isolation.md`

### L6 — 격리 worktree "37 fail"은 거짓 신호
메인 dev는 PASS. CI 영향 없음. → BG agent 보고 그대로 신뢰 X, 메인에서 재확인.
- 출처: `memory/lesson_worktree_test_env_drift.md`

---

## PR / 머지

### L7 — PR 머지는 사용자 전담
ALL GREEN 도달 보고만, `gh pr merge` 호출 절대 금지.
- 출처: `memory/feedback_auto_merge_all_green.md`

### L8 — SonarCloud dup 작성 시점 사전 차단
`it.each` + factory + setup wrapper 적용. 6+ 반복 시그니처 → wrapper 필수.
- 출처: `memory/lesson_sonarcloud_dup_prevention.md`

### L9 — 같은 파일 건드리는 이슈는 직렬, file-disjoint만 병렬
locale JSON, alarmLog.ts, useStationAlarm.ts 등 hotspot은 stacked PR worktree 사용.
- 출처: `memory/feedback_serial_parallel_grouping.md`, `memory/lesson_locale_json_hotspot.md`

---

## 진단 / 검증

### L10 — 런타임 가정 30초 검증
"X에 가드 박으면 됨" 플랜 전에 그 X가 표적 상황(FG/BG 등)에서 실제 호출되는지 30초 확인.
- 출처: `memory/lesson_verify_runtime_assumptions.md`

### L11 — 이슈 상태 메모리 기반 추천 금지
"다음 작업 X"라고 말하기 전 `gh issue view` 1번. 메모리 큐는 stale 가능.
- 출처: `memory/lesson_verify_issue_state.md`

### L12 — SonarCloud 실패 원인 직접 확인
PR 코멘트 + issues API로 인증 없이 즉시 가능. 추측 금지.
- 출처: `memory/lesson_sonarcloud_direct_check.md`

---

## 회귀 추적

### L13 — wrangler tail/KV로 backend 직접 진단 가능
cached OAuth로 즉시 가능. tail은 1-2 cron 사이클로 lockMissing/etaMissing 식별.
- 출처: `memory/lesson_wrangler_direct_diagnostics.md`

### L14 — wrangler tail wrapper 신뢰성 부족
자동 재시작 ≠ 데이터 수신. "계속 체크" 약속은 inactivity gate + 능동 알림 같이 설계.
- 출처: `memory/lesson_wrangler_tail_wrapper_reliability.md`

### L15 — Expo prebuilt native config drift
app.config.js의 ios.infoPlist 변경 시 expo prebuild 안 돌리면 ios/ 캐시 stale, 실기기 splash 후 크래시. 자동 게이트 못 막음.
- 출처: `memory/lesson_expo_native_config_drift.md`

---

## 자기 점검 루틴 (세션 시작 시)

1. 본 파일 읽고 적용 가능한 룰 식별
2. 결정 PR 작성 시 L1~L4 자가 점검 통과
3. BG agent 띄울 때 L5 적용
4. PR 머지 보고 시 L7 준수
5. 회귀 / acceptance 정의 시 L3 + L4 자가 점검 통과
