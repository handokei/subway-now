# Issue Parallelization Plan

이슈 병렬/직렬화 운영 가이드. 같은 파일을 건드리는 이슈는 직렬 강제, 파일 disjoint한 것만 병렬.

**Why**: 2026-06-11 세션에서 `alarmLog.ts` / `DebugModal.tsx` / `useFusedNearestStation.ts`를 동시에 건드리는 PR을 무작정 병렬화해 머지마다 충돌·duplicate function·SonarCloud CPD가 연쇄 발생함. 이 문서는 그 사고 재발 방지가 목적.

---

## 1. 파일 → 이슈 ownership 표

| 파일/디렉토리 | 잠그는 이슈 (현재 OPEN) | Serial pipeline |
|---|---|---|
| `src/features/alarm/hooks/useStationAlarm.ts` | #1010, #1012, (#918 wiring) | A |
| `src/features/alarm/utils/alarmLog.ts` | #1019 + 후속 monitor/counter | B |
| `src/features/debug/components/DebugModal.tsx` | #1019 (Gates), 후속 섹션 추가 | B (같은 파일이라 B에 묶음) |
| `src/features/nearest-station/hooks/useFusedNearestStation.ts` | #921 통합 단계, 후속 fusion 가드 | C |
| `src/features/alarm/utils/boardingLockScheduler.ts`, `alarmScheduler.ts` | #918 (사전 예약 매역) | D |
| `src/features/route/providers/progress/*` (신규) | #844 (BffProgressProvider) | E (independent — 신규 디렉토리) |
| `src/shared/utils/barometerState.ts`, barometerSubsurface.ts | #875 | F (independent) |
| `src/shared/hooks/useBarometer.ts` (신규 가능성) | #875 | F |
| `src/features/nearest-station/utils/stationDetectionFusion.ts` | #921 신호 fusion (신규) | G (신규 파일은 독립, 단 useFused 통합은 C와 직렬) |
| `backend/alarm-worker/src/**/*.ts` | #837, (#696 entitlement는 클라 config) | H (independent) |
| `.maestro/flows/smoke/` | #1125 (PR #1141), #922 fixture | I (flow 파일 단위 독립) |
| `app.config.js`, `eas.json` | #696 (PR #1144) | J (config only) |
| `scripts/`, `docs/research/` | #753 (PR #1143), #1098/#1091/#1092 (PR 진행) | K (file disjoint, 항상 안전) |

---

## 2. Serial pipeline 정의 (한 번에 1개 in-flight)

### Pipeline A — `useStationAlarm.ts`
머지 순서: **#1010 (PR #1140) → #1012 hydration state machine → #918 wiring (alarmScheduler 연결)**

- #1010 머지 전 #1012 시작 금지
- #918은 #1010+#1012 모두 머지 후 시작 (#918도 useStationAlarm 호출부 추가 필요)
- 빠르게 진행하려면 stacked worktree (#1012 worktree를 #1010 브랜치 기반으로) — 직전 PR CI 대기 없이 진행 가능

### Pipeline B — `alarmLog.ts` + `DebugModal.tsx`
머지 순서: **#1019 (PR #1139) → 후속 alarmLog/DebugModal 변경 이슈**

- 두 파일은 거의 모든 alarm 측정 이슈가 동시에 건드림
- 새 reason/section 추가 이슈는 #1019 머지 후 차례로

### Pipeline C — `useFusedNearestStation.ts`
머지 순서: **현재 #1133(#1025) → 후속 fusion 가드/통합 이슈**

- #1015/#1016/#1025는 이미 닫혔거나 진행 중. 새 fusion 가드 이슈는 #1133 머지 후
- #921 신호 fusion 통합 단계가 이 파일을 건드린다면 C에 합류

### Pipeline D — `alarmScheduler.ts` / `boardingLockScheduler.ts`
- 단일 이슈 (#918) 진행 중이지만 useStationAlarm wiring 필요 → A와 결합 단계 있음
- 단독 작업 가능한 부분 (scheduler 내부 로직)은 A와 독립

---

## 3. Parallel 안전 그룹 (file disjoint)

| Pipeline | 이슈 | 비고 |
|---|---|---|
| E | #844 PR A (BffProgressProvider 신규 디렉토리) | providers/progress/ 신규 |
| F | #875 (Barometer 보조 신호) | barometer hook/state 단계까지 독립. useFused 통합은 C와 직렬 |
| H | #837 (drift telemetry refactor) | backend/alarm-worker only |
| H | (다른 backend 이슈) | client와 무관 |
| I | #922 (E2E fixture, 다른 flow) | #1125와 다른 yaml 파일이면 OK |
| J | #696 (PR #1144 머지 대기) | app.config.js |
| K | #753 (PR #1143), #1098/#1091/#1092 (PR 진행) | docs / scripts |

E, F, H, J, K는 서로 동시 진행 가능. A/B/C/D 중 하나와도 동시 가능.

---

## 4. 사고 신호 (즉시 멈추기)

- 머지 직후 다른 PR이 DIRTY로 줄줄이 전환 = 같은 파일 동시 작업 정황
- 자동 머지 결과 TS `Duplicate identifier` = 양쪽이 같은 함수 추가
- SonarCloud CPD가 같은 위치에서 반복 = 테스트 패턴 N번 복제
- `jest-haste-map duplicate manual mock` = sibling worktree __mocks__ 충돌 (`<rootDir>/.claude/worktrees/` 제외 필요)

위 신호 1개라도 보이면 추가 spawn 멈추고 in-flight 머지 후 진행.

---

## 5. Worktree / Stacked PR 패턴

- 같은 파일을 다음 이슈도 건드린다면 직전 PR 브랜치 기반 worktree 생성 → CI 대기 없이 다음 PR 진행
- 머지 시 dev로 rebase
- 참고: 메모리 `feedback_stacked_pr_worktree.md`

---

## 6. 현재 in-flight 큐 (2026-06-11)

### OPEN PR
- #1133 (#1025 DebugModal sections) — Pipeline C, dev 머지 충돌 해소 진행
- #1139 (#1019 alarmLog gate stamp) — Pipeline B
- #1140 (#1010 station-passed warmup) — Pipeline A 1단
- #1141 (#1125 smoke flake) — Pipeline I
- #1142 (#1061 권한 UI 통일) — independent
- #1143 (#753 Info.plist sync) — Pipeline K
- #1144 (#696 APS entitlement) — Pipeline J

### 다음 큐 (현재 PR 머지 후)
- Pipeline A: #1010 머지 → #1012 hydration state machine 시작
- Pipeline B: #1019 머지 → 후속 alarmLog/DebugModal 이슈
- Pipeline C: #1025 머지 → 후속 fusion 이슈 (#921 통합 단계는 후순위)
- Pipeline E: #844 PR A (즉시 시작 가능)
- Pipeline F: #875 (즉시 시작 가능)
- Pipeline H: #837 (즉시 시작 가능)
- Pipeline I: #922 (즉시 시작 가능, #1125와 다른 flow면)

---

## 7. 운영 규칙 요약

1. **이슈 grab 전 본문 "위치" 섹션 확인** — 어떤 파일 건드릴지 표와 대조
2. **같은 파일 → 같은 pipeline → 1 in-flight만** (또는 stacked worktree)
3. **disjoint → 자유 병렬**
4. **사고 신호 보이면 즉시 멈춤**
5. **머지 후 next-up 큐에서 다음 작업 픽업**
