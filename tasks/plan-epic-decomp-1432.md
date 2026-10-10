# Epic #1432 Sub-issue 분해 plan — 다중 신호 합의 게이트 + Deterministic Environment SSOT (ADR-015)

작성일: 2026-06-28
ADR 출처: `docs/decisions/ADR-015-multi-signal-consensus-gate.md`
Epic body 출처: `gh issue view 1432`

---

## 1. 현재 상태

### 1.1 머지된 sub-issue (E0~E7 모두 CLOSED + #1884 추가)

| Sub | 이슈 | 내용 | 상태 |
|---|---|---|---|
| E0 | #1433 | ADR-015 본문 + 메모리 박제 (추적용) | CLOSED |
| E1 | #1434 | stations.json `environment` 필드 (CSV 275역 + 위키 253역) | CLOSED |
| E2 | #1435 | `transferTimes.json` 호선쌍별 환승 도보 시간 데이터셋 | CLOSED |
| E3 | #1436 | fusion route-line filter — `findTopNearestStations` allowedLines 확장 (분당선 회귀) | CLOSED |
| E4 | #1437 | interp/sticky/route-hop fire 권한 영구 박탈 | CLOSED |
| E5 | #1438 | backend → device lock release sync 채널 (silent push payload `lockReleasedReason`) | CLOSED |
| E6 | #1439 | backend fire 재설계 — 합의 게이트 + 토글 input 제거 + trainCode lock filter | CLOSED |
| E7 | #1440 | useNearestStation distanceInterval=0 — FG GPS 회복 (#1416 회귀) | CLOSED |
| RC-3 | #1884 | RC-3 env-consensus-fail SSOT gate — weighted vote 4-signal fusion (Option A 채택) | CLOSED |

### 1.2 acceptance 충족 부분

