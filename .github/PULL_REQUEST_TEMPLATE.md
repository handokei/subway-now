<!--
Wire-completion 5단 룰 (#1582)
"코드만 머지되고 wire가 안 끊긴 신호" 회귀를 차단한다.
모든 항목을 채워야 머지 가능. N/A는 사유 명시 (예: "리팩터링 only, signal 변경 없음").
-->

## Summary

<!-- 변경 의도 1~3줄 -->

Closes #<이슈번호>

---

## Wire-completion 5단 체크

- [ ] **1. Orphan 없음** — `npm run lint:orphan` pass (CI 자동 검증). 신규 export에는 caller 존재.
  - push/silent-push 계열 관측 지표를 새로 추가하거나 그 emitter를 은퇴시키는 PR은
    `src/features/observability/utils/signalProvenanceRegistry.ts`도 함께 갱신 (#2250, ADR-029 Phase 3).
    `findDewiredSignals.test.ts`가 registry의 emitterSymbol이 비-테스트 코드에서 실제 호출되는지
    검증한다 — 호출자 없는 항목은 CI red ("de-wire").
- [ ] **2. V/X dashboard** — DebugModal/wrangler tail/SSoT 어디서 시각화/관측 가능한지 명시.
- [ ] **3. 의존 PR** — 이 PR이 작동하려면 머지 필요한 backend/device/infra PR 번호. 없으면 "N/A".
- [ ] **4. 측정 plan** — 회귀 신호를 1주 안에 어떻게 측정할지(시나리오 / log query / 사용자 trip 캡처).
- [ ] **5. Device verify** — 실기기 검증 필요 여부. 필요 시 사용자 trip 시나리오 명시. 코드-only면 "N/A — type+unit only".

### V/X dashboard URL

<!-- 예: DebugModal "Backend SSoT" 섹션 / wrangler tail / Cloudflare Dashboard logs / Sentry issue link -->

### 의존 PR

<!-- 예: #1500 (backend), #1571 (device wiring). 없으면 N/A. -->

---

## 계약 변경 체크리스트 (push kind 추가/은퇴 시 — ADR-029 Phase 4 / #2252)

<!--
`src/shared/types/pushContract.ts`의 kind union(STATION_WAYPOINT_KINDS/CONTROL_PUSH_KINDS/
ALARM_EVENT_TYPES/SLEEP_ALARM_TARGET_KINDS 등)을 추가·은퇴하는 PR만 해당. 그 외는 "N/A".
CI가 이 파일 변경 시 리마인더 코멘트를 자동 게시한다(hard-block 아님).
-->

- [ ] SSoT(`pushContract.ts`) 갱신 — exhaustive switch/assertNever 컴파일 통과 확인
- [ ] 경계 검증(ADR-029 Phase 1) 갱신 — zod refinement 등 런타임 검증 스키마 동기화
- [ ] de-wire registry(ADR-029 Phase 3, `signalProvenanceRegistry.ts`) 등재/은퇴 반영
- [ ] 테스트 동반(신규 kind 처리 경로 / 은퇴 kind 소비 제거)

---

## Test plan

- [ ] `npm test` 100% coverage pass
- [ ] `npm run type-check` pass
- [ ] `npm run lint:orphan` pass
- [ ] <시나리오 1>
- [ ] <시나리오 2>
