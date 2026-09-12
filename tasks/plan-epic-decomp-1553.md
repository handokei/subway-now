# Epic #1553 Sub-issue 분해 plan — Backend Trip Position SSoT + 단일 advance 진입점 (ADR-017)

작성일: 2026-06-28
ADR 출처: `docs/decisions/ADR-017-trip-position-ssot.md`
Epic body 출처: `gh issue view 1553`

---

## 1. 현재 상태

### 1.1 머지된 sub-issue (T1~T12, 모두 CLOSED)

| Sub | 이슈 | 내용 | 머지 PR(추정) |
|---|---|---|---|
| T1 | #1554 | `TripPositionSSoT` 스키마 + KV helpers + ADR-017 doc | merged |
| T2 | #1555 | `advanceTripPosition` + 6단 게이트 + seedOverride(E5) + WiFi/train identity | merged |
| T3 | #1556 | Motion state machine (`/position` 수신부) | merged |
| T4 | #1557 | `arvlcdFire` → `advanceTripPosition` 호출로 refactor | merged |
| T5 | #1558 | `advanceBoardingLockWaypoint` → SSoT 통합 | merged |
| T6 | #1559 | `maybeReschedulePush` → SSoT ETA 사용 | merged |
| T7 | #1560 | transferImminent + destinationImminent → SSoT 도달 시만 fire | merged |
| T8 | #1561 | silent push payload `currentStationId` 권위 forward (S2 #1535 흡수) | merged |
| T8b | #1568 | cascade picker `backend-ssot` tier + HomeScreen sticky 격리 + DebugModal SSoT section | merged |
| T9 | #1572 | device fire path SSoT 게이트 — alarm-already-decided + station-already-passed (+ V8e) | merged |
| T10 | #1573 | Sticky SSoT 정책 + trip cleanup + 6h backstop + mirror leak fix (X11) | merged |
| T11 | #1574 | 4-signal underground 합의 (Barometer + Cellular, BG WiFi 갭 해소) | merged |
| T12 | #1575 | NotificationRouter abstraction + surface별 dedup | merged |

### 1.2 acceptance 충족 부분

- 12/12 sub-issue 머지 완료 (foundation T1~T8b + Phase 2 T9~T12)
- **추가 머지된 사이드 sub-issue** (epic 본문 외):
  - #1709 SSoT stale mirror 누수 (#1701 A1-c)
  - #1713 currentStationLine 필드 (#1705 cross-line guard)
  - #1729 paradigm shift Phase 1 (PR #1738) — `maybeBindLocklessTrainCode` 제거 반영

### 1.3 미완 갭 (close 조건 acceptance vs 현재 상태)

Epic 본문 close 조건은 ADR-014 룰 ([[feedback_epic_close_field_verify]]) — "PR 머지 ≠ close. 실기기 1주 재발 0건 OR 1주 production 측정 회귀 0건".

#### Gap A — 1주 production 측정 미수행 (2026-06-24 audit 결과)

본 epic은 #1745 paradigm shift Phase 1+2 검증 epic과 동일 1주 timeline (2026-06-24 → 2026-07-01). 머지된 12 sub-issue가 production에서 다음 acceptance 통과 evidence 미수집:

- N1 정지 trip + lock active + arvlcd → BLOCK (2026-06-19 회귀 재발 0건)
- N2 정지 + lockless + arvlcd → BLOCK
- X8 6h+ 좀비 trip 0건
- X11 `revalidate-waypoint-mismatch` BG 0건
- V8 4 mitigation 실제 작동 (POST /position ≤ 100/10min, POST /trips ≤ 10/10min, lockless 5min skip, cron stationary skip)
- V9 suppress event rate < 100/시간/trip (`gate-hop-window-no-source` 82건/시간 회귀 해소)

#### Gap B — N=5 evidence (2026-06-26 ~ 06-28) cascade 회귀

Day 5 evidence (6/26 4 trip + 6/27 1 trip) 분석 결과, T9~T12 머지 후에도 회귀 잔존:
- #1922 `gate-hop-window` 4-mitigation 누락 — V3/V4 도착 알람 손실
- #1933 cron LA heartbeat self-referential gap — LA 9분 stuck
- #1925 `getLastKnownPositionAsync maxAge` 미적용 — cached lastFix 1h+ stale 노출 (motion 게이트 회귀)
- #1932 `inferEnvironment` SSOT 단일화 부재 — fusion cascade env 변수 비참조 (T11 4-signal 효과 부분 무력화)

