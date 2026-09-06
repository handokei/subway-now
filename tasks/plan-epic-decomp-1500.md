# Epic #1500 Sub-issue 분해 plan — 측정/관찰 인프라 (ADR-015 P5 가중치 학습 prereq)

작성일: 2026-06-28
Epic body 출처: `gh issue view 1500`
연관 ADR: `docs/decisions/ADR-015-multi-signal-consensus-gate.md` §10 P5

---

## 1. 현재 상태

### 1.1 머지된 sub-issue (M1/M2/M3 모두 머지)

| Sub | 이슈 | 내용 | 상태 |
|---|---|---|---|
| M1 | #1501 | ADR-015 P5 raw signal dump 인프라 — 1주 실측 누적 | CLOSED |
| M2 | #1502 | 사용자 trip 정답지 UI — "각 station 정확했어요? Yes/No" prompt 자동 | CLOSED |
| **M3** | **#1503** | **운영 dashboard — 알람 정확성 / silent push 도달률 / lockless miss 실시간 차트** | **OPEN** |

### 1.2 M3 sub-task 진행 상태 (2026-06-24 audit)

M3 #1503은 본문에 3개 sub-task로 분해되어 머지 완료:

| M3 Sub | 이슈 | PR | 상태 |
|---|---|---|---|
| Sub 1 | #1751 차트 라이브러리 + UI | #1754 | 머지 |
| Sub 2 | #1752 backend endpoint + cron | #1759 | 머지 |
| Sub 3 | #1753 device polling + DebugModal section | #1766 | 머지 |

### 1.3 acceptance 충족 부분

기존 머지된 인프라:
- **M1**: `rawSignalBuffer.ts` (device) + `rawSignalDump.ts` (forward) — 1주 dump 1000+ trip 가능 인프라
- **M2**: `useTripGroundTruthStore` + `TripGroundTruthPrompt` — 사용자 정답지 UI 자동
- **M3**: `metrics.ts` + `metrics.catalog.json` (backend) + DebugModal Operation Dashboard 4 metric 라이브

### 1.4 미완 갭 (close 조건 vs 현재)

