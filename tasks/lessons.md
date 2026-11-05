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

### L21 — 계산된 정보를 버리고 재도출하면 틀린다 + 사본이 늘면 같은 버그가 복제된다 (2026-10-10 실측)
`lineLoopPath.ts:76-77`이 **진행 부호를 이미 계산하고 버린다**(`directionSign = usePlusDirection ? 1 : -1`). 두 호출자(`directionOnLine.ts:49`·`tripDirection.ts:159`)가 그걸 **인덱스 크기 비교로 재도출**한다(`firstStepIdx > fromIdx ? 'up' : 'down'`) — wrap을 "증가"로 오해해 2호선 seam에서 방향이 반대가 된다. 전수 계산: **1,806쌍 중 42쌍(2.3%), 출발역은 시청(idx 0, 항상 `up`)·충정로(idx 42, 항상 `down`) 둘뿐.**
→ **①계산된 값을 버리지 말고 반환한다. 재도출 금지.** 호출자가 같은 결론을 다시 계산하는 구조는 그 자체가 결함 신호다.
→ **②사본이 늘면 버그가 복제된다.** #2455가 "하나의 알고리즘으로 통일"하려 `directionOnLine`을 추출했으나 **기존 것을 지우지 않아** 방향 산출 함수가 **6개**(device 5 + backend 1)로 늘고, 같은 seam 버그가 2곳에 복제됐다. `parseTrainLineDirection`은 **같은 이름이 두 파일에** 있다. **추출은 기존 것 삭제까지가 1건이다.**
→ **③"다시는"은 기계적 강제로만 보장된다** — 전 쌍 매트릭스 테스트(위반 시 즉시 red) + 금지 패턴 가드(`noRawSqlGuard.test.ts` 선례) + **신규 함수 추가 차단 화이트리스트**. 주석은 강제가 아니다(`feedback_comment_invariant_must_be_enforced`).
- **주석이 버그를 정상으로 서술하고 있었다**: `tripDirection.ts:152-153`이 *"신촌 → 시청 같은 wraparound는 path[1] < currIdx → 'down'"* 이라 적었으나 그 쌍의 최단은 내선 4 hop이고 공식은 `'up'`을 낸다 — **사실이 아닌 서술이 공식을 "검증된 것"으로 읽게 만들었다.** 근거 주석은 **반례로 검증**해야 한다.
- 추적처: #2949. 범위·단계는 그 이슈 코멘트.

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

### L22 — 검증을 끝내기 전에 결론·권고를 붙이면 진행이 멈춘다 (2026-10-11 사용자 지적)
한 세션에서 같은 사안의 결론을 **4번 뒤집었다**: ①"B(평면 순서 배열) 추천" → ②"B는 분기를 표현 못 해 거짓, D(토폴로지) 필요" → ③"관측값(`bstatnNm`)이 이미 있어 D 불필요" → ④"`bstatnNm`은 알림 본문만 고치고 방향 문제는 못 푼다". 매번 **측정은 맞았고 추천이 틀렸다** — 검증 범위를 닫기 전에 권고를 붙였기 때문이다. 사용자 지적: *"계속 뭐가가 나오니까 진행을 못하잖아."* 중간 숫자도 미분류 상태로 보고했다("67역 누락"→"73 엣지"→"75역"→실제 61+10+2+1).
→ **보고 단위는 "검증이 닫힌 명제" 하나다.** 부분 발견에 권고를 붙여 보고하지 않는다. 숫자를 낼 때는 **분류를 끝낸 값**만 낸다(미분류 중간값은 "분류 전"이라 명시하거나 내지 않는다). 소비처를 세었으면 **전수 열거**를 먼저 하고(사본·backend 트윈 포함) 추천한다 — L21의 "사본이 늘면 같은 버그가 복제된다"가 추천 단계에도 적용된다. 산출물: `tasks/2026-10-11-station-data-audit-official-csv.md` §4 "기각된 가설"에 뒤집힌 결론 4개를 근거와 함께 남겨 재논의를 차단했다.