위 4건은 Wave 1~3 PR(#1937~#1950)로 머지 완료. acceptance 재측정 필요.

#### Gap C — 측정 인프라 회복 (Day 5 측정 가능성 hard-blocker)

#1928 fix가 측정 인프라 회복 핵심. raw signal forward / accelPattern caller / `/admin/push-ack-stats` safety net 누락은 V8/V9 측정 자체를 불가능하게 만든 root cause.

---

## 2. Sub-issue 후보 목록 (sub-issue 5~10개)

본 epic의 잔여 작업은 "측정 + acceptance close evidence 수집"이 핵심. 신규 코드 작업은 Day 5 회귀 cascade 흡수 후 minimal.

### S-acc-1 (P0) — 1주 production 측정 dashboard 생성
- **목표**: 6 acceptance metric (N1/N2/X8/X11/V8/V9) Cloudflare Dashboard 또는 DebugModal에 실시간 누적
- **acceptance**: 매 trip 종료 시 6 metric 1줄 박제 자동. 1주 누적 0건/0% evidence 자동 산출
- **scope**: backend metric KV 키 6개 추가 + cron rollup. DebugModal "Epic #1553 acceptance" 섹션 신규
- **의존**: Day 5 cascade 머지 완료 (#1928 측정 인프라 회복 필수). #1503 M3 dashboard wire 활용
- **wire 검증**: M3 #1503의 4 metric 라이브 차트 ↔ 본 sub의 6 metric 공통 endpoint 사용
- **acceptance evidence**: 1주 production wrangler tail / Cloudflare Dashboard 캡쳐

### S-acc-2 (P0) — 양방향 시나리오 15건 fixture 통합 테스트
- **목표**: Epic 본문 acceptance P1~P9 + N1~N6 시나리오 fixture 작성 → unit/integration 테스트
- **acceptance**: 15개 시나리오 모두 통과 또는 차단 evidence 자동 산출. CI에 강제
- **scope**: `backend/alarm-worker/src/__tests__/advanceTripPosition.scenario.test.ts` 신규 (~ 15 case)
- **의존**: 머지된 T1~T12 코드 (모두 완료)
- **wire 검증**: 신규 코드 X — 기존 게이트가 모든 case 통과 확인용
- **acceptance evidence**: CI gate에 본 테스트 추가. 회귀 시 즉시 revert

### S-rc-3 (P1) — RC-3 #1884 흡수 cleanup + cellular soft downgrade (#1876) 효과 측정
- **목표**: ADR-015 §12 D+A hybrid (1.1 → 1.6 threshold + station 후보 가드) 효과 1주 측정
- **acceptance**: surface-weak vote 발생 trip에서 `silentPushFired / silentPushReceived ≥ 0.5` (1주)
- **scope**: DebugModal `STATION_ACCEPT_THRESHOLD` + `cellularEnvironmentVote` 노출 + Sentry breadcrumb 추가
- **의존**: #1884 머지 완료. #1876 머지 완료. ADR-015 §12 채택 완료
- **wire 검증**: DebugModal → wrangler tail → Sentry 3 channel evidence
- **acceptance evidence**: 1주 production 측정

### S-fp-4 (P1) — `useStationMismatchDetector` false positive guard 추가 측정
- **목표**: #1951 PR (5 cycle + barometer warmup quorum) 효과 1주 측정
- **acceptance**: `mismatch-detector-trigger` rate가 #1949 (G2 env SSOT) 머지 전 baseline 대비 +50% 이내 유지
- **scope**: DebugModal `mismatch-detector` event counter + 1주 rolling
- **의존**: #1951 머지 완료. G2 #1932 머지 완료
- **wire 검증**: DebugModal → Sentry breadcrumb
- **acceptance evidence**: 1주 측정

### S-rc-5 (P1) — Wave 1~3 PR #1937~#1950 회귀 measurement
- **목표**: Day 5 cascade 11 PR 각각 V/X dashboard 항목 1주 측정
- **scope**: 11 PR 머지 후 1주 동안 회귀 발생 0건 evidence
- **acceptance**:
  - #1925 (lastFix maxAge) — 1h+ stale 위치 노출 0건
  - #1924 (dismissNotification 3곳) — delivered tray 50+ reconcile 0건
  - #1928 (telemetry safety net) — 측정 인프라 silent fail 0건
  - #1931 (APNs env cold start) — BadDeviceToken 5분+ 0건
  - #1933 (cron heartbeat) — LA 5분+ stuck 0건
  - #1922 (gate-hop 4-mitigation) — V3/V4 도착 알람 손실 0건
  - 기타 5건 동일 패턴
- **의존**: 모든 Wave PR 머지 완료
- **acceptance evidence**: 1주 production 측정

### S-arc-6 (P2) — Backend SSoT lockSuggestion forward (ADR-016 cross-cut)
- **목표**: T9b lockSuggestion forward (ADR-016 S1 #1534에 흡수되어 있으나 #1553 close 조건 evidence로 별 측정 필요)
- **acceptance**: lockless trip에서 `SSoT.lockSuggestion` 전달 → device boardingLock 자동 forward 비율 ≥ 70%
- **scope**: DebugModal `lockSuggestion` 채택 비율 표시
- **의존**: ADR-016 S1 머지 완료 (#1534 CLOSED)
- **wire 검증**: device boardingLock controller가 backend SSoT lockSuggestion 채택하는지 grep 검증
- **acceptance evidence**: 1주 production 측정 + ADR-016 #1533 epic close cross-link

### S-batt-7 (P2) — V8 battery 4 mitigation 효과 1주 측정
- **목표**: ADR-017 원칙 8 V8 4 mitigation (a/b/e/f) 효과 측정 (전체 cross-cut)
- **acceptance**: 
  - (a) Adaptive polling: `motion==moving AND speed>1m/s` 둘 다일 때만 fast(30s) → 정지 시 slow(120s) 전환 비율 100%
  - (b) Backend SSoT trust: POST /trips ≤ 10건/10min trip — 5 정체성 변경 사유 외 POST 0건
  - (e) Lockless 5min skip: `tripStartedAt > 5min AND !backendSsotMirror.lockSuggestion` 시 fire path skip 100%
  - (f) Cron stationary skip: silent push 발사 path만 skip, SSoT TTL/motion 갱신은 매분 유지
- **scope**: DebugModal V8 4 mitigation 4 metric + 1주 rolling
- **의존**: T9/T10/T11/T12 머지 완료 (모두 CLOSED)
- **acceptance evidence**: 1주 production 측정 + V8 acceptance 통과 evidence

### S-followup-8 (P2) — ADR-014 의향 trip 동급 보호 audit
- **목표**: 사용자 명시 의향 trip(C 토글 ON / boardingPrompt 응답 / BoardingTrainList 직접 탭)이 lock 활성과 동급으로 6단 게이트 통과하는지 audit
- **acceptance**: `userIntentDeclared=true` trip의 advance rate가 `lock active` trip 대비 ±5% 이내
- **scope**: backend `advanceTripPosition` 게이트별 통과/거부 metric KV + 분포 차트
- **의존**: 모든 T1~T12 머지 완료
- **acceptance evidence**: 1주 production 측정

---

## 3. 우선순위

| 우선순위 | sub-issue | 사유 |
|---|---|---|
| **P0** | S-acc-1 (measurement dashboard) | epic close evidence 자동 산출 prereq. 측정 인프라 없으면 acceptance 1주 evidence 불가 |
| **P0** | S-acc-2 (scenario fixture test) | 신규 회귀 즉시 차단 — CI gate. 머지된 12 sub-issue 정합성 자동 검증 |
| **P1** | S-rc-3 (#1884 #1876 측정) | 직전 cascade 회귀 (T3 stuck 26분 evidence) 재발 차단 |
| **P1** | S-fp-4 (#1951 mismatch false positive) | G2 머지 직후 known risk — 1주 측정 필수 |
| **P1** | S-rc-5 (Wave 1~3 측정) | Day 5 cascade 11 PR 효과 종합 측정 |
| **P2** | S-arc-6 (lockSuggestion forward) | ADR-016 cross-cut close evidence |
| **P2** | S-batt-7 (V8 4 mitigation) | 배터리 acceptance 별도 측정 |
| **P2** | S-followup-8 (의향 trip 동급) | ADR-014 룰 audit (장기) |

---

## 4. Dependency Graph

```
Day 5 cascade 11 PR (Wave 1~3, 모두 머지)
  │
  ├─→ S-acc-1 (measurement dashboard) ─┬─→ S-acc-2 (fixture test)
  │                                    ├─→ S-rc-3 (#1884 #1876 측정)
  │                                    ├─→ S-fp-4 (#1951 측정)
  │                                    ├─→ S-rc-5 (11 PR 측정)
  │                                    ├─→ S-arc-6 (lockSuggestion 측정)
  │                                    └─→ S-batt-7 (V8 측정)
  │
  └─→ S-followup-8 (의향 trip audit) ── 독립
```

**외부 prereq**:
- #1500 M3 dashboard wire (`metric endpoint` + `metric KV` 인프라) — S-acc-1 직접 의존
- #1432 ADR-015 E1~E7 (모두 CLOSED) — fusion 4-signal 효과 측정 prereq
- #1745 paradigm shift Phase 1+2 verify (1주 측정 동시 진행) — S-rc-5 cross-link

**병렬 가능**:
- S-acc-1 + S-acc-2 (서로 독립)
- S-rc-3 / S-fp-4 / S-rc-5 / S-arc-6 / S-batt-7 (S-acc-1 머지 후 동시 spawn)

---

## 5. 즉시 spawn 후보 (의존성 없이 바로 spawn할 수 있는 1~3 sub-issue)

### 추천 1 — S-acc-2 양방향 시나리오 15건 fixture 통합 테스트 (P0)
- **이유**: 의존성 0 (머지된 코드만 사용). 신규 fixture + 테스트 추가만. CI gate에 강제하면 회귀 즉시 revert 가능
- **분량**: ~ 15 test case + 1 fixture file (~300 줄)
- **실기기 verify 불필요**: type+unit only
- **acceptance 즉시 측정 가능**: PR CI 통과 = 머지된 12 sub-issue 정합성 보존 증명

### 추천 2 — S-acc-1 measurement dashboard (P0)
- **이유**: 1주 acceptance evidence 자동 수집 prereq. Day 5 #1928 측정 인프라 회복 완료 — 추가 작업 가능
- **분량**: backend metric KV 6 key + cron rollup + DebugModal section 1개 (~200 줄)
- **의존**: #1928 머지 완료 (Wave 1 PR #1938 — CLOSED 추정)
- **실기기 verify**: 매 trip 종료 시 metric 자동 박제 확인 1회

### 추천 3 — S-fp-4 useStationMismatchDetector false positive 측정 (P1)
- **이유**: #1951 머지 직후 known risk 박제 evidence 빠름 (1주 측정 즉시 시작 가능). false positive 증가 시 즉시 revert 가능
- **분량**: DebugModal counter 1개 + Sentry breadcrumb 1개 (~50 줄)
- **의존**: #1951 머지 완료 / G2 #1932 머지 완료
- **실기기 verify**: 1 trip 후 mismatch event counter 정상 노출 확인

---

## 6. close 조건 매핑 (CLAUDE.md ADR-014 룰)

epic close 조건은 **PR 머지 ≠ close. 실기기 1주 재발 0건 OR 1주 production 측정 회귀 0건**:

| close 조건 | 달성 sub-issue |
|---|---|
| N1~N6 negative 시나리오 BLOCK 0건 | S-acc-2 (fixture test) + S-rc-5 (Wave PR 측정) |
| X1~X11 모두 0건 | S-acc-1 (dashboard) + S-rc-5 |
| V1~V9 임계 충족 | S-acc-1 + S-batt-7 |
| 양방향 시나리오 15건 모두 1주 통과 | S-acc-2 (CI) + S-rc-5 |
| boardingPrompt + autoLock 발사율 정상 (현재 0건 → 정상) | ADR-016 #1533 (cross-cut) + S-arc-6 |

**Epic #1553 close = S-acc-1 + S-acc-2 + S-rc-5 + S-arc-6 1주 evidence 모두 통과**.
