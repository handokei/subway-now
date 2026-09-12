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

Lock backend SSOT + GPS 격하 + 토글 폐기. **착수 차단 해제 (B1~B5/B14 결정 완료, 2026-06-11).**
sub-issue 상세는 발행 시 본 문서에 기입한다. (원본 SSOT 부재로 16건의 사전 정의는 유실 — 결정 후 재정의 필요)

### Epic B (Week 4~9, 9 sub-issue 예정) — 회귀 #5/#6 — **미발행**

race/storage/lockless 근본 refactor. Epic C 단기 완료 후 착수.

### Epic C 풀 (Week 10~14, 5 sub-issue 예정) — D1/D5 완성 — **미발행**

ADR-008 Stage 4 Phase A+B 통합. **B2 결정(2026-06-11)으로 #844 잔여 PR B/C/D가 본 단계 sub 5건 중 3건으로 귀속 확정 — #844 close됨.** sub-issue 발행 시 #844 본문의 PR B/C/D 정의 + open questions 참조.

## 4. 결정 항목 — **전부 결정 완료 (2026-06-11 일괄 확정)**

> ✅ B1~B5 + B14 결정 완료 → **Epic C 단기 착수 차단 해제.** 다음 단계: ADR-010 patch + ADR-013 초안(PR-α), 코드/UI(PR-β), Epic C 단기 16건 sub-issue 재정의·발행.

- [x] **B1** — ADR-010 C **유지** + 의미 재정의 ("전체역 보기 정보용") + **토글 OFF 시 활성 lock cleanup**. D 신설 불필요. ADR-013 신설 (PR-α `docs/adr-011-lockless-supplementation`), 코드/UI는 PR-β (예정).
- [x] **B2** — epic #874를 본 epic에 흡수. #844 PR B/C/D는 Epic C 풀(Week 10~14)에 귀속. #844 close 완료 (`project_2026_06_11_epic1008_b_decisions.md`).
- [x] **B3** — #912 acceptance 재해석:
    - ✅ lock 활성 trip: 매역 알림 100%
    - ✅ lockless trip: boardingPrompt 9단 게이트 통과 + 사용자 [탑승] 응답 시 100%
    - ⚠️ 게이트 미통과 / 사용자 무응답 / 토글 OFF: acceptance **위반 아님** (사용자 선택)
- [x] **B4** — 낙관적 UI 채택. trip 등록 직후 BoardingTrainList 노출 → 사용자 탭 시 즉시 visual + lock pending → backend round-trip → 정상은 visual 갱신, 정정은 toast. (R-3 대응)
- [x] **B5** — backend optional 먼저 → 1주 측정 (`serverProgress.received ≥ 95%` AND `deltaVsEstimator` 평균 임계 이하) → required 승격. (M2 shadow run과 결합)
- [x] **B14** — 신규 발견 회귀는 옵션 3 적용: A 카테고리 흡수 / B follow-up / C 별 epic. Epic A는 RC1~RC4 close 기준 고정.

