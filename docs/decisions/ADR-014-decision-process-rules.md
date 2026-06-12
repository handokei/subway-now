# ADR-014 — 결정 프로세스 룰 (Decision Process Rules)

## 상태

Accepted (2026-06-12)

## 배경 — 사용자 가치 narrow-down 사고

2026-06-11 하루에 Epic #1008 B1~B14 차단 항목 6개가 일괄 채택됨. 다음 날(2026-06-12) 사용자 trip이 모든 acceptance 격자 사이로 빠져나가 큰 사용자 가치 손실 발생.

### 사고 evidence (2026-06-12)

오전 trip e25e1158 (lockless, 7-stop): 용마산 → 중곡 → 군자 → 어린이대공원 → 건대입구(7) → 건대입구(2) 환승 → 성수

사용자 보고 11건 + Silent push 14 received / 0 fire + backend trip auto-end.

### 4단계 narrow-down 메커니즘

| 시점 | 결정 | misalign |
|---|---|---|
| 2026-06-11 | Epic #896 close (PR 머지 기준) | 본문 evidence 시나리오가 acceptance에 없음 |
| 2026-06-11 | Epic #1008 §7.1 회귀 7개 lock 활성 한정 | "이미 머지된 sub-issue" 기준 회귀 정의 → lockless 회귀 누락 |
| 2026-06-11 | ADR-013 B3 — lockless 면제 | "강제 100% vs 면제" false binary → 사용자 면제 선택 → ADR-010 첫 줄 위반 |
| 2026-06-11 | B1 — C 토글 "정보용" 격하 | 정확성 게이트 의무 면제 |

**진짜 원인**: AI(이전 세션)가 결정 옵션 제시 시 **"현재 코드 능력 범위" 기준으로 옵션을 좁힘**. "정확성 게이트 보강 (신규 작업 필요)" 같은 제3의 옵션이 결정 테이블에 없어 사용자가 false binary에 갇혀 면제 선택.

→ **단기 코드 상태가 acceptance를 정의함**. ADR-010 첫 줄 "두 실패 모드 동급" 원칙이 acceptance까지 못 내려옴.

## 결정

### 1. 결정 옵션 제시 룰 — false binary 금지

사용자 가치 결정 PR (B1~BN 같은 일괄 차단 항목) 제시 시:

- **각 항목에 최소 3개 옵션 보장.** 강제 적용 vs 완전 면제 두 옵션만 제시 금지
- **"현재 코드 능력 밖" 옵션 반드시 1개 이상 포함**. "지금 만들 수 있는 것" 기준으로 옵션 누락 금지
- 옵션 점검 체크리스트:
  1. 강제 적용 옵션 (현 코드)
  2. 완전 면제 옵션 (사용자 선택 영역으로 분류)
  3. **정확성/안전 게이트 보강 옵션 (신규 작업 X주)**
  4. 부분 적용 옵션 (특정 조건만)

**자가 점검**: "사용자가 한쪽 극단 선택 시 ADR 첫 줄 원칙 위반하는가?" → Yes면 옵션 누락.

**잘못된 제시 예시 (2026-06-11 B3):**
```
1. lockless 매역 100% 강제 → false positive 폭증
2. lockless 면제 (사용자 선택) → miss 허용
```

**올바른 제시:**
```
1. lockless 100% 강제 → false positive 폭증 (현 코드)
2. 정확성 게이트 보강 후 100% → hop window + estimator cascade + sticky 유지 (신규 2주)
3. lockless 면제 (사용자 선택) → miss 허용, ADR-010 첫 줄 위반
4. 부분 적용 → C 토글 ON일 때만 100% 보장
```

### 2. Epic close 조건 룰 — PR 머지 ≠ close

Epic close 조건에 다음 둘 중 하나 필수:

1. **본문 evidence 시나리오 실기기 1주 재발 0건** (좁은 시나리오)
2. **1주 production 측정 회귀 카운트 0건** (넓은 측정)

- Epic 본문에 "evidence" 또는 "재현 시나리오"가 있으면 acceptance 첫 항목으로 끌어옴
- "Seam A~G 7개 PR 머지" 같은 양 기반 acceptance는 진행 척도일 뿐 close 기준 아님
- Epic 본문 Goal/요구사항이 명시한 사용자 가치가 acceptance에 1:1 매핑되지 않으면 close 금지

**자가 점검**: "epic 본문 evidence가 acceptance에 1:1 매핑되는가?"

### 3. Acceptance 정의 순서 룰 — 사용자 가치 우선

- **사용자 가치 → acceptance → 코드 (작업 정의)** 순서
- "이미 머지된 sub-issue" 또는 "현재 코드 능력 범위" 기준 acceptance 금지
- Acceptance가 코드를 정의해야지, 코드가 acceptance를 정의하면 안 됨

