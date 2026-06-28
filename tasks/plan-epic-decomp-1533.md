# Epic #1533 Sub-issue 분해 plan — 4분면 SSOT 통합 + lockless 첫 station miss 0 (ADR-016)

작성일: 2026-06-28
ADR 출처: `docs/decisions/ADR-016-quadrant-ssot-lockless-first-station.md`
Epic body 출처: `gh issue view 1533`

---

## 1. 현재 상태

### 1.1 머지된 sub-issue (Phase 1 + 재활성화 sub)

| Sub | 이슈 | 내용 | 상태 |
|---|---|---|---|
| S1 | #1534 | Trip 등록 GAP A + instant autoLock + LA Interactive trigger 분리 + **T9b lockSuggestion 흡수** | CLOSED |
| S2 | #1535 | silent push currentStationId + cascade SSOT | CLOSED (ADR-017 T8 #1561 흡수) |
| S3 | #1536 | boardingPrompt + autoLock 9-AND gate 환경 분기 (consensusGate 결합) + **T13 trigger 재설계** | CLOSED |
| S4 | #1537 | Backend realtimePosition 전수 폴링 (autoLock 수렴 가속) | CLOSED |
| **S5** | **#1538** | **Pre-scheduled notification window 확장 + iOS 64 한도 분배** | **OPEN** |
| S6 | #1539 | passedStations 배열 + cron jitter 측정 | CLOSED |
| S7 | #1540 | gps-drop 별 buffer 분리 + subsurface GPS interval + createDebugBuffer O(1) | CLOSED |
| S8 | #1541 | customOrigin 정정 (F4 autoConfirm trip 중 비활성 + SSOT 시 unlock) | CLOSED |
| S9 | #1542 | CMMotionManager accelerometer fingerprint (지하 BG 신호) | CLOSED |
| S10 | #1543 | CTRadioAccessTechnology listener (4분면 1표 추가) | CLOSED |
| **S11** | **#1544** | **App Intents + Focus 자동화 + lockless UI 명시** | **OPEN** |
| S12 | #1545 | Trip cleanup audit 확장 + tripBoundCleanups 누락 8 항목 wiring | CLOSED |
| S13 | #1546 | Sentry DSN 활성 + Xcode Instruments 가이드 (측정 인프라) | CLOSED |
| acceptance | #1526 | autoLock SSOT 출발역 stability 추출 — boardingPrompt 0건 회귀 | CLOSED |

### 1.2 acceptance 충족 부분