epic body close 조건 (CLAUDE.md ADR-014 룰):
- M1 raw signal dump **1주 누적 1000+ trip**
- M2 사용자 정답지 응답률 **30%+ 1주 누적**
- M3 DebugModal Operation Dashboard 4 metric 라이브 매 trip 자동 표시 (코드 완료)
- 위 3건 충족 시 P5 가중치 학습 코드 작업 진입 가능 (#1763 Dijkstra epic)

#### Gap A — M3 OPEN 유지 사유

#1503 본문 acceptance:
- DebugModal Operation Dashboard 4 metric 모두 라이브 표시 — **코드 완료** (#1754 + #1759 + #1766 머지)
- metric 1건 → drill-down → 원본 trip raw signal 도달 시연 — **부분 완료** (drill-down UI 구현 필요)
- 매 trip 자동 표시 (manual toggle 없이) — **완료**
- **1주 production 운영 후 회귀 감지 평균 시간 < 30분** (현재 hours) — **미충족** (1주 측정 미수행)

#### Gap B — Day 5 (2026-06-28) 측정 인프라 회복 필요

Day 5 evidence (#1928 fix) — **측정 인프라 silent fail** 발견:
- `triggerTripEndRecall` safety net 2곳 누락 → telemetry forward silent fail
- `accelPattern` caller 누락 → S9 측정 인프라 dead wire
- `/admin/push-ack-stats` try/catch 누락 → cron 실패 시 측정 stop
- → 본 epic #1500 acceptance 측정 자체가 불가능했던 root cause

Wave 1 PR #1938 (#1928) 머지 후 측정 인프라 회복 — 1주 측정 timeline 재시작 prereq.

#### Gap C — M1 raw signal 자동 학습 input 미연결

#1501 머지 완료된 raw signal dump가 **#1763 Dijkstra 가중치 자동 학습 epic의 input**으로 연결 미완. 1주 dump 1000+ trip 누적 후 가중치 학습 시작 가능.

#### Gap D — Sentry breadcrumb forward 양 + 다양성

Day 5 cascade #1912 (RC-19 observability KV day-limit gate + Sentry forward) — 측정 인프라 안정성 보장 PR 머지 완료. 그러나 Sentry breadcrumb 다양성 audit 미수행 (어떤 측정 신호가 누락되는지).

---

## 2. Sub-issue 후보 목록 (5~10개)

본 epic의 잔여 작업은 "1주 측정 evidence 수집 + P5 학습 epic 연결"이 핵심. M3 #1503 close 조건 완성 + M1/M2 1주 측정 evidence 수집.

### S-m3-1 (P0) — M3 drill-down UI 완성
- **목표**: #1503 본문 acceptance — "metric 1건 클릭 → 원본 trip 또는 raw signal log로 drill-down 가능"
- **acceptance**: 4 metric 중 1건 클릭 → 원본 trip dump 또는 raw signal entry 시연
- **scope**: DebugModal Operation Dashboard `onMetricClick` → `TripDetailModal` 신규 (~100 줄)
- **의존**: #1754 + #1759 + #1766 머지 완료 (모두 CLOSED)
- **wire 검증**: metric KV `corrId` ↔ M1 raw signal `corrId` ↔ M2 정답지 `corrId` 일치
- **acceptance evidence**: 1 trip 종료 + drill-down 시연 + DebugModal 캡쳐

### S-m1-meas (P0) — M1 raw signal dump 1주 누적 측정
- **목표**: 1주 production trip dump 1000+ trip 누적 evidence 자동 산출
- **acceptance**: Cloudflare Dashboard 또는 backend `/admin/raw-signal-stats` endpoint 1주 누적 count ≥ 1000
- **scope**: backend metric KV `raw-signal-dump-count` 추가 + cron rollup (~50 줄)
- **의존**: #1501 머지 완료 + #1928 측정 인프라 회복 (Day 5 Wave 1)
- **wire 검증**: `rawSignalDump.ts` forward path → backend storage → metric KV
- **acceptance evidence**: 1주 production wrangler tail 캡쳐

### S-m2-rate (P0) — M2 정답지 응답률 1주 측정
- **목표**: 사용자 정답지 응답률 30%+ 1주 누적 evidence
- **acceptance**: backend `/admin/ground-truth-stats` endpoint 1주 응답률 ≥ 30%
- **scope**: backend metric KV `ground-truth-response-rate` + cron rollup (~50 줄)
- **의존**: #1502 머지 완료 (CLOSED) + #1928 측정 인프라 회복
- **wire 검증**: `useTripGroundTruthStore` → backend POST → metric KV
- **acceptance evidence**: 1주 production 측정 캡쳐

### S-rc19-eff (P0) — RC-19 observability KV day-limit + Sentry forward 효과 1주 측정
- **목표**: #1912 (RC-19 observability KV day-limit gate + Sentry forward) 효과 측정 — 측정 인프라 안정성
- **acceptance**: 1주 production observability KV write count ≤ day-limit 임계 (cost cap)
- **scope**: DebugModal `observability KV write count` + Sentry breadcrumb 추가
- **의존**: #1912 머지 완료
- **wire 검증**: backend `/admin/observability-kv-stats`
- **acceptance evidence**: 1주 production wrangler tail

### S-1928-recover (P0) — Day 5 측정 인프라 회복 effect 측정
- **목표**: #1928 머지 후 측정 인프라 silent fail 0건 evidence
- **acceptance**: 1주 production `telemetry-forward-silent-fail` Sentry event 0건 + `accelPattern` caller 존재 + `/admin/push-ack-stats` cron 실패 시 try/catch 발동 evidence
- **scope**: Sentry breadcrumb 3종 + DebugModal `Day 5 측정 인프라 회복` section (~80 줄)
- **의존**: #1928 #1938 머지 완료 (Wave 1 PR)
- **wire 검증**: 3 safety net path grep + Sentry breadcrumb 발동
- **acceptance evidence**: 1주 Sentry forward 안정성

### S-p5-link (P1) — P5 Dijkstra 가중치 학습 input 연결
- **목표**: #1501 raw signal dump → #1763 Dijkstra 가중치 자동 학습 epic input pipeline 연결
- **acceptance**: 1주 raw signal dump → backend D1 또는 KV `learning-input` row 1000+ 누적
- **scope**: backend cron `rollup-learning-input` (~150 줄)
- **의존**: S-m1-meas 1주 측정 완료 (1000+ trip 누적 evidence)
- **wire 검증**: M1 dump → cron rollup → learning-input row → #1763 consumer
- **acceptance evidence**: 1주 누적 후 학습 input row 1000+ + #1763 epic Sub 1 시작 가능

### S-m2-coverage (P1) — M2 정답지 응답 다양성 audit
- **목표**: 정답지 응답률뿐 아니라 다양성(다양한 trip pattern cover) 측정
- **acceptance**: 1주 정답지 응답 trip 중 지하/지상/환승 카테고리 모두 30%+ cover
- **scope**: backend metric KV `ground-truth-pattern-distribution` (~80 줄)
- **의존**: S-m2-rate 1주 측정 완료
- **acceptance evidence**: 1주 다양성 분포 evidence

### S-sentry-audit (P1) — Sentry breadcrumb 다양성 audit
- **목표**: Day 5 cascade 11 PR 머지 후 Sentry breadcrumb 어떤 측정 신호 누락되는지 audit
- **acceptance**: 1주 Sentry event 카테고리 분포 — 모든 acceptance metric (V1~V9, X1~X11) 1 event 이상 발동 evidence
- **scope**: Sentry tag 카테고리 audit + 누락된 breadcrumb 추가 (~100 줄)
- **의존**: Wave 1~3 머지 완료
- **acceptance evidence**: 1주 Sentry forward 다양성 분포 dashboard

### S-followup (P2) — 회귀 감지 평균 시간 < 30분 evidence
- **목표**: #1503 본문 acceptance — "1주 production 운영 후 회귀 감지 평균 시간 < 30분"
- **acceptance**: 1주 trip dump 종합 분석 + 회귀 감지 latency 측정
- **scope**: backend metric KV `regression-detect-latency` + 사용자 보고 ↔ Sentry forward 시점 매핑 (~150 줄)
- **의존**: 모든 측정 인프라 회복 + 1주 production
- **acceptance evidence**: 1주 회귀 시나리오 시뮬 + 감지 latency 측정

---

## 3. 우선순위

| 우선순위 | sub-issue | 사유 |
|---|---|---|
| **P0** | S-m3-1 (drill-down UI 완성) | #1503 본문 acceptance 직접 미충족 |
| **P0** | S-m1-meas (1주 dump 측정) | epic close 조건 직접 측정 |
| **P0** | S-m2-rate (1주 응답률 측정) | epic close 조건 직접 측정 |
| **P0** | S-1928-recover (측정 인프라 회복) | Day 5 silent fail 회복 evidence 필수 |
| **P0** | S-rc19-eff (observability cost cap) | 측정 인프라 안정성 1주 evidence |
| **P1** | S-p5-link (P5 학습 input 연결) | #1763 epic 시작 prereq |
| **P1** | S-m2-coverage (정답지 다양성) | M2 evidence 품질 |
| **P1** | S-sentry-audit (breadcrumb 다양성) | 측정 누락 차단 |
| **P2** | S-followup (회귀 감지 latency) | 장기 측정 evidence |

---

## 4. Dependency Graph

```
머지 완료된 M1 + M2 + M3 (코드)
  │
  ├─→ S-m3-1 (drill-down UI 완성) ── #1503 close
  │
  ├─→ S-m1-meas (1주 dump 측정) ─┬─→ S-p5-link (P5 input 연결)
  │                              │     │
  ├─→ S-m2-rate (1주 응답률 측정) ─┼─→ S-m2-coverage (다양성)
  │                              │
  ├─→ S-1928-recover (측정 회복) ─┴─→ S-rc19-eff (cost cap)
  │
  ├─→ S-sentry-audit (breadcrumb 다양성)
  │
  └─→ S-followup (회귀 감지 latency)
```

**외부 prereq**:
- #1928 (Wave 1 PR #1938) 머지 완료 — 측정 인프라 회복 base
- #1912 (RC-19 observability KV cost cap) 머지 완료
- #1432 ADR-015 (E1~E7 모두 CLOSED) — 측정 대상 feature 머지 완료
- #1763 Dijkstra 학습 epic — S-p5-link consumer

**병렬 가능**:
- S-m3-1 / S-m1-meas / S-m2-rate / S-1928-recover / S-rc19-eff (모두 독립)

---

## 5. 즉시 spawn 후보 (의존성 없이 바로 spawn할 수 있는 1~3 sub-issue)

### 추천 1 — S-m3-1 (drill-down UI 완성, P0)
- **이유**: #1503 본문 acceptance 직접 미충족. 의존성 0 (모든 prereq 머지). drill-down 1건 시연으로 close 가능
- **분량**: DebugModal `onMetricClick` → `TripDetailModal` (~100 줄)
- **실기기 verify**: 1 trip 종료 + drill-down 시연
- **acceptance 즉시 측정 가능**: PR 머지 시 시연 캡쳐로 close

### 추천 2 — S-1928-recover (Day 5 측정 인프라 회복 evidence, P0)
- **이유**: Wave 1 PR #1938 (#1928) 머지 직후 효과 측정 가능. epic close 조건 중 측정 신뢰성 직접 evidence. 의존성 머지 완료
- **분량**: Sentry breadcrumb 3종 + DebugModal section (~80 줄)
- **실기기 verify**: 1 trip 후 3 safety net Sentry forward 정상 확인
- **acceptance 측정**: 1주 Sentry forward 안정성

### 추천 3 — S-m1-meas + S-m2-rate (1주 측정 metric, P0, 같이 spawn 권장)
- **이유**: epic close 조건 직접 측정 — 1000+ trip dump + 30%+ 응답률. 의존성 0 (코드 머지 완료). 추가 metric KV + cron rollup만 필요
- **분량**: backend metric KV 2개 + cron rollup (~100 줄 통합 가능)
- **실기기 verify**: N/A — backend metric only
- **acceptance 측정**: 1주 production wrangler tail / Cloudflare Dashboard 캡쳐

---

## 6. close 조건 매핑

epic close 조건 (epic body):
- M1 raw signal dump 1주 누적 1000+ trip
- M2 사용자 정답지 응답률 30%+ 1주 누적
- M3 DebugModal Operation Dashboard 4 metric 라이브 매 trip 자동 표시
- 위 3건 충족 시 P5 가중치 학습 코드 작업 진입 가능

| close 조건 | 달성 sub-issue |
|---|---|
| M1 1000+ trip 누적 | S-m1-meas + S-1928-recover (silent fail 차단) |
| M2 응답률 30%+ | S-m2-rate + S-m2-coverage (다양성) |
| M3 drill-down UI 완성 | S-m3-1 |
| 4 metric 라이브 자동 표시 | 이미 머지 완료 (#1754 + #1759 + #1766) |
| P5 학습 코드 진입 | S-p5-link → #1763 Dijkstra epic 트리거 |
| 측정 인프라 회귀 0건 | S-1928-recover + S-rc19-eff + S-sentry-audit |
| 회귀 감지 latency < 30분 | S-followup |

**Epic #1500 close = S-m3-1 + S-m1-meas + S-m2-rate + S-1928-recover + S-rc19-eff 1주 evidence**.
**P5 학습 진입 = S-p5-link 머지 → #1763 epic 시작**.
