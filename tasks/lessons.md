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

### L12b — sonar-project.properties는 사문서 (2026-10-05 확정)
이 프로젝트는 SonarCloud **AutoScan**(CI 워크플로 없음)이고, 실효 설정은 **서버측 UI 값뿐** — `api/settings/values?component=handokei_subway-now` 실측: cpd 제외는 `**/*.test.ts, **/__tests__/**, **/*.swift` 3개만. 레포 파일의 backend/** 제외·cpd 목록은 전부 미적용(PR #2870에서 backend 파일이 cross-dup 상대로 잡혀 증명).
→ Sonar 게이트 조정은 레포 파일 수정이 아니라 **SonarCloud UI(Administration → Analysis Scope)** 에서. 레포 파일에 줄 추가는 효과 0.

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

### L20 — 양방향 감사가 "결정 축"을 안 본다 → 같은 root가 3주 뒤 다른 소비자에서 재발 (2026-10-10 사용자 지적)
10/9 라이드의 두 결함(얼어붙은 GPS가 LA arbitration 승리 / `boardedAt`=탐지시각)은 **9/18 ADR-039가 이미 다룬 root**였다. `/audit-sides`도 돌렸고 양방향도 매번 요구됐는데 전부 통과했다. 메커니즘 5개:
1. **`/audit-sides` 축이 전부 코드 경로 축**(경로·방향·레이어·상태·시간)이라 "이 신호를 읽는 **다른 소비자**"를 열거할 칸이 없다 → ADR-039 1단계(15s 신선도)가 `useFusedNearestStation.ts:584`에만 배선되고 `liveActivityGpsWriteArbitration.ts:32`는 누락(편측).
2. **결정 문서끼리 대조하는 단계가 없다.** 9/3 확정(표시=backend SSoT)과 ADR-039 매트릭스(표시=GPS **권한**, backend=보조)가 정면 충돌. ADR-039는 9/3 결정을 **관련 문서로 링크까지 해놓고** 반대로 배정했다. ADR-014에 "기존 확정 결정과 충돌하는가" 항목이 없다.
3. **close 조건이 고친 축만 측정 → 자기확인.** ADR-039 close 4개 전부 발사/판정, 표시 조건 0개. 10/9는 ①도착 13건 ④overshoot 0으로 **ADR-039 기준 성공한 라이드**였다(사용자는 불편을 겪었고 측정은 녹색).
4. **다단계 Proposed ADR에 소유자·close 게이트가 없다.** ADR-039는 3주째 `Proposed`, 커밋 1개(#2712) 이후 무변경, 5단계 중 5단계(`lockActive` 이중 의미)는 ADR이 "구조적으로 불가능하게 만든다"고 선언한 모순이 `fusionDistanceGate.ts`에 그대로.
5. **동어반복 지표**: `delaySeconds = now - boardedAt`인데 `boardedAt = Date.now()`(탐지 순간) — 재려는 지연을 만든 순간이 기준점이라 영원히 0에 가깝다. 사용자가 눈으로 본 2분을 계측이 **원리적으로** 보고할 수 없다.
→ **룰**: ①신호의 게이트/권한을 바꾸면 그 신호의 소비자를 **표시/판정/발사 축으로 전수 열거**(`/audit-sides` 축 추가) ②새 ADR에 **"수정·대체·모순하는 기존 결정" 섹션 필수**(없으면 "없음 — 확인한 ADR 목록") ③**건드린 축 전부에 close 조건** — 표시 축을 바꿨는데 표시 acceptance가 없으면 close 불가 ④**지표 기준점 금지** — 재려는 지연을 만든 주체의 시각을 기준점으로 쓰지 않는다 ⑤다단계 계획을 가진 ADR은 **epic으로 승격**(소유자+단계별 게이트).
- 동류 자기사례: 같은 턴에 쓴 ADR-040이 **UNTRACKED**로 남았다(lessons 미커밋은 #2929로 처리했는데 ADR은 놓쳤다) — 결정이 보이지 않게 되는 경로가 바로 이것.

### L19 — 검증은 working tree를, 커밋은 index를 본다 — Edit 후 `git add` 누락 (2026-10-08 실사용)
충돌 해결 중 ①`git add -A`(이 시점 `scheduled.ts`는 **충돌 마커 없이 자동 머지**된 8-arg 버그 상태로 스테이징) → ②`type-check`로 에러 발견 → ③`Edit`으로 수정 → ④**`git add` 없이 `git commit`**. 로컬 `type-check`/vitest 3,803건은 **working tree** 기준이라 green, 커밋·push된 건 **index**의 수정 전 내용. CI(#2919 Backend Validation)만이 `scheduled.ts(6630): TS2554 Expected 9 arguments, but got 8`로 잡았다. 보고는 "전체 통과"였고 **보고와 origin 내용이 달랐다**.
→ **커밋 전 `git diff --cached`로 "스테이징 내용 == 검증한 내용"을 확인**하고, **push 후 `git show origin/<branch>:<파일>`로 실제 올라간 블롭을 재확인**한다. 특히 **머지 커밋 작성 후에도 `type-check`를 한 번 더** 돌린다 — 머지 커밋이 직전 수정을 조용히 덮을 수 있다(충돌 마커가 없어 `tsc`만이 감지).
→ 리뷰 측: 에이전트의 "로컬 전체 green" 보고를 **origin 블롭 직접 확인으로 교차검증**한다. 이번에 4개 호출부를 `git show`로 전부 뽑아 9-arg를 확인한 것이 그 절차다.
- 동류: 필수 파라미터 추가(#2896 `endPath` 9번째 인자)는 **auto-merge가 충돌 없이 통과시키므로 타입 체크만이 게이트** — 같은 PR에서 호출부 전수 grep 의무.
- **더 나쁜 동류 — `tsc`조차 못 잡는 중복 생성**: #2924 머지에서 git merge 알고리즘이 "#2900 거부 케이스 ⓕ" 분기 **18줄 전체를 문자 그대로 2번 생성**했다(양쪽 브랜치 모두 1회만 가진 블록). 충돌 마커 없음 + **문법적으로 유효하므로 type-check도 통과** → 런타임에 같은 push를 2회 발사하는 종류의 결함. `grep '<<<<<<<'`도 `tsc`도 게이트가 아니다.
→ **충돌 해결 후 `git diff origin/dev...HEAD`를 사람 눈으로 훑는 것이 유일한 탐지 수단**("내가 의도하지 않은 추가 라인이 있는가"). 블록 중복은 **표식 주석의 고유 문자열을 `grep -c`로 개수 세기**로 1차 탐지한다(예: `grep -c "거부 케이스 ⓕ"` == 1).
- **`grep -c`도 충분하지 않다 — 두 사본이 다를 수 있다**: 같은 ⓕ 블록이 #2922 머지에서 **세 번째로** 중복됐고, 이번엔 첫 사본이 dev의 순수 버전, **두 번째 사본만 `fireDestinationDisembarkPrompt` 호출을 보유**했다. 개수만 세고 아무 사본이나 지우면 **신규 기능 호출이 조용히 사라진다**. → 중복 발견 시 **각 사본을 diff해서 "어느 쪽에 고유 로직이 있는가"까지 읽고** 고유 로직 보유 사본을 남긴다. 3회 재발 = 이 레포의 대형 단일 파일(`scheduled.ts` 6,900행+)에서 **구조적으로 반복되는 현상**이지 우연이 아니다.

### L18 — 알려진 결함은 `it.fails`로 **공개 green**, 몰래 green 금지 (2026-10-08 결정)
whole 시나리오가 "결함이지만 설계 결정 전까지 못 고치는 것"을 찾아내면, 그 테스트를 빨간 채 두면 **PR이 영원히 머지 불가 → 시나리오가 CI에 안 들어가 최초 발견자가 계속 사용자**가 된다. 반대로 지우면 회귀 자동 감지를 잃는다.
→ **`it.fails()`(vitest) / 동등 수단으로 "현재 실패함"을 단언**한다. CI는 green이 되고, 동작이 고쳐지는 순간 `it.fails`가 **역으로 실패**해 갱신을 강제한다.
**필수 조건 3개(없으면 이건 CI 우회다)**: ①해당 테스트 주석에 **OPEN 이슈 링크**(추적처) ②PR 본문에 "왜 `it.fails`인가 + 어떤 결정이 선행돼야 하는가" 명시 ③`it.fails` 도입/해제는 리뷰에서 명시적으로 다룬다.
의미 재정의: **green = "결함 0"이 아니라 "등록된 알려진 결함 외에 새 실패 없음"**.
- 근거: 2026-10-08 S8(ADR-026 매역 폴백 0건, 추적처 #2905)·S11(탑승 증거 없는 목적지 확정, 추적처 #2900)에서 이 선택이 처음 필요해졌고, 보안 점검이 "무단 CI 우회" 가능성을 지적해 사용자 승인 후 정책화.

### L17 — 술어 재사용 시 "용도(시제)"를 분리 검증 (2026-10-07 실사용 회귀)
#2883이 `isBoardableCandidate`(회고적: "이미 탄 열차가 어느 것인가" — arvlCd 0/1/2만)를 **표시용 탭 리스트**(전향적: "곧 올 열차를 미리 탭")에 그대로 배선 → arvlCd=99 전부 배제 → 리스트 영구 공란. 실사용 트립(10/7 06:29 용마산)에서 사용자가 발견. 단위/타깃 테스트는 전부 green이었고 편측 감사도 통과했다 — 감사 축에 "같은 술어를 쓰는 소비자들의 **시제·용도**가 같은가"가 없었다.
→ **공유 술어를 새 소비자에 배선할 때, 그 소비자의 시제(회고 vs 전향)와 기대 입력 분포(여기선 arvlCd 분포)를 명시 비교한다.** 리스트/표시 계열 변경은 "정상 상황에서 **비어 있지 않은가**"를 whole 케이스로 assert(공란은 조용한 실패라 어떤 게이트에도 안 걸린다). `/audit-sides` 축에 "용도/시제" 추가.

### L16 — "로그 소급 불가" 단정 전 R2 seoul-capture 확인 의무 (2026-10-03 지적)
persist=false로 wrangler tail 로그가 없어도 **R2 `seoul-capture/{날짜}/{cycleStartMs}.json`(#2579)에 활성 cron cycle의 Seoul API 원본 응답(arrivals+positions 전체)이 남는다**. 10/3 트립 "지상 attempt 0건 원인 미확정 — 로그 영영 소급 불가"로 보고했다가 사용자 지적 후 R2 캡처 9 cycle로 당일 완전 소급·확정함(3174 종착 소실 + 왕십리(성동구청) arrivals 0행).
→ **"소급 불가" 선언은 ①덤프 ②D1 ③R2 seoul-capture 3종 전부 확인 후에만.** 접근: `GET /admin/seoul-capture/keys?from=&to=` (Bearer = .env EXPO_PUBLIC_ADMIN_TOKEN) → `wrangler r2 object get subway-now-telemetry/<key> --remote --config wrangler.toml`.

---

## 자기 점검 루틴 (세션 시작 시)

1. 본 파일 읽고 적용 가능한 룰 식별
2. 결정 PR 작성 시 L1~L4 자가 점검 통과
3. BG agent 띄울 때 L5 적용
4. PR 머지 보고 시 L7 준수
5. 회귀 / acceptance 정의 시 L3 + L4 자가 점검 통과
- '라이드/실측 후 결정' 반사 금지 — 결정 근거는 ①코드 포함관계 증명 ②기존 dump/D1 소급 순. 새 데이터 요구는 이 둘 불가 증명 후에만 (2026-09-30 3회째 지적)