**회귀 정의 점검 5가지**:
1. lock 활성 / lockless 둘 다 카테고리에 들어 있는가?
2. 사용자 명시 의향(C 토글 ON / boardingPrompt 응답 / 직접 탭) trip이 lock 활성과 동급으로 다뤄지는가?
3. ADR 첫 줄 원칙(예: ADR-010 "두 실패 모드 동급")이 acceptance까지 적용되는가?
4. 권한 매트릭스(WhileInUse/Always × FG/BG/취침) 모두 커버?
5. 환경 매트릭스(지하/지상/환승) 모두 커버?

새 sub-issue가 acceptance를 만족하지 못하면 그 sub-issue를 발행. **acceptance를 좁히지 않음**.

### 4. 사용자 명시 의향 trip 동급 보장 룰

**사용자 명시 의향 정의**:
- C 토글(`locklessStationPassed=true`) ON 상태에서 trip 활성
- boardingPrompt push [탑승] 응답
- BoardingTrainList에서 사용자 직접 탭
- 목적지 설정 + 경로 등록

**원칙**:
- 사용자 명시 의향 trip은 **lock 활성 trip과 동급 정확도 보장 의무**
- "정보용 토글" 라벨은 UI 텍스트로만 사용. acceptance/회귀 게이트는 동급
- 사용자 명시 의향 trip에서 잘못된 역 알람 = 회귀. 정의에 명시

**금지 표현**:
- "사용자 선택 영역 → acceptance 위반 아님"
- "정보용 토글이라 정확성 게이트 의무 없음"
- "best effort"

**권장 표현**:
- "사용자 명시 의향 trip은 lock 활성과 동급 정확도 보장"
- "C 토글 ON / boardingPrompt 응답 / 직접 탭 → station-passed에 trip 진행도 게이트 + estimator cascade + sticky 유지 동일 적용"

### 5. ADR 첫 줄 원칙 적용 룰

ADR의 첫 줄("배경" 또는 "결정" 첫 문장)에 명시된 원칙은 그 ADR이 다루는 **모든 acceptance / 회귀 정의 / 결정 옵션**에 끝까지 적용된다.

ADR 첫 줄 원칙을 한 영역에서만 면제하는 결정 (예: ADR-010 첫 줄 "두 실패 모드 동급" → B3에서 lockless miss 면제)은 ADR 위반.

**자가 점검**: 결정 PR 머지 전 "본 결정이 어느 ADR의 첫 줄 원칙을 어디서 면제하는가?" → 면제 발견 시 결정 다시.

## 적용 범위

- Epic #1008 / #912 / #896 등 모든 epic의 close 조건 + acceptance 정의
- 일괄 결정 PR (B1~BN, RC1~RCN, 또는 유사 차단 항목)
- ADR-010 / ADR-013 / 신규 ADR
- sub-issue 발행 시 acceptance 정의

## Follow-ups

1. **Epic #1008 §7.1 회귀 7개 → 12개 확장 PR** — 회귀 8~12 (lockless over-fire / 지하 GPS sticky / 환승 trainCode 상실 / silent push fire=0 / 환승 leg autoLock) 추가
2. **ADR-013 B3 면제 폐기 PR** — "lockless trip 게이트 미통과 = 위반 아님" 삭제, "사용자 명시 의향 trip 동급 보장" 추가
3. **Epic #896 reopen 또는 후속 epic** — close 조건에 본문 evidence 시나리오 실기기 재발 0건 추가
4. **B1 C 토글 정의 갱신** — "정보용 토글" 텍스트 유지 + "정확성 게이트는 lock 활성과 동급 적용" 명시
5. **결정 PR 템플릿 추가** — 옵션 3개 이상 자동 점검 체크리스트 포함

## References

- ADR-010 §배경 첫 줄 — "두 실패 모드는 비대칭이 아니라 동급"
- ADR-013 §B3 — 본 ADR로 면제 폐기 대상
- Epic #1008 SSOT (`tasks/epic-lockless-overfire-guard.md`)
- Memory:
  - `lesson_2026_06_11_b3_false_binary.md` — 사고 evidence
  - `feedback_decision_no_false_binary.md` — 룰 1
  - `feedback_epic_close_field_verify.md` — 룰 2
  - `feedback_acceptance_drives_code.md` — 룰 3
  - `feedback_user_intent_equal_protection.md` — 룰 4
- `tasks/lessons.md` L1~L4

## 변경 이력

- 2026-06-12: 신규 작성 (2026-06-11 narrow-down 사고 + 2026-06-12 사용자 trip 11건 손실 evidence)
