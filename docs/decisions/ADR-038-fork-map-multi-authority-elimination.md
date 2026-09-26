# ADR-038 — 갈래 지도: 다중 권위 fork 소멸 로드맵

- 상태: Proposed (2026-09-09)
- 관련: [[decision_ARCHITECTURE_COMMITTED_server_track_visible_push]], ADR-037(legConsensus inert), ADR-036(발사권위 이전), ADR-031(silent push deadlock)
- 검증 상태 표기: **confirmed**(이번 세션 코드/덤프로 확인) / **assumed**(추론, 미검증)

---

## 1. Context — 버그는 코드가 아니라 "갈래의 이음새"에 산다

2026-09-09 7→2 라이드 조사에서 나온 버그 전부가 **fork(갈래) 사이 seam**에서 발생했다 (confirmed):

| 버그 | fork seam |
|---|---|
| 성수 7호선 색 (D#10) | `fusion result.line` vs `journey segment.line` vs `approachLine` — 한 역을 색칠하는 소스 3개가 환승서 불일치 |
| 수동 lock 소실 → 프롬프트 재발사 | 재등록 carry-over의 `auto-lock 보존` vs `manual-lock 버림` (index.ts:967-971) |
| legConsensus 영구 inert (ADR-037) | `C토글 OFF→legConsensus` vs `C토글 ON→runLocklessIntermediate` 라우팅 갈래 |
| 프롬프트 발사 조건 | `lockMissing` vs `lock-active` × `leg-1` vs `leg-2` × `GPS경로` vs `GPS-free경로` |

**근본**: 단일 권위가 없어 매 지점마다 "누굴 믿지?"를 fork로 화해시킨다 → 조합 폭발 → 미테스트 조합에서 버그 번식("CI green ≠ 동작", `lesson_ci_tests_parts_not_wire`).

```
신호 10 tier × 환경 4 × lock 4 × leg 2 × C토글 2 × 발사경로 2 = 수백 경로
```

## 2. 결정

**확정 아키텍처(backend SSoT + LA 표시 + device 탭)**를 "갈래 소멸"로 재정의한다. 각 fork를 "무슨 실패를 막나 → backend로 흡수됐나 → 제거 가능?"로 심사하고, **권위 durable화 → device 화해 fork 접기 → device 발사 fork 삭제** 순으로 소멸한다.

원칙:
- **fork를 맨몸으로 지우지 않는다.** 각 fork는 진짜 실패를 막던 load-bearing 목발. 그것이 막던 실패가 backend 권위로 흡수됐다는 evidence(라이드/D1) 후에만 삭제.
- **shadow-first** (ADR-037 hmmFlag 선례). 절대 바로 on/off 금지.
- **권위가 자기 상태를 못 지키면 단일 권위 자격 없음** → Phase 0이 절대 선행.

---

## 3. 갈래 인벤토리 (도메인별)

### D1. "현재역이 어디?" — fusion cascade (`pickFusionTier.ts`, 10 tier)
`position-train-lock > gps-fast-path > arvl-arrived-match > backend-ssot > wifi > position-train > fused > detection-verdict > route > gps-fallback`

| tier | 무슨 실패를 막나 | backend 흡수? | 조치 |
|---|---|---|---|
| position-train-lock | 탭한 열차 확증 | lock=backend 권위 | → backend-ssot로 통합 |
| gps-fast-path / arvl-arrived-match | 지상 빠른 확정 | 부분(backend arvlCd) | fallback 강등 |
| **backend-ssot** | — (이게 권위) | ★ 주 권위 | **유지(주)** |
| wifi | 지하 GPS dead-zone | assumed 부분 | fallback 유지(지하 backend 공백) |
| position-train / fused / detection-verdict | device 자체 융합 | backend가 대체 | 강등→삭제 후보 |
| route | 계획값 | backend leg | 삭제 후보 |
| gps-fallback | 전부 죽을 때 | 불가(최후) | **유지(순수 fallback)** |

목표: `backend-ssot(주) → wifi/gps(지하·backend공백 fallback)` 2~3 tier로 축소.

### D2. "몇 호선?" — line identity (소스 4개)
| 소스 | 위치 | 문제 |
|---|---|---|
| fusion `result.station.line` | 헤더 | 역 단일노선이면 정확 |
| `approachLine` | BoardingTrainList | lock→legAdvance→route→current 4단, #1325 가드 있음 |
| journey segment line | 타임라인 | **가드 없음 → 성수 7호선 (D#10)** |
| backend-ssot `currentStationLine` | cascade | leg 전환 flip |

목표: **approachLine을 line SSoT로 단일화**, journey/fusion/header가 이를 구독. (D#10 색 가드는 Phase 1 착수 전 임시 삽입 가능)

### D3. "환경?" — `inferEnvironment`: surface / underground / mixed / unknown
GPS 게이트 bypass 분기 유발. backend 추적은 device 환경과 무관(TOPIS 서버측) → **backend 권위 확립 후 device 환경 분기 대폭 축소 가능.**

### D4. "lock 상태?"
- active vs missing (`isBoardingLockActive`)
- **auto-lock vs manual-lock** (carry-over fork, index.ts:967-971) ← 수동 lock 소실 root (confirmed)
- PENDING vs real trainCode

목표: 재등록 carry-over에서 **manual/auto 구분 폐기**(둘 다 보존), 명시 release 신호로만 삭제.

### D5. "어느 leg?"
leg-1(`promptDisplay`, 1회 즉시 승격) vs leg-2(`currentLegAnchor`, K-streak 승격, `LEG_RESOLVE_STREAK_THRESHOLD`). → backend가 leg 상태 소유 시 device 분기 소멸.

### D6. "cron이 뭘 하나?" — backend routing (`scheduled.ts`)
- lock-active → `runTrainCodeTracking`
- lockMissing + C ON + intermediate → `runLocklessIntermediate`
- lockMissing + C OFF + intermediate → `legConsensus`(tryFireConsensusTrainLeg) ← **inert (ADR-037)**
- lockMissing → boardingPrompt(GPS 9-gate) + GPS-free prompt + leg-2 prompt

목표: 라우팅 갈래 통합(단일 진입), legConsensus는 ADR-037대로 belief prior로 흡수.

### D7. "누가 발사?"
device fire(`MINIMAL_ALARM`, 현재 OFF) vs backend fire(cron). → **device fire 영구 삭제 = 최대 fork 소멸.**

### D8. "프롬프트 게이트?"
surface(9-AND) / underground·mixed·unknown(bypass+consensusGate) / archFlag on(#9만). → 환경 분기(D3)에 종속, 함께 축소.

---

## 4. 소멸 순서 (Phase)

```
Phase 0 — 권위 durable화 (선행 필수)
  ✅ A #2548: currentLegAnchor 등 4필드 carry-over
  🔴 수동 lock 소실 fix (D4, index.ts:967-971) — auto/manual 구분 폐기
  ⬜ 상태필드 carry-over 전수 감사 (backend-only 필드 중 재등록서 소실되는 것 전부)
  게이트: 라이드 D1에서 lock_attached 지속 + 프롬프트 재발사 0

Phase 1 — line identity 단일화 (D2)
  ⬜ approachLine = line SSoT, journey/fusion/header 구독
  ⬜ buildJourneyDisplay 정합 가드 (성수 7호선 색 — 임시로 Phase 0 중 먼저 넣어도 무방)

Phase 2 — cascade 축소 (D1)  [shadow-first]
  ⬜ backend-ssot 주 + wifi/gps fallback. position-train/fused/detection/route 강등→삭제
  게이트: shadow 1주 tier 분포에서 삭제 대상 tier 채택률 ≈ 0 확인 후 제거

Phase 3 — routing/leg 통합 (D5,D6)
  ⬜ legConsensus belief prior 흡수(ADR-037), lockless/consensus 라우팅 단일화
  ⬜ leg-1/leg-2 경로 통합

Phase 4 — 발사 단일화 (D7,D8,D3)
  ⬜ device fire(MINIMAL_ALARM) 영구 삭제, 발사=backend only
  ⬜ 환경 분기(D3) + 프롬프트 게이트(D8) 축소
```

## 5. 리스크 / 미해결
- **지하 TOPIS 공백**: backend가 지하서 열차 못 볼 때가 있음(assumed) → wifi/gps device fallback은 **남긴다**. 갈래 0이 목표가 아니라 "화해 갈래 0, fallback 갈래 최소"가 목표.
- **각 fork 삭제 = evidence 게이트**: 그 fork가 막던 실패가 backend로 흡수됐다는 라이드/D1 evidence 없이 삭제 금지.
- **shadow 인프라**: Phase 2 tier 분포 측정(#1936 fusionTierAdopted 이미 존재)으로 삭제 안전성 판정.
- **미확정(assumed)**: D1 cascade 각 tier가 실제로 얼마나 채택되는지 프로덕션 분포 미측정 → Phase 2 착수 전 1주 측정 필요.

## 6. 다음 액션
1. Phase 0의 수동 lock 소실 fix 착수 (정책 결정 선행: "수동 lock을 언제 진짜 release로 볼지").
2. 본 ADR을 issue epic으로 분해(Phase별 sub-issue).

---

## LIVE backlog 앵커 (2026-09-11 이슈 무덤 정리) — 고아 방지

2026-09-11 열린 이슈 57→29 정리. DEAD 28개(device 추적/발사/GPS fusion/autoLock/lockless self-contained + 옛 6월 RCA epic + retired-root)를 근거 코멘트 링크 달아 close. 아래는 **현재 방향(backend 단일 lock-추적 + LA + 탭)에 유효한 LIVE backlog** — 새 이슈 만들지 말고 여기서 작업/교차연결한다.

**오늘 leg 작업 직결 (우선)**: #2351(origin boardingPrompt empty/방향), #2323(leg consensus), #2130(boarding-prompt 0건), #2526(leg-2 cron lock), #1553(Backend SSoT 코어), #2336(lineHeadways)
**backend 인프라**: #2260(per-trip DO), #2234·#2292(계약 게이트), #2239(replay), #2062(apnsEnv self-heal), #2191(진단)
**알림 방향 핵심**: #2061(알림≠알람 단일 결정자), #2155(OS예약→backend 단일)
**LA/탭 (확정 방향)**: #2436·#2438·#2439(LA 인터랙티브)
**실버그/UX/결정**: #2300(언어 라벨), #2377(위젯 딥링크), #2285(안내중단/종료 결정), #2366(취침 loud-wake), #2302·#2298, #2306/#2371(BG 침묵)
**미래(무관/보류)**: #79(OAuth)

**미수정 잔여(오늘 라이드 confirmed, 기존 이슈에 매핑)**: 탑승여부 방향 틀림→#2351/#2130, trip 종료 후 재발사→신규 조사 필요(기존 없음), 하차 프롬프트, LA vs 홈 현재역 불일치→#2306 계열.

---

## 다중 leg(환승) 아키텍처 완결 (2026-09-11) — leg-agnostic 확정

사용자 요구: "Leg-2,3,4,5 등 다환승 경로도 아무 문제 없도록 아키텍처를." 아래 4조각으로 leg 번호 무관 균일 처리를 **코드+테스트로 확정**:

| 조각 | 위치 | 검증 |
|---|---|---|
| lock segment 격리 | `buildLockFromKnownTrainCode` (line 경계 break) | #2564 (leg-1/2/3 segment 격리) |
| lock 승격(탭/sync) | `/boarding-lock/sync` #2560 + leg-2 streak(#2539) | #2564 (leg-2/3 sync 승격) |
| 환승 release + anchor 전진 | `scheduled.ts:4818`(release) + `4913`(무조건 덮어쓰기 + cross-leg 리셋) | #2515(1차)+#2568(N차 덮어쓰기)=귀납 완성 |
| 다환승 라우팅(허브 통과) | `buildRouteGraph` 이름 정규화 | #2566/#2567 (42개 허브 환승 엣지 복구, 성수2→마장5 NULL 해소) |

**결론**: lock 생성·승격·환승 release·anchor 전진·경로 탐색 전 구간에 leg 번호 하드코딩 없음. `scheduled.ts:4913`이 매 환승 anchor를 덮어쓰므로 leg-3/4/5+도 동일 경로. 남은 것은 실기기 다환승 라이드 field-verify(#2566 backend 배포 완료).
