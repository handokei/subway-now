---
issue: 1008
title: "epic: 위치 서비스 재정의 + Lockless Over-Fire Guard (Stage 4 통합) — SSOT"
created: 2026-06-11
status: in-progress (Epic A 16/17)
related:
  - "#912"
  - "#874"
  - "#844" # closed — 잔여 범위 Epic C 풀 귀속
  - tasks/issue-parallelization-plan.md
---

# Epic #1008 SSOT — 위치 서비스 재정의 + Lockless Over-Fire Guard

> **문서 성격**: epic #1008 본문이 가리키던 원본 SSOT(472줄)는 git 히스토리/로컬 어디에도 생성된 적이 없음이 2026-06-11 확인됨 (dangling reference).
> 본 문서는 그 시점의 **GitHub 상태(epic 본문 + sub-issue 17건 + dev 머지 이력 + 트리아지 결과)를 기준으로 재구성한 SSOT**다.
> 이후 epic 관련 결정·진행 상태 변경은 본 파일에 반영한다. issue 본문은 요약, 본 파일이 상세.

---

## 1. 배경

2026-06-06 ~ 2026-06-07 실기기 검증에서 다수 회귀 동시 발견. 1차 epic #912가 "발사 누락"을 잡았다면 본 epic은 **"잘못 발사"와 "발사해야 하는데 못 도달"** 양방향 + 앱 근본 방향성 재정의.

### 4 Root Cause

| RC | 내용 | 해소 sub-issue | 상태 |
| --- | --- | --- | --- |
| RC1 | backend `attemptAutoLock`이 arvlCd=2(출발) at next-waypoint 채택 → origin을 이미 지난 열차 가능 | #1018 (confidence gate) | ✅ 머지 |
| RC2 | client `hydrateLockFromCandidate` 무검증 | #1014 (acceptance gate) | ✅ 머지 |
| RC3 | `positionTrainResult` 거리 게이트 3 hole (userLocation=null placeholder / accuracy>200m bypass / line-only check) | #1015 (forward-only verification), #1016 (3 hole 봉합) | ✅ 머지 |
| RC4 | `trackTrainProgress` forward-only 가드 없음 | #1017 | ✅ 머지 |

## 2. 6 근본 방향성 (D1~D6)

- **D1** 지하+지상 끊김 없이
- **D2** 매역 알림 (FG + BG)
- **D3** 환승 1정거장 전 + trip-start 1정거장 이내 skip
- **D4** 정확한 위치 어디서든
- **D5** "사용하는 동안" 권한에서 동일 작동 — *주: #494 Geofence 폐기 결정(PR #1154, `docs/research/494-geofence-bg-rejection.md`)의 근거이기도 함*
- **D6** 차별점 = 알람 UX

전제: 자동화의 경계는 **경로(목적지) 설정 이후** — trip이 활성인 동안 사용자 추가 개입 없이 동작해야 한다는 의미이며, 경로 미설정 상태의 자동 동작을 뜻하지 않는다.

## 3. Epic 구조와 현재 상태 (총 12~14주, buffer 포함 16~19주)

### Epic A (Week 1~2) — 회귀 #1/#2/#7 — **16/17 완료 (잔여 H5 #1012)**

| Codename | Issue | 제목 | 상태 |
| --- | --- | --- | --- |
| H1 | #1009 | DebugModal BoardingLock + Estimator State + Gates 섹션 | ✅ (PR #1133, 2026-06-11) |
| H2' | #1010 | station-passed effect firedHydrated + warmup 가드 | ✅ |
| H3' | #1011 | lastNotifiedStationId destination scoping | ✅ |
| H5 | #1012 | hydration state machine | 🔄 진행 중 |
| H6 | #1013 | motion warmup window + positionStability 60s fallback | ✅ |
| H7-new | #1014 | hydrateLockFromCandidate acceptance gate (RC2) | ✅ |
| H8-new | #1015 | fusion forward-only verification (RC3) | ✅ |
| H9-new | #1016 | positionTrainResult 거리 게이트 3 hole 봉합 (RC3) | ✅ |
| H10-new | #1017 | trackTrainProgress forward-only 가드 (RC4) | ✅ |
| B4-new | #1018 | backend attemptAutoLock confidence gate (RC1 + R-6 monitor) | ✅ |
| M1 | #1019 | alarmLog phase/motion gate stamp | ✅ |
| M4 | #1020 | #580 race detection stamp | ✅ |
| M7-new | #1021 | boardingPrompt 발사 빈도 monitor (R-6) | ✅ |
| M8-new | #1022 | Cloudflare Worker quota dashboard (R-8) | ✅ |
| DL-B | #1023 | alarmLog dedup window 5 reason 확장 | ✅ |
| DL-H | #1024 | burst inline counter + DebugModal ## Counters | ✅ |
| — | #1025 | (H1 중복 — #1009의 duplicate로 close) | ✖ dup |

### Epic C 단기 (Week 3, 16 sub-issue 예정) — 회귀 #3/#4 — **미발행**