- 9/9 sub-issue 머지 완료 (E0~E7 + RC-3)
- ADR-015 §1~§9 모두 코드 wire 완료
- ADR-015 §12 D+A hybrid (cellular soft downgrade #1876 + weighted vote threshold 1.6) 채택 + 머지
- ADR §11 양방향 layer 추적 룰 모든 sub-issue PR에 강제 적용

### 1.3 미완 갭 (close 조건 vs 현재)

epic body close 조건 (CLAUDE.md ADR-014 룰):
- 조기 발사 0건 — 1주 측정 미수행
- 늦은 도착 알림 0건 — 1주 측정 미수행
- leg 2 침묵 0건 — 1주 측정 미수행
- route 외 line variant fire 0건 — 1주 측정 미수행
- 모든 trip 동등 정확성 — 측정 미수행

#### Gap A — 1주 production 측정 미수행 (2026-06-24 audit)

E0~E7 코드 완료, 1주 field evidence 대기.

#### Gap B — Day 5 (2026-06-28) cascade 잔존 회귀

ADR-015 본문 acceptance에 직접 연관된 Day 5 회귀 4건:

1. **#1922 `gate-hop-window-no-source` 4-mitigation 누락** — V3/V4 도착 알람 회복 (E3 route-line filter 후속)
2. **#1925 `getLastKnownPositionAsync maxAge`** — cached lastFix 1h+ stale (E7 distanceInterval=0 후속)
3. **#1932 `inferEnvironment` SSOT 단일화** — fusion cascade env 변수 비참조 (E1 environment 필드 효과 부분 무력화)
4. **#1934 + #1936 G3/G4 environment vote inject + cascade reorder** — E1 effect 완성 (Epic #1927 G1~G4)

위 4건은 Wave 1~4 PR 머지 완료. 1주 측정 재시작.

#### Gap C — Epic #1927 (fusion env SSOT 다층 paradigm)이 본 epic의 직접 후속

Epic #1927 "fusion environment SSOT 다층 paradigm"는 본 epic #1432 §1 Deterministic Environment SSOT의 직접 후속 작업. G1~G4 (#1930/#1932/#1934/#1936) 모두 머지 완료 → 본 epic의 §1/§3 (deterministic env + GPS reject underground) 완성도 +1.

#### Gap D — §12 surface-weak threshold 1.6 효과 1주 측정 미수행

ADR-015 §12 D+A hybrid (cellular soft downgrade + weighted vote threshold 1.6) 채택 후 1주 측정 미수행:
- `silentPushFired / silentPushReceived` ratio surface-weak 환경에서 ≥ 0.5 유지
- T3 stuck (lockless 지하 충정로→용마산) 재발 0건

#### Gap E — Followup 5개 후보 미결정 (epic body)

ADR-015 본문 Followup 5개 후보가 본 epic 측정 종료 시점에 결정 대기:
- 사용자 정지/하차 시 lock 자동 release 게이트
- 전 신호 침묵 시 backend route + lock + 마지막 fix 시각 기반 ETA prompt fallback
- traincode TTL 동적 갱신 (별 트랙 B2)
- WiFi SSID 데이터셋 (별 트랙 B3)
- BG WiFi SSID 권한 정책 (Location Always 권한 vs device→backend SSID push)

---

## 2. Sub-issue 후보 목록 (5~10개)

본 epic의 잔여 작업은 "1주 field evidence 수집 + Followup 후보 결정 + #1927 G epic cross-cut 측정"이 핵심.

### S-meas-1 (P0) — ADR-015 4 acceptance 1주 production 측정 dashboard
- **목표**: epic body close 조건 5개 자동 산출 — 조기 발사 / 늦은 도착 / leg 2 침묵 / route 외 line variant / 동등 정확성
- **acceptance**: 1주 production 측정 dashboard 4 metric (조기 발사 0건 / 늦은 도착 0건 / leg 2 침묵 0건 / route 외 fire 0건) 자동 노출
- **scope**: backend metric KV 4 키 + cron rollup + DebugModal "Epic #1432 acceptance" section (~150 줄)
- **의존**: Day 5 cascade 머지 완료 (Wave 1~4)
- **wire 검증**: M3 #1503 dashboard 인프라 활용
- **acceptance evidence**: 1주 production Cloudflare Dashboard 캡쳐

### S-meas-2 (P0) — §12 surface-weak threshold 1.6 효과 1주 측정
- **목표**: D+A hybrid (cellular soft downgrade + threshold 1.6) 효과 측정
- **acceptance**:
  - surface-weak 환경에서 `silentPushFired / silentPushReceived ≥ 0.5`
  - T3 lockless 지하 stuck 재발 0건
  - positional+motion+time 1.7 accept rate 정상 분포
- **scope**: DebugModal `STATION_ACCEPT_THRESHOLD` 노출 + Sentry breadcrumb `fusion.surface-weak.accept-reject` (~80 줄)
- **의존**: #1876 + #1884 + #1906 (#1884 PR) 모두 머지 완료
- **wire 검증**: weightedVoteFusion path → DebugModal → Sentry
- **acceptance evidence**: 1주 production 측정

### S-1927-cross (P0) — Epic #1927 G epic 1주 cross-cut 측정
- **목표**: G1~G4 (env SSOT 다층 paradigm) 머지 후 본 epic §1/§3 완성도 측정
- **acceptance**:
  - V7 지하 dominant trip (4호선/5호선/6호선) station-passed advance ≥ 90%
  - X10 fusion picker output.line ≠ candidates input.line 0건
- **scope**: DebugModal `fusionTierAdopted` + cascade tier 분포 dashboard + Sentry `fusion.tier_adopted` (~100 줄)
- **의존**: G4 #1936 머지 완료 (Wave 4)
- **wire 검증**: cascade picker → DebugModal → Sentry
- **acceptance evidence**: 1주 지하 dominant trip 분포

### S-day5-3 (P1) — Day 5 cascade ADR-015 cross-cut 측정
- **목표**: Wave 1~4 ADR-015 cross-cut PR (#1922, #1925, #1932) 1주 회귀 측정
- **acceptance**:
  - #1922 `gate-hop-window-no-source` 4-mitigation — suppress reason 분포 정상
  - #1925 `getLastKnownPositionAsync maxAge` — 1h+ stale 노출 0건
  - #1932 `inferEnvironment` SSOT 단일화 — 환경 라벨 두 곳 이상 산출 0건
- **scope**: 각 PR Sentry breadcrumb + DebugModal counter (~100 줄)
- **의존**: Wave 1~4 모두 머지 완료
- **acceptance evidence**: 1주 production 측정

### S-gold-fixture (P1) — Gold standard 5건 trip-ground-truth fixture 작성
- **목표**: 사용자 직접 trip annotation 5건 → unit test fixture로 cascade 결정 시뮬 통과
- **acceptance**: G3+G4 unit test에서 5 fixture 모두 cascade 정상 분기 통과
- **scope**: 5 trip annotation JSON + unit test (~200 줄)
- **의존**: G4 #1936 머지 완료. 사용자 trip 5건 실기기 수집 필요
- **wire 검증**: 5 fixture × 11-tier 매트릭스 unit test
- **acceptance evidence**: CI gate 추가 + revert 자동

### S-followup-1 (P1) — Followup 후보 1: 사용자 정지/하차 시 lock 자동 release 게이트
- **목표**: boardingLock BG 카탈로그 case #9 "잃어버리는 케이스" 미커버 항목 cover
- **acceptance**: 정지 5분+ 시 lock 자동 release + 사용자 명시 의향 trip 재구성 시 즉시 lock 회복
- **scope**: `backend/alarm-worker/src/scheduled.ts` lock release 분기 (~80 줄)
- **의존**: 본 epic 1주 측정 완료 후 결정
- **acceptance evidence**: 1주 추가 측정

### S-followup-2 (P2) — Followup 후보 2: 전 신호 침묵 시 ETA prompt fallback
- **목표**: 모든 신호 동시 침묵 (지하 dead-zone + arrival fetch fail + WiFi 미인식 + 기압계 미준비) 시 backend route + lock + 마지막 fix 시각 기반 ETA prompt
- **acceptance**: 사용자 정정 — "안 되는 것 #15" 즉, 전 신호 침묵 trip에서 사용자가 도착 못 알아내는 케이스 0건
- **scope**: backend `silent` path 추가 + device fallback UI (~150 줄)
- **의존**: 본 epic + #1553 1주 측정 완료 후 결정

### S-followup-3 (P2) — Followup 후보 3: traincode TTL 동적 갱신
- **목표**: 별 트랙 B2와 통합 — traincode TTL이 운행 패턴에 따라 자동 갱신
- **acceptance**: traincode 갱신 latency < 30s + 잘못된 traincode 채택 0건
- **scope**: backend traincode TTL adaptive (~100 줄)
- **의존**: 본 epic 1주 측정 + 별 트랙 B2 결정

### S-followup-4 (P2) — Followup 후보 4 + 5: WiFi SSID 데이터셋 + BG 권한 정책
- **목표**: 별 트랙 B3/B4와 통합 — WiFi SSID 데이터셋 + BG WiFi SSID 권한 정책 (Always vs WhileInUse)
- **acceptance**: BG WiFi SSID evidence forward path 1주 측정 0건/Always trip = WhileInUse trip 동등 정확성
- **scope**: 별 트랙 B3 + B4 통합 (~200 줄)
- **의존**: B3/B4 별 결정 + 본 epic 1주 측정

---

## 3. 우선순위

| 우선순위 | sub-issue | 사유 |
|---|---|---|
| **P0** | S-meas-1 (4 acceptance 측정 dashboard) | epic close 조건 직접 측정 |
| **P0** | S-meas-2 (§12 threshold 1.6 측정) | 직전 채택 ADR §12 1주 evidence |
| **P0** | S-1927-cross (G epic cross-cut 측정) | env SSOT 다층 paradigm 효과 |
| **P1** | S-day5-3 (Day 5 cross-cut 측정) | Wave 1~4 회귀 차단 evidence |
| **P1** | S-gold-fixture (5건 fixture) | CI gate 자동 회귀 차단 |
| **P1** | S-followup-1 (lock 자동 release) | 본 epic Followup 1번 (close 조건 검토 시) |
| **P2** | S-followup-2 (ETA prompt fallback) | 본 epic Followup 2번 |
| **P2** | S-followup-3 (traincode TTL) | 별 트랙 B2 통합 |
| **P2** | S-followup-4 (WiFi SSID 데이터셋 + BG 권한) | 별 트랙 B3/B4 통합 |

---

## 4. Dependency Graph

```
머지 완료된 E0~E7 + RC-3 (#1884)
  │
  ├─→ S-meas-1 (4 acceptance dashboard) ──┐
  ├─→ S-meas-2 (§12 threshold 1.6) ───────┤
  ├─→ S-1927-cross (G epic cross-cut) ────┼─→ 1주 측정 → epic close 결정
  ├─→ S-day5-3 (Wave 1~4 cross-cut) ──────┤
  └─→ S-gold-fixture (5건 fixture) ───────┘
                  │
                  └─→ S-followup-1 (lock 자동 release)
                       │
                       ├─→ S-followup-2 (ETA prompt fallback)
                       ├─→ S-followup-3 (traincode TTL)
                       └─→ S-followup-4 (WiFi SSID + BG 권한)
```

**외부 prereq**:
- Epic #1927 G1~G4 머지 완료 (G4 #1936 Wave 4)
- Day 5 cascade Wave 1~4 모두 머지
- #1500 M3 dashboard 인프라 활용
- #1745 paradigm shift verify epic (1주 timeline 동시 진행)
- 별 트랙 B2/B3/B4 (Followup 후보 prerequisite)

**병렬 가능**:
- S-meas-1 / S-meas-2 / S-1927-cross / S-day5-3 / S-gold-fixture (5개 모두 독립)

---

## 5. 즉시 spawn 후보 (의존성 없이 바로 spawn할 수 있는 1~3 sub-issue)

### 추천 1 — S-meas-1 (4 acceptance 측정 dashboard, P0)
- **이유**: epic close 조건 직접 측정. 의존성 0 (코드 모두 머지). M3 dashboard 인프라 활용 가능
- **분량**: backend metric KV 4 키 + cron rollup + DebugModal section (~150 줄)
- **실기기 verify**: 1 trip 종료 시 4 metric 자동 표시 확인
- **acceptance 측정**: 1주 production Cloudflare Dashboard 자동 축적

### 추천 2 — S-1927-cross (G epic cross-cut 측정, P0)
- **이유**: G4 #1936 Wave 4 머지 직후 효과 측정. V7 + X10 직접 acceptance evidence. 의존성 머지 완료
- **분량**: DebugModal `fusionTierAdopted` + Sentry breadcrumb (~100 줄)
- **실기기 verify**: 1 지하 dominant trip 후 cascade tier 분포 확인
- **acceptance 측정**: 1주 지하 dominant trip evidence

### 추천 3 — S-gold-fixture (5건 fixture 작성, P1)
- **이유**: CI gate 자동 회귀 차단. 사용자 trip 5건 수집 + fixture 작성 + unit test. 의존성 0 (G4 머지 완료)
- **분량**: 5 trip annotation JSON + unit test (~200 줄)
- **실기기 verify**: 사용자 직접 trip annotation 5건 수집 필요 (1~2 days)
- **acceptance 측정**: CI gate에 본 fixture 강제 → 회귀 자동 revert

---

## 6. close 조건 매핑

epic close 조건 (epic body):
- 조기 발사 0건
- 늦은 도착 알림 0건
- leg 2 침묵 0건
- route 외 line variant fire 0건
- 모든 trip 동등 정확성 (lockless toggle ON/OFF, boardingPrompt 응답/무응답, lock 활성/비활성 trip 모두 같은 정확성 기준 충족)

| close 조건 | 달성 sub-issue |
|---|---|
| 조기 발사 0건 | S-meas-1 (측정) + S-1927-cross (env SSOT cascade reorder 효과) |
| 늦은 도착 알림 0건 | S-meas-1 + S-day5-3 (#1922 4-mitigation) |
| leg 2 침묵 0건 | S-meas-1 + E5 lockReleasedReason (이미 머지) |
| route 외 line variant fire 0건 | S-meas-1 + E3 route-line filter (이미 머지) + S-gold-fixture |
| 모든 trip 동등 정확성 | S-meas-1 + S-1927-cross + S-meas-2 (§12 threshold 1.6) |
| Followup 5 후보 결정 | S-followup-1~4 (장기) |

**Epic #1432 close = S-meas-1 + S-meas-2 + S-1927-cross + S-day5-3 + S-gold-fixture 1주 evidence**.
**Followup 후보 5개는 본 epic close 후 별 epic 또는 별 트랙으로 진행**.