### L25 — 측정 대상 함수가 **프로덕션에 배선됐는지** 먼저 확인한다 (2026-10-12, 머지된 문서에 거짓 주장)
9호선·2호선 "경로 탐색 전면 불능"을 `findRoutes` 실행으로 측정해 **사용자 가시 결함**으로 보고하고 감사 문서를 머지했다(#2954). **그 측정은 미배선 함수였다.**
```
src/shared/utils/stationRoute.ts::findRoutes    import 95건, HomeScreen.tsx:614 호출   ← 배선됨
src/shared/utils/dijkstraRoute.ts::findRoutes   import 0건                            ← 미배선 (측정 대상)
```
`stationRoute.findRoutes`는 같은 노선 직통을 `getStationsOnLine(line)` **배열 인덱스**로 계산하며 `stationDistances.json` 엣지를 쓰지 않는다 → 거리 키 0개여도 경로가 정상이다. `dijkstraRoute`는 #1499가 *"stationRoute / DebugModal에서 cross-check 가능하게"* 도입한 **교차검증용**이다. 보고값(개화→중앙보훈병원 `null`)과 실제(`direct`·환승 0)가 정반대였다.
→ **룰**: ①측정 함수를 고르기 전 `grep -rn "from.*<module>'" --include=*.ts src/ app/ | grep -v __tests__ | wc -l`로 **호출 여부 확인**. 0이면 그 측정은 사용자 가시성을 증명하지 못한다. ②**동명 export가 쌍으로 존재**하는 레포다(`findRoutes`·`dijkstraRoute`·`fromSeoulStationName`·`pickAutoTrainCode` — device/backend 또는 주/보조) → **파일 경로까지 명시**한다. ③"사용자 가시 결함"이라 쓸 때는 **소비 체인 끝(화면·푸시)까지 1회 추적**한다. 못 대면 "내부 지표 결함"으로 격하. ④**머지된 감사 문서가 틀리면 즉시 정정 커밋** — 문서가 다음 작업의 전제가 되므로 방치하면 오류가 증식한다(#2968로 처리).
- 발견 경위: #2967 구현 에이전트가 red 게이트를 돌려 **"이미 통과한다"고 멈추고 보고**. 그 멈춤이 없었으면 거짓 전제 위에 구현이 머지됐다. **에이전트에 "red가 통과하면 멈추고 보고" 게이트를 거는 것이 실제로 작동한다**는 증거다.

### L26 — 데이터를 넣을 때 **소비하는 코드의 규약**을 먼저 읽는다 (2026-10-12)
9호선 KRRIC 역간거리 CSV를 넣으려다 `역간거리` 컬럼 의미를 CSV만 보고 판단했다. **두 CSV가 같은 컬럼명으로 반대 의미를 쓴다.**
```
krric-seoul-metro-distance : 첫 행 청량리 = 0     →  '이전역으로부터'
9호선 CSV                  : 첫 행 개화   = 3.6   →  '다음역까지'      ← 반대
9호선 CSV 후행역간거리      : 첫 행 개화   = (빈)  →  '이전역으로부터'  ← 루프가 기대하는 것
```
`mergeLineHops`(`scripts/build-station-distances.js:214-236`)는 `recordHop(prevId, stationId, km)`로 **(이전역, 현재역)** edge에 붙인다 — 서울교통공사 규약에 맞춰 쓰였다. 내가 계산한 값(1.4/1.0/1.7)은 맞았지만 **그 루프에 넣으면 라벨이 한 칸 밀린다**. 구현 에이전트가 코드를 한 줄씩 대입해 잡았다.
→ **룰**: ①데이터 생성 작업은 **소비 루프를 먼저 트레이스**한다("이 행의 값이 어느 키에 붙는가"). ②**haversine 등 독립 지표로 라벨을 교차검증**한다 — 올바른 라벨링은 비(실측/직선) **중앙값 1.04**(`getStopDistanceMeters` 문서값과 일치), 밀린 라벨링은 0.79·2.33으로 **범위를 벗어난다**. 그 범위 가드를 테스트로 박으면 밀림을 기계적으로 잡는다. ③컬럼 의미가 소스마다 다를 수 있으므로 **per-CSV override**(`distKeys`)로 격리하고 **왜 다른지 주석에 남긴다** — 없으면 누군가 "통일"하려 지운다.

### L23 — "부품은 있는데 연결이 안 됨"이 이 레포의 지배적 결함 형태 (2026-10-12, 한 세션에 4건)
같은 날 고친 4건이 전부 **신규 기능이 아니라 미배선**이었다.
| 결함 | 이미 있던 부품 | 왜 안 쓰였나 |
| --- | --- | --- |
| #2953 알림 본문 깨짐 | `bstatnNm`(순수 역명)이 **같은 응답 옆 필드** | 파서가 `trainLineNm`을 재파싱. backend가 `bstatnNm`을 **0건 읽음** |
| #2959 1역전·매역 알림 침묵 | GPS 무관 origin(`routeOriginStation`, #2130)이 **backend로 전송 중** | device waypoint 전개는 `currentStation`만 봄 |
| #2961 탭한 열차 미전달 | device가 `payload.trainCode`를 **이미 파싱**(#2819) | `#2527` 계약이 **고정**돼 body에 없었고 `#2852`가 그대로 복사 |
| #2962 LA 버튼 | — | content state에 필드 자체가 없음(유일한 "진짜 신규") |
→ **결함 조사 1순위는 "그 정보가 이미 어딘가 있는가"다.** 새 메커니즘을 설계하기 전에 ①같은 응답/구조체의 인접 필드 ②이미 전송 중인 payload ③다른 채널이 쓰는 같은 값을 **grep으로 전수 확인**한다. 이 세션에서 내가 A→B→D로 세 번 옵션을 늘린 것도 `terminus`가 소비처 1곳인 걸 **먼저 안 봤기** 때문이다(L22와 짝).
- 진단 역질문: *"backend/device가 이 값을 이미 알고 있는데 왜 안 쓰는가?"* — 답이 "계약이 고정돼서"면 계약을 열면 끝난다. 그게 #2961이었다.

### L24 — red 재현은 "fix 파일만 되돌리기"로 한다 (2026-10-12 실행법)
에이전트의 "red였다" 주장을 검증하려 red 커밋에 새 worktree를 떼면 **`node_modules` 해석이 깨진다**(symlink로도 `jose` 미해결, backend는 자체 패키지). 작동한 방법:
```
# 에이전트 worktree(정상 node_modules 보유)에서 fix 파일만 되돌린다
git checkout <red-sha> -- <fix가 건드린 소스 3개>
npx vitest run <테스트> -t "<이름 일부>"
git checkout HEAD -- <같은 파일들>   # 복원
```
**같은 커밋에서 온 파일들로만 되돌려야** 컴파일이 깨지지 않는다(trips.ts에 추가된 export를 index.ts가 import하는 식의 상호의존). `-t` 필터는 테스트명 일부가 정확히 일치해야 하고, 안 걸리면 `--reporter=verbose`로 전체 실행 후 grep.
→ 이 방법으로 `#2963`(`expected '3001' to be '2701'`)과 `#2965`(`expected '5559' to be '2701'`)를 **직접 확인**했다. 둘 다 내 진단값과 일치했다.

### L28 — 틀린 축은 "진단 vs 설계"가 아니라 **인용 vs 해석**이다 (2026-10-13, 사용자 "진단은 왜")
오류를 "진단 0건 / 설계 6건"으로 분류해 보고했는데 **거짓이었다.** 이번 세션 진단 오류 실측: ①"9호선 경로 탐색 전면 불능"을 **미배선 함수**로 측정해 **머지된 감사 문서에 거짓 주장**(#2968 정정) ②9호선 거리 CSV 컬럼 의미 오진(라벨 밀림) ③#2953 유효성 술어가 누락 61역과 충돌 ④오늘 §1-1 "DELETE 뒤 POST 착지"를 `## 확정된 사실`에 기재.
틀린 적 **0건**인 것: 덤프/D1의 **행을 그대로 인용**(`skipped-by-shift`, `position-resolve-none`, `acc=1663m`, `404`, `200`), **file:line 인용**. 틀린 것: 그 행들을 **엮은 기전 서사**, **측정 대상 함수 선택**. → 해석은 진단 층·설계 층에서 **동일하게** 틀린다. "진단은 증거가 심판해서 안 틀린다"는 내게 유리한 오분류였다.
가장 뼈아픈 사례: §1-1에서 `GET /status → 404`를 **내 손으로 인용하고 그 옆에 "삭제 확인"이라 반대 의미의 주석**을 달았다. 데이터가 부족한 게 아니라 **있는 데이터를 서사에 맞춰 읽었다**. 실제 판별 수단은 `index.ts:3777` `if (!existing) return {deleted:false}`(부재 시에도 **idempotent 200**) + `deleted:true` 분기만 D1 trip-end를 쓴다는 사실이었고, **확인에 1분**이 걸렸다.
→ **규칙: 모든 해석 문장에 "그것을 깨뜨릴 수 있는 관측" 하나를 명시하고 실제로 확인한다.** 못 대면 그 문장은 `확정`이 아니라 `추정`으로 쓴다. 특히 **상태 코드·"없음"·0건은 그 자체로 증거가 아니다** — 그 값이 나오는 **모든 분기**를 먼저 열거한다(200이 `deleted:true/false` 둘 다에서 나오는 것처럼). [[feedback_no_unverified_premise]]의 실행 형태이고, L25(미배선 함수 측정)와 같은 뿌리다.

### L27 — 주어진 축을 전수한 것은 whole이 아니다 + "무변경" 주석은 미커버 좌표다 (2026-10-13, 사용자 "왜 또 단방향이 된건데")
같은 모양의 편측이 두 번 났다. ①**#2958 → #2963**: 주석 `index.ts:2282` *"그 경로는 100% 무변경"* 을 안전 보증으로 읽고 `releasedForLegSwitch` 게이트를 스펙에 상속 → **첫 탑승(leg-1) 알림 탭이 body trainCode를 못 쓴다**(10/13 06:27 실측 `position-resolve-none`, lock 15분 47초 지연 → 매역 알림 전멸). ②**#2673 → 10/13 유령 트립**: 주석 `useApnsTripRegistration.ts:1157` *"이 훅에는 hydration 게이트가 없어서"* 가 훅 **전체**의 결함을 선언했는데 fix는 **clear 분기만** 덮음 → register 분기가 앱 실행만으로 `POST /trips` ×2.
착각의 출처: #2963에서 사용자가 준 축(**채널** 3개 = LA·알림·수동탭)을 100% 덮고 "완결" 보고. 실제 공간은 **채널 × 트립 단계** 6칸이고 3칸(환승)만 덮였다.
→ **스펙을 쓰기 전에 2단.** ① **축 교차**: 축 1개를 받으면 교차할 두 번째 축을 작성자가 찾아 매트릭스를 채운다. 자가 점검 = *"셀 수가 주어진 축의 항목 수보다 많은가?"* 같으면 축을 못 찾은 것. ② **미커버 선언 grep**: 건드릴 파일에 `grep -nE "100% 무변경|무변경|건드리지 않|게이트가 없|범위 밖|다루지 않|이 분기는"` → 각 hit를 `유지/깨뜨림/상속` 3값 판정해 스펙에 적고, **`상속`에는 "왜 정당한가"를 반드시 쓴다**(#2963에서 썼다면 "첫 탑승은?"이 즉시 나왔다). 실측 부하 파일당 7~8건이고 두 사고의 결정적 라인이 **둘 다 걸린다**.
→ `/audit-sides` 타이밍을 **"머지 전"에서 "스펙 승인 전 필수 + 머지 전 재확인"** 으로 변경(CLAUDE.md + SKILL.md 반영). 사후 감사는 작성자가 자기 스펙을 검토하는 것이라 원리적으로 이 편측을 통과시킨다.

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