### B1 후속 작업 묶음
- ADR 레이어: **PR-α** (ADR-013 신설 + ADR-010 patch) — 진행 중
- 코드/UI: **PR-β** — `setLocklessStationPassed(false)` lock cleanup + 토글 레이블 "전체역 보기" 4언어 적용
- acceptance 측정 양식: **PR-γ** (#1159) — `epic-1008-acceptance-result.template.md`

### Epic C 단기 16건 / Epic C 풀 5건 sub-issue 정의 — **미진행**
- 원본 SSOT 부재로 사전 정의 유실 (§3)
- B 결정 확정됐으나 sub-issue 16+5건의 코드네임/scope는 별도 재정의 작업 필요
- B2로 #844 PR B/C/D 귀속 결정됨 → Epic C 풀 5건 중 3건 자동 정의 가능 (PR B/C/D + 잔여 2건 새 정의)

## 5. 리스크 ↔ 대응 매핑 (R-1 ~ R-10)

| 리스크 | 내용 | 대응 | 상태 |
| --- | --- | --- | --- |
| R-1 | backend false positive 직격 노출 | Epic A prerequisite (RC1~RC4 게이트) | ✅ Epic A로 해소 중 |
| R-2/R-9 | backend down | Phase A pull fallback | Epic C 풀에서 |
| R-3 | lock 탭 round-trip 500ms | 낙관적 UI (B4) | B4 채택 — Epic C 단기에서 구현 |
| R-4 | ADR-010 정책 변경 | 본인 권한 (B1) | B1 결정 완료 — ADR 개정 작업 대기 |
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

- [ ] 회귀 12개 1주 측정 0건 (정의는 §7.1)
- [ ] R-1 ~ R-10 monitor 작동
- [ ] ADR-011 머지
- [ ] 추가 발견: A 카테고리 흡수 / B follow-up / C 별 epic (B14 룰 적용)

### 7.1 회귀 12개 정의 (Epic A 머지분 기준 재확정, 2026-06-11 / lockless 카테고리 추가 2026-06-12)

> 본 절은 §7 첫 번째 항목 "회귀 12개 1주 측정 0건"의 SSOT 정의. 원본 SSOT 부재로 Epic A 머지된 sub-issue 본문 + RC 매핑(§1) + alarmLog stamp(#1019) 기준으로 재구성.
>
> **선정 원칙**: Epic A에서 backend/client 코드 변경으로 **잘못된 발사 경로**를 봉합한 sub-issue + Epic #1204 lockless 복구 D-작업 범위를 포함. 측정 인프라(M1/M4/M7/M8) 및 운영성 개선(DL-B/DL-H)은 본 12개에서 제외 — 회귀 자체가 아니라 그 회귀를 측정하는 도구이기 때문.
>
> **회귀 번호**는 epic 본문에 등장하는 "회귀 #1~#12" 임의 식별자이며, GitHub issue 번호와 무관.
>
> **회귀 카테고리** (2026-06-12 epic #1204 발행 시 lockless 추가):
> - 회귀 1~7: **lock 활성 trip** 회귀 봉합 (Epic A 머지 sub-issue 기준)
> - 회귀 8~12: **lockless + 사용자 명시 의향 trip** 회귀 봉합 (Epic #1204 D1~D9 작업)

| # | 회귀 패턴 (한 줄) | RC | 봉합 sub-issue | 검출 기준 (alarmLog reason — #1019 stamp) |
| --- | --- | --- | --- | --- |
| 1 | hydrate 직후 station-passed effect가 warmup 무시하고 즉시 발사 | RC2/RC4 보조 | #1010 | `fired` entry 중 `reason=station-passed` & hydrate 후 경과 시간 < 30s |
| 2 | backend autoLockCandidate를 client가 무검증 채택 (origin 지난 trainCode hydrate) | RC2 | #1014 | `fired` entry 중 lock acceptance gate 실패 reason(`acceptance-direction-mismatch` / `acceptance-not-in-arrivals` / `acceptance-no-origin-dwell`)이 stamp되지 않은 hydrate 직후 발사 |
| 3 | hydrate 직후 fusion backward jump를 forward-only 검증이 못 막아 옛 train으로 발사 | RC3 | #1015 | `fired` entry 중 `positionTrainResult.currentStation` index < `lock.boardingIdx` 시점 발사 (forward-only 위반) |
| 4 | 지하/저정확도 GPS 게이트 3 hole 우회 (userLocation=null placeholder, accuracy>200m bypass, line-only check) | RC3 | #1016 | `fired` entry 중 `gps.userLocation==null` 또는 `gps.accuracy>200m`인데 lock 활성 + nextHops window 밖 station_id 발사 |
| 5 | `trackTrainProgress` 자체에 forward-only 가드 없어 source 단에서 backward candidate 통과 | RC4 | #1017 | `fired` entry 중 candidate.currentStationIdx < boardingIdx에서 trackTrainProgress 결과로 발사 (source-level forward 위반) |
| 6 | backend `attemptAutoLock`이 arvlCd=2 at next-waypoint을 무조건 채택해 origin 지난 train lock | RC1 | #1018 | BFF telemetry: `attemptAutoLock` 응답 중 confidence < threshold에서 trainCode 반환 (gate 우회). 또는 client 측 RC1 회귀 #2 패턴과 동시 등장 |
| 7 | motion 권한 미부여/cold-start에서 motion warmup 부재로 phase gate 우회 → 잘못된 phase에서 발사 | H6 | #1013 | `fired` entry 중 `motion=undefined` & phase gate stamp 누락 & cold-start 후 < 60s positionStability fallback 미적용 |
| 8 | lockless + 사용자 명시 의향 trip에서 trip route 진행도 외 역 station-passed 발사 | RC3 보조 + 신규 | D2 (hop window 게이트) | `fired` entry 중 trip route arc의 currentHopIndex ± 1 외 station_id 발사 (currentHopIndex source: D1 lockless estimator → 폴백 firedAlarms max index + 1) |
| 9 | lockless trip 지하 진입 시 GPS sticky로 잘못된 station 매칭 (sticky station이 motion automotive로 unlock되어 GPS sticky 그대로 노출) | 신규 | D6 (sticky station trip 활성 시 유지) + D1 (estimator cascade) | `fired` entry 중 `subsurface=true` AND `fusion.source='gps'` AND GPS lat/lng 좌표의 1km 외 station에서 station-passed 발사 |
| 10 | lockless trip 환승 leg trainCode 상실 → backend auto-end (#622 재발) | 신규 | D4 (boarding-lock/sync trainCode 동봉) | backend `boarding-lock: trip auto-ended` 카운트 / 환승 횟수 ≥ 1 trip 총합. 환승 있는 trip 중 auto-end 비율 |
| 11 | silent push fire/received < 80% (lockless intermediate 위치 게이트 false negative) | 신규 | D3 (silent push 게이트 정밀화) | client `silent-push-received` count vs `silent-push-fired` count 비율 (lockless intermediate kind 한정) |
| 12 | 환승 leg에서 boardingPrompt/autoLock 미트리거 (planned route 환승이라 useTransferAutoDetect skip) | 신규 | D5 (환승 leg autoLock 확장) | 환승 발생 trip 중 환승 후 N분 내 backend `boardingPromptEvaluated` count 0건 비율 |

#### 측정 framework

- **측정 출처**:
  - **client**: production 빌드의 `alarmLog` `fired` entry + #1019 stamp된 reason 분포 (DebugModal `## Gates` 섹션)
  - **backend (회귀 6 전용)**: Cloudflare Worker 로그 + `attemptAutoLock` confidence stamp (#1018에서 추가)
- **수집 도구**:
  - 1차: 운영자(본인)가 DebugModal `Share` 버튼으로 alarmLog JSON export → 로컬 집계 스크립트 (`scripts/`에 별도 PR로 추가 예정)
  - 2차(이상치 검증): BFF telemetry는 #1022(M8) Cloudflare Worker quota dashboard에 회귀 6 카운터 1개 추가하는 follow-up으로 자동화
- **검출 자동화**:
  - 회귀 1~5, 7: client alarmLog `fired` reason + 컨텍스트 stamp만으로 판별 가능 (별도 인프라 불필요)
  - 회귀 6: backend confidence gate 우회 카운터 — `R-1` monitor(§5)와 동일 출처
- **기간**: 1주 연속 (production 빌드 사용 7일). 운영자 본인 1명 기준 (대규모 베타 부재). 1일 평균 trip 횟수 × 7 ≥ 10 trip 이상 누적 시 통계 신뢰성 충족으로 간주
- **결과 기록**: 측정 종료 후 `tasks/epic-1008-acceptance-result.md` 별 파일에 회귀 #1~#7 카운트 + 트립 표본 수 + 0건 판정 여부 기록 후 본 epic close

#### 비포함 항목 (왜 7개에 안 들어갔는지)

- **H1 #1009 / H5 #1012** — 회귀 봉합이 아니라 진단 인프라/state machine. 측정 도구.
- **H3' #1011** — `lastNotifiedStationId` destination scoping. 동일 station 재발사 가드이지만 회귀 #1 (warmup)과 trigger 조건이 중첩되어 별도 회귀로 카운트 시 double count. 회귀 #1 measurement에 흡수.
- **M1/M4/M7/M8 (#1019~#1022)** — 측정/모니터. 회귀 자체가 아니라 본 §7.1의 검출 도구.
- **DL-B/DL-H (#1023/#1024)** — 운영성(dedup window 확장, burst counter). 봉합이 아니라 운영 잡음 감소.

## 8. 변경 이력

- 2026-06-11: 원본 부재 확인 후 GitHub 상태 기준 재구성 생성. Epic A 15/17. B1~B5/B14 미결.
- 2026-06-11: §7.1 "회귀 7개 정의" 추가. Epic A 머지된 #1010/#1013/#1014/#1015/#1016/#1017/#1018 기준 회귀 패턴 + 검출 기준 + 측정 framework 명시 (PR `docs/#1008-epic-acceptance-regressions`).
- 2026-06-11 (2차): H1(#1009) PR #1133 머지로 완료 → Epic A 16/17. B2 결정 완료 — #844 close(잔여 Epic C 풀 귀속), #922 close(E1 완료, Seam C deferred).
- 2026-06-11 (3차): Seam C deferred 시나리오 → #1200 발행. 본 SSOT PR #1199로 dev 반영 진행.
- 2026-06-11 (4차) 일괄 확정: §4 B1/B3/B4/B5/B14 결정 — C 토글 **유지+재정의** + 토글 OFF lock cleanup, #912 acceptance 재해석, 낙관적 UI, optional→required 승격, B 영역 follow-up. 코드/UI 반영은 PR-β (예정), ADR은 PR-α (`docs/adr-011-lockless-supplementation`), acceptance 양식은 PR-γ (#1159). 결정 차단 항목 전체 해소 → Epic C 단기 착수 가능.
- 2026-06-12: §7.1 회귀 7개 → 12개 확장 (PR-ζ / 본 PR). 2026-06-11 narrow-down 사고 복구 — Epic A 머지 sub-issue만 기준으로 회귀 정의 좁힘이 lockless 회귀 누락 초래. ADR-014 §3 (acceptance 정의 순서 룰: 사용자 가치 → acceptance → 코드) 적용. Epic #1204 발행과 함께.