- 11/13 sub-issue + acceptance #1526 머지 완료
- 4분면 SSOT 통합 + lockless 재정의 + Wire-completion gate 5단 강제 완료
- T9b lockSuggestion forward (S1 #1534에 흡수) → device boardingLock reader-only 채택 가능

### 1.3 미완 갭

#### Gap A — S5 #1538 (Pre-scheduled notification window 확장) — OPEN

**RCA evidence**: 2026-06-19 트립 2 지하 6역 매역 알림 0건 (청담/뚝섬/구의/어대/군자/중곡). Backend cron 1분 jitter race로 60s 안에 통과한 역 알림 손실.

**현재 코드 위치**:
- `src/features/alarm/utils/boardingLockScheduler.ts:66 DEFAULT_WINDOW_SIZE=10` — 10역만 사전 예약
- `src/features/alarm/utils/tripBoundScheduler.ts:53 TRIPBOUND_WINDOW_SIZE=20` — 20역
- 긴 trip(이수→용마산 14역)에서 trip 후반 station-passed 사전 예약 window 밖
- iOS local notification 한도 64개 — 분배 재계산 필요

**해결 방안** (epic 본문 그대로):
1. `DEFAULT_WINDOW_SIZE` 10 → trip 끝까지 (남은 waypoints 전부)
2. iOS 64 한도 분배 알고리즘 재계산: trip 단계별(상행/환승/하행) 우선순위 + 음소거 toggle 고려
3. 60s race 흡수: pre-scheduled notification로 cron jitter 무관하게 발사

#### Gap B — S11 #1544 (App Intents + Focus 자동화 + lockless UI 명시) — OPEN

**현재 sub 본문**:
1. **App Intents**: 출퇴근 routine 등록 (시간/요일 기반 자동 trip 등록 제안)
2. **Focus 자동화**: 사용자가 Focus 모드 + 출퇴근 routine 결합 가능
3. **Lockless UI 명시**: 현재 lockless 상태(autoLock 미발사)를 UI에 명확 표시
   - "🔍 train 추적 중" badge
   - "탭하여 train 직접 선택" CTA → boardingPrompt 수동 트리거

#### Gap C — 1주 측정 evidence 미수집 (close 조건 acceptance)

epic 본문 close 조건:
- boardingPrompt displayed ≥ 1건/trip (지하 trip 포함)
- responded rate ≥ 30%
- boarded rate ≥ 60% (응답 중)
- 7일 누적 displayed = 0건이면 #1526 close 불가 + revert

paradigm shift 후 (2026-06-24 #1745 evidence) **autoLock 발사 0 / boardingPrompt 발사 정상** 패턴 확인 — 1주 측정 진행 중.

#### Gap D — Day 5 (2026-06-28) cascade 회귀

Wave 1~3 PR이 ADR-016 cross-cut:
- #1921 boardingPromptContext lock 활성 시 lock.boardingLine 우선 — **cross-trip stale stamp 차단** (V/X 직접 evidence)
- #1929 widget tripContext wire 4곳 — RC-15 dead branch 복구
- #1923 infoModeEnabled wire — paradigm shift hard-blocker (P0)
- #1935 silentPushTask widget storage update wire — WhileInUse BG widget 정상화

위 4건은 모두 머지 완료. acceptance 재측정 필요.

---

## 2. Sub-issue 후보 목록 (5~10개)

### S-5ext (P0) — S5 #1538 pre-scheduled window 확장 코드 작업
- **목표**: epic 본문 그대로 — `DEFAULT_WINDOW_SIZE` 10 → trip 끝까지 + iOS 64 한도 분배 재계산 + 60s race 흡수
- **acceptance**: 다음 긴 지하 trip dump에서 trip 끝까지 모든 역 사전 예약 큐 + station-passed 통과율 95%+ + iOS local notification 카운터 64 한도 미초과
- **scope**: `boardingLockScheduler.ts:66` + `tripBoundScheduler.ts:53` 상수 + 분배 알고리즘 (~150 줄)
- **의존**: 병렬 가능 (S1~S4와 독립)
- **wire 검증**: scheduledAlarmReceiver / tripBoundScheduler caller 확인
- **acceptance evidence**: 1 긴 지하 trip 실기기 + DebugModal `scheduledQueue` section

### S-11app (P1) — S11 #1544 App Intents (Phase 3 1차)
- **목표**: App Intents routine 등록 (시간/요일 기반 출퇴근 자동 trip 제안)
- **acceptance**: 사용자 출퇴근 trip 자동 등록률 30%+ (1주 측정)
- **scope**: iOS native AppIntents framework 통합 (~200 줄 native + RN bridge)
- **의존**: 병렬 가능 (모든 sub와 독립)
- **wire 검증**: iOS Shortcuts app에서 routine 노출 확인
- **acceptance evidence**: 1주 production 측정

### S-11focus (P1) — S11 #1544 Focus 자동화 (Phase 3 2차)
- **목표**: Focus 모드 + 출퇴근 routine 결합 — 출근 routine 도착 시 자동 Focus 모드 전환
- **acceptance**: Focus 자동화 사용률 측정
- **scope**: iOS native Focus filter API (~150 줄 native)
- **의존**: S-11app 머지 후 (App Intents prerequisite)
- **wire 검증**: iOS Focus settings → 본 앱 filter 표시
- **acceptance evidence**: 1주 사용률 측정

### S-11ui (P0) — S11 #1544 Lockless UI 명시 (Phase 3 3차)
- **목표**: 사용자가 lockless 상태(autoLock 미발사)를 UI에서 인지 가능 — "train 추적 중" badge + "탭하여 train 직접 선택" CTA
- **acceptance**: lockless UI badge 노출 시 사용자 LA tap 비율 측정
- **scope**: HomeScreen / LiveActivity badge component + boardingPrompt 수동 트리거 wire (~100 줄)
- **의존**: S1 #1534 + S3 #1536 머지 완료 (lockSuggestion forward + trigger 재설계 활용)
- **wire 검증**: HomeScreen badge ↔ boardingPrompt store ↔ LA Interactive
- **acceptance evidence**: 1주 production LA tap 비율 측정

### S-acc-1 (P0) — Wire-completion 5-layer evidence dashboard
- **목표**: ADR-016 §원칙 5 5-layer wire 검증 (#1526 acceptance evidence) 라이브 dashboard
- **acceptance**: 매 trip 종료 시 L1~L5 5단 evidence 자동 표시 — boardingPrompt displayed/responded/boarded count + suppress reason 분포
- **scope**: DebugModal "Epic #1533 Wire" section + backend cron rollup (~150 줄)
- **의존**: S1/S3 머지 완료 + #1526 머지 완료
- **wire 검증**: 5 alarmLog event grep — `boardingPrompt-push-fired` / `boardingPrompt-ui-mounted` / `boardingPrompt-response-posted` 등
- **acceptance evidence**: 1주 production 측정

### S-meas-2 (P0) — 1주 boardingPrompt rate measurement
- **목표**: epic 본문 close 조건 직접 측정 — displayed ≥ 1건/trip, responded rate ≥ 30%, boarded rate ≥ 60%
- **acceptance**: 1주 누적 evidence 자동 산출
- **scope**: backend metric KV `boardingPrompt-stats` + cron rollup (~100 줄)
- **의존**: S-acc-1 머지 후 (dashboard 인프라 활용)
- **wire 검증**: backend `/admin/boarding-prompt-stats` endpoint + DebugModal 표시
- **acceptance evidence**: 1주 production wrangler tail 캡쳐

### S-paradigm-3 (P1) — paradigm shift Phase 1+2 cross-cut measurement
- **목표**: #1745 paradigm shift verify epic과 cross-cut — `autoLock_fired_count = 0` + `boardingPrompt_fired_count > 0` evidence
- **acceptance**: 1주 production 측정 — autoLock 0건 / boardingPrompt > 0건
- **scope**: backend telemetry 추가 + DebugModal (~50 줄)
- **의존**: #1745 epic 측정 timeline (2026-06-24 → 2026-07-01) 동시 진행
- **wire 검증**: Cloudflare Dashboard + wrangler tail
- **acceptance evidence**: 1주 production 측정 + #1745 epic cross-link

### S-day5-4 (P1) — Day 5 cascade ADR-016 cross-cut 측정
- **목표**: Wave 1~3 ADR-016 영향 PR (#1921, #1923, #1929, #1935) 1주 회귀 측정
- **acceptance**:
  - #1921 (boardingPromptContext stale stamp) — cross-trip stamp 회귀 0건
  - #1923 (infoModeEnabled wire) — backend lockless intermediate 진입율 정상 (1 trip 당 1+ 회)
  - #1929 (widget tripContext) — widget RC-15 timestamp staleness 회귀 0건
  - #1935 (silent push widget storage) — WhileInUse BG widget 정상화율 ≥ 90%
- **scope**: 각 PR Sentry breadcrumb + DebugModal counter
- **의존**: Wave 1~3 모두 머지 완료
- **acceptance evidence**: 1주 production 측정

### S-followup-5 (P2) — V8 4 mitigation effect ADR-016 cross-cut
- **목표**: ADR-017 V8 4 mitigation이 ADR-016 boardingPrompt/autoLock 발사율에 미치는 영향 측정
- **acceptance**: V8 mitigation (a/b/e/f) 작동 후에도 boardingPrompt displayed 회귀 0건
- **scope**: cross-cut metric — V8 skip 발동 시 boardingPrompt suppress 여부 추적
- **의존**: ADR-017 epic #1553 1주 측정 evidence
- **acceptance evidence**: 1주 production cross-cut 측정

---

## 3. 우선순위

| 우선순위 | sub-issue | 사유 |
|---|---|---|
| **P0** | S-5ext (S5 #1538 코드) | epic 본문 OPEN sub — 회귀 evidence 직접 (6역 알림 0건) |
| **P0** | S-11ui (lockless UI 명시) | 사용자 인지 부족 직접 해결. LA tap → boardingPrompt 수동 트리거 wire |
| **P0** | S-acc-1 (5-layer wire dashboard) | epic close 조건 evidence 자동 산출 prereq |
| **P0** | S-meas-2 (boardingPrompt rate 측정) | epic close 조건 직접 측정 |
| **P1** | S-11app (App Intents) | UX 강화. 1주 측정 후 가치 평가 |
| **P1** | S-paradigm-3 (paradigm cross-cut) | #1745 epic verify와 동시 진행 |
| **P1** | S-day5-4 (Day 5 cascade 측정) | Wave 1~3 회귀 차단 evidence |
| **P2** | S-11focus (Focus 자동화) | App Intents 머지 후 follow-up |
| **P2** | S-followup-5 (V8 cross-cut) | ADR-017 cross-cut 장기 측정 |

---

## 4. Dependency Graph

```
머지 완료된 11 sub (S1~S4, S6~S10, S12, S13 + #1526)
  │
  ├─→ S-5ext (S5 #1538) ── 독립 ─→ acceptance evidence
  │
  ├─→ S-11ui (lockless UI 명시) ─┬─→ S-11app (App Intents) ─→ S-11focus (Focus)
  │                              └─→ S-acc-1 (5-layer wire) ─→ S-meas-2 (rate 측정)
  │
  ├─→ S-paradigm-3 (paradigm cross-cut) ── #1745 epic cross-cut
  │
  ├─→ S-day5-4 (Day 5 cascade 측정) ── Wave 1~3 머지 완료 prereq
  │
  └─→ S-followup-5 (V8 cross-cut) ── #1553 epic 측정 후
```

**외부 prereq**:
- #1745 paradigm shift verify epic (1주 timeline 동시 진행)
- #1553 ADR-017 epic (V8 4 mitigation 측정 cross-cut)
- #1500 M3 dashboard wire (S-acc-1 / S-meas-2 dashboard 인프라)

**병렬 가능**:
- S-5ext / S-11ui / S-acc-1 (서로 독립)
- S-day5-4 / S-paradigm-3 (서로 독립)

---

## 5. 즉시 spawn 후보 (의존성 없이 바로 spawn할 수 있는 1~3 sub-issue)

### 추천 1 — S-5ext (S5 #1538 pre-scheduled window 확장 코드 작업, P0)
- **이유**: epic 본문 OPEN sub. RCA evidence 직접 (지하 6역 매역 알림 0건). 의존성 0 (병렬 가능). 코드 분량 작음 (~150 줄)
- **분량**: `boardingLockScheduler.ts` + `tripBoundScheduler.ts` 상수 + 분배 알고리즘
- **실기기 verify**: 다음 긴 지하 trip 1회 + DebugModal `scheduledQueue` section 확인
- **acceptance 측정**: 1주 production trip 중 긴 지하 trip 95%+ 통과율

### 추천 2 — S-11ui (Lockless UI 명시, P0)
- **이유**: 의존성 0 (S1/S3 머지 완료). 사용자 인지 직접 해결. UI badge + CTA만 추가 — 분량 작음 (~100 줄)
- **분량**: HomeScreen badge + LA Interactive badge + boardingPrompt 수동 트리거 wire
- **실기기 verify**: 1 lockless trip 시작 시 badge 노출 + 탭 → boardingPrompt 자동 트리거 확인
- **acceptance 측정**: 1주 LA tap 비율 → boardingPrompt 수동 트리거 효과 측정

### 추천 3 — S-acc-1 (5-layer wire evidence dashboard, P0)
- **이유**: epic close 조건 evidence 자동 산출 prereq. #1526 acceptance #1503 M3 dashboard 인프라 활용 가능. 의존성 모두 머지 완료
- **분량**: DebugModal section + backend cron rollup (~150 줄)
- **실기기 verify**: 1 trip 종료 시 5-layer evidence 자동 표시 확인
- **acceptance 측정**: 1주 boardingPrompt rate dashboard evidence 자동 축적

---

## 6. close 조건 매핑

epic close 조건 (epic body):
- boardingPrompt displayed ≥ 1건/trip (지하 trip 포함)
- responded rate ≥ 30%
- boarded rate ≥ 60% (응답 중)
- 7일 누적 displayed = 0건이면 #1526 close 불가 + revert

| close 조건 | 달성 sub-issue |
|---|---|
| S5 RCA 회귀 해결 (지하 6역 알림 0건) | S-5ext |
| S11 lockless UI 명시 → 사용자 인지 회복 | S-11ui |
| 5-layer wire evidence (Wire-completion 강제) | S-acc-1 |
| 1주 displayed/responded/boarded rate 측정 | S-meas-2 |
| paradigm shift cross-cut 정상 동작 | S-paradigm-3 |

**Epic #1533 close = S-5ext + S-11ui + S-acc-1 + S-meas-2 1주 evidence + paradigm cross-cut 정상**.