Lock backend SSOT + GPS 격하 + 토글 폐기. **착수 전 결정 선행: B1(ADR-010), B2(#874 통합), B3(#912 acceptance 재해석).**
sub-issue 상세는 발행 시 본 문서에 기입한다. (원본 SSOT 부재로 16건의 사전 정의는 유실 — 결정 후 재정의 필요)

### Epic B (Week 4~9, 9 sub-issue 예정) — 회귀 #5/#6 — **미발행**

race/storage/lockless 근본 refactor. Epic C 단기 완료 후 착수.

### Epic C 풀 (Week 10~14, 5 sub-issue 예정) — D1/D5 완성 — **미발행**

ADR-008 Stage 4 Phase A+B 통합. **B2 결정(2026-06-11)으로 #844 잔여 PR B/C/D가 본 단계 sub 5건 중 3건으로 귀속 확정 — #844 close됨.** sub-issue 발행 시 #844 본문의 PR B/C/D 정의 + open questions 참조.

## 4. 결정 차단 항목 (본인 결정 필요 — 전부 미결)

> ⚠️ **데드라인**: Epic A 16/17. B2는 결정 완료 — Epic C 단기는 잔여 B1/B3 없이 시작 불가.

- [ ] **B1**: ADR-010 C 폐기 + D 신설
- [x] **B2**: epic #874를 본 epic에 통합 — **2026-06-11 결정 완료** (`project_2026_06_11_epic1008_b_decisions.md`). #844 잔여 PR B/C/D → Epic C 풀 sub 3건 귀속, #844 close
- [ ] **B3**: #912 acceptance 재해석 — "lock 유무 무관 trip 활성이면 매역 발사" (#912 본문에 2026-06-11 임시 반영: 오발사 0건 판정은 본 epic 회귀 측정을 따름)
- [ ] **B4**: 낙관적 UI (탭 즉시 visual + backend 정정 toast)
- [ ] **B5**: backend optional 먼저 → 1주 → client → required 승격
- [ ] **B14**: 추가 발견 대응 — 옵션 3 (A 카테고리 흡수 / B follow-up / C 별 epic)

## 5. 리스크 ↔ 대응 매핑 (R-1 ~ R-10)

| 리스크 | 내용 | 대응 | 상태 |
| --- | --- | --- | --- |
| R-1 | backend false positive 직격 노출 | Epic A prerequisite (RC1~RC4 게이트) | ✅ Epic A로 해소 중 |
| R-2/R-9 | backend down | Phase A pull fallback | Epic C 풀에서 |
| R-3 | lock 탭 round-trip 500ms | 낙관적 UI (B4) | B4 결정 대기 |
| R-4 | ADR-010 정책 변경 | 본인 권한 (B1) | B1 결정 대기 |
| R-5 | lock 합성 backend 집중 | M2 shadow run | 미착수 |
| R-6 | boardingPrompt 폭증 | M7-new monitor (#1021) | ✅ 머지 |
| R-7 | dismiss-silence 확대 | C9-new (lock 단위 scope) | Epic C에서 |
| R-8 | Cloudflare quota | M8-new dashboard (#1022) | ✅ 머지 |
| R-10 | fusion 신호 우선순위 모호 | A2-new | 미착수 |

## 6. 의존 / 통합 / 트리아지 반영 (2026-06-11)

- **선행 epic**: #912 (매역 알람 100%) — 잔여: A3 #918, B1 #921. E1(#922)은 PR #927/#953 머지로 close — Seam C 시나리오는 #1200으로 발행(H5 #1012 머지 후 착수)
  - A3(#918) 선행 조건: **#773 (옛 trip OS 예약 큐 cleanup)** + iOS 64개 한도 rolling window + fire-time re-validation(#729 흡수) — #918 본문에 반영됨
- **통합 epic**: #874 (ADR-008 Stage 4 Phase A+B) — B2 결정으로 본 epic 흡수 예정
- **close**: #844 — PR A 머지 완료(#879). 잔여 B/C/D는 B2 결정으로 Epic C 풀 귀속 (2026-06-11)
- **완료 close된 선행 epic**: #869 (트리아지) → #896 (7 Seam) — 2026-06-11 정리
- **본 epic으로 흡수되어 close된 옛 이슈**: #493(alert push 전환), #496(backend progress 인지), #586/#614(LA push update/환승 전환), #674(BG 위치 미갱신), #729(fire-time re-validation→#918), #798(RC3로 해소), #447(GPS 신뢰 정책 재정의)

## 7. Acceptance (epic close 조건)

- [ ] 회귀 7개 1주 측정 0건 (회귀 목록 정의는 원본 유실 — Epic A 머지분 기준 재확정 필요)
- [ ] R-1 ~ R-10 monitor 작동
- [ ] ADR-011 머지
- [ ] 추가 발견: A 카테고리 흡수 / B follow-up / C 별 epic (B14 룰 적용)

## 8. 변경 이력

- 2026-06-11: 원본 부재 확인 후 GitHub 상태 기준 재구성 생성. Epic A 15/17. B1~B5/B14 미결.
- 2026-06-11 (2차): H1(#1009) PR #1133 머지로 완료 → Epic A 16/17. B2 결정 완료 — #844 close(잔여 Epic C 풀 귀속), #922 close(E1 완료, Seam C deferred).
- 2026-06-11 (3차): Seam C deferred 시나리오 → #1200 발행. 본 SSOT PR #1199로 dev 반영 진행.
