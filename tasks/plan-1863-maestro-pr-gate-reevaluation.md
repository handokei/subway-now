# Plan #1863 — F5: Phase 6 완료 후 Maestro smoke PR 게이트 격상 재평가

작성: 2026-06-26 | 이슈: #1863 | 선행: #1852 (Maestro E2E feasibility, PR #1854 머지됨)

---

## §1 사용자 가치

### 재평가 배경

PR #1854 결정 (옵션 B+C 우선, 옵션 A는 Phase 6 완료 후 재평가):

> "Phase 6.x (cold start) 개발 중 PR당 +10~20분 대기는 병렬 BG agent 워크플로에 friction."

Phase 6.1 Sub-step 1~5 모두 머지됨 (PR #1838~#1858, 2026-06-25). **재평가 선행 조건이 충족되는 시점을 명확히 정의하고, ROI를 계산할 framework를 남긴다.**

### 재평가가 중요한 이유

현재 PR 게이트 (정적 검증만) 는 다음 회귀를 **잡지 못한다**:

| 회귀 유형 | 현재 탐지 | 탐지 시점 |
| --- | --- | --- |
| prebuild drift (app.config.js 변경) | X | 사용자 로컬 `npm run ios` 시 |
| TestID 변경 (i18n locale 연동) | X | nightly 다음날 오전 |
| 탭 네비게이션 깨짐 | X | nightly 다음날 오전 |
| native crash / Pods 충돌 | X | 사용자 로컬 빌드 시 |
| Live Activity / Silent Push / 위젯 | X | **실기기 전용, 영원히 자동화 불가** |

smoke PR 게이트 격상으로 **첫 3가지** 는 PR 머지 전 차단 가능. 나머지 2개는 smoke로도 커버 불가.

---

## §2 Phase 6 완료 트리거 조건 정의

### Phase 6.1 (현재 완료됨 — 2026-06-25)

| Sub-step | PR | 상태 |
| --- | --- | --- |
| 1+2: cold start 감지 + 후보 추출 | #1838 | ✅ 머지 |
| 3: weighted narrow (시간표/즐겨찾기/barometer/최근목적지) | #1853 | ✅ 머지 |
| 4: 다중 후보 선택 UI (ColdStartCandidatePicker) | #1850 | ✅ 머지 |
| 5: mismatch 감지 + 재확인 prompt | #1855 | ✅ 머지 |

**Phase 6.1 코드 머지 기준: 완료.**

### Phase 6.1 device verify 조건 (OPEN)

| 조건 | 기준 | 현재 상태 |
| --- | --- | --- |
| 실기기 지하 cold start trip 1건 | 후보 추출 + picker UI 정상 동작 | device verify 미실행 |
| 환경 분류 unknown% 감소 확인 | 1주 nightly + D1 측정 | 미시작 |
| lockless 사용자 chain 시작율 개선 | 0~30% → 50~70% 목표 | 미측정 |

**Phase 6.1 완료 정의**: Sub-step 1~5 머지 ✅ + **실기기 지하 cold start trip 1건 통과** + **1주 nightly flakiness 0건**.

### Phase 6.2 (D1 collaborative) 범위

Phase 6.2 (D1 collaborative, 사용자 ≥10명 기반 정확도 향상) 는 별도 epic. Phase 6.2 착수 전에 재평가를 완료하는 것이 이상적이나, 재평가는 Phase 6.1 device verify + 1주 측정 이후 즉시 시행 가능.

---

## §3 재평가 트리거 조건 (Gating Criteria)

다음 조건이 **모두** 충족될 때 재평가를 시행한다:

### Gate G1 — Phase 6.1 device verify 1건

- 실기기 지하 cold start trip에서 ColdStartCandidatePicker UI 노출 + 후보 선택 → chain 시작 확인
- 담당: 사용자 (자동화 불가)

### Gate G2 — nightly flakiness 1주 0건

- `e2e.yml` 3개 job (e2e / regression / permission-matrix) 연속 7일 pass
- 측정: GitHub Actions `e2e.yml` run history
- 판단 기준: flakiness rate ≤ 5% (7일 중 1회 이하 실패, 환경 문제 제외)

### Gate G3 — smoke 6개 시뮬레이터 로컬 pass 확인

- `EXPO_PUBLIC_E2E_MOCK=1` 빌드 + `maestro test .maestro/flows/smoke` 로컬 실행 결과 6/6 pass
- 목적: PR 게이트 격상 전 결정적 동작 검증

### Gate G4 — 측정 1주 완료

- Phase 6.1 병합 후 D1 / DebugModal 에서 environment=unknown% 감소 확인
- lockless miss 0 달성 측정 (Epic #1745 측정 인프라 연계)

**재평가 시행 시점**: G1 + G2 + G3 + G4 모두 pass 후. 예상: Phase 6.1 device verify 시점 + 7일 후.

---

## §4 ROI 재계산 Framework

### 비용 항목 (옵션 A 격상 시)

| 항목 | 값 | 산출 기준 |
| --- | --- | --- |
| macos-14 runner 단가 | $0.08/분 (GitHub 현행) | GitHub Actions pricing |
| smoke 1회 실행 시간 (Pods 캐시 hit) | ~8분 | e2e.yml `timeout-minutes: 60`, 실측 필요 |
| smoke 1회 실행 시간 (캐시 miss) | ~20분 | DerivedData cold build 실측 필요 |
| PR당 macos-14 비용 (캐시 hit) | ~$0.64 | 8분 × $0.08 |
| PR당 macos-14 비용 (캐시 miss) | ~$1.60 | 20분 × $0.08 |
| 월 PR 수 (평균) | **실측 필요** | `gh pr list --state merged` 1개월 집계 |

### 편익 항목 (smoke PR 게이트 격상 시 차단 가능한 회귀 가치)

| 회귀 유형 | 탐지 시 사용자 비용 | 발생 빈도 (지난 3개월) | 기대 편익 |
| --- | --- | --- | --- |
| prebuild drift (app.config.js 변경) | 로컬 빌드 실패 + 수정 30~60분 | PR #949 등 이력 참조 | **실측 필요** |
| TestID 변경 → nightly fail | 다음날 오전 발견 + hotfix PR | #1230 이력 참조 | 실측 필요 |
| 탭 네비게이션 깨짐 | 다음날 발견 + EAS 재빌드 위험 | 드묾 | 낮음 |

### ROI 수식

```
ROI = (편익 - 비용) / 비용

편익 = 연간 회귀 차단 수 × 회귀 1건당 평균 복구 비용(분) × 엔지니어 분당 단가
비용 = 월 PR 수 × 12 × smoke 실행 시간(분) × macos-14 분당 단가

손익분기점 회귀 수 = 비용 / 회귀 1건당 복구 비용
```

**재평가 시 채워야 할 실측 값**:

| 변수 | 측정 방법 |
| --- | --- |
| 월 PR 수 | `gh pr list --state merged --json mergedAt` → 1개월 집계 |
| smoke 실행 시간 (캐시 hit) | `e2e.yml` workflow_dispatch 직접 실행 + step 시간 측정 |
| smoke 실행 시간 (캐시 miss) | 새 runner에서 cold build 실측 |
| 지난 3개월 회귀 건수 | `gh issue list --label "fix"` + 커밋 이력 |

**재평가 시 기준 ROI**:
- ROI ≥ 3.0 → 옵션 A (smoke PR 게이트 격상) 권장
- 1.0 ≤ ROI < 3.0 → 옵션 B (nightly 강화) 유지 권장
- ROI < 1.0 → 옵션 E (현 상태 유지)

---

## §5 옵션 매트릭스 (재평가 시 선택지)

### 옵션 A: smoke 6개 PR 게이트 격상 (단독)

- **내용**: `.github/workflows/ci.yml`에 `smoke` job 추가. macos-14 runner.
- **조건**: `EXPO_PUBLIC_E2E_MOCK=1` 빌드 분기 → GPS/권한 mock 단락.
- **비용**: PR당 ~$0.64~$1.60. 빌드 시간 +8~20분.
- **커버리지**: prebuild drift, UI TestID 변경, 탭 네비게이션 → PR 게이트에서 차단.
- **한계**: gps/regression/permissions는 여전히 nightly. LA/push/위젯 여전히 X.
- **활성화 threshold**: G1 + G2 + G3 + G4 all pass + ROI ≥ 3.0.

### 옵션 A+: smoke + scenario PR 게이트 격상 (확장)

- **내용**: smoke 6개 + scenario 5개를 PR 게이트에 포함.
- **비용**: PR당 ~12~25분.
- **커버리지**: 옵션 A 커버리지 + 알람 foreground/overlay/map/dark mode 시나리오.
- **한계**: regression 10개 / permission-matrix 13개는 여전히 nightly (실행 시간 과다).
- **활성화 threshold**: 옵션 A 안정화 1개월 후.

### 옵션 B+: nightly 강화 (현재 부분 진행 중)

- **내용**: nightly에 `manual/` 중 시뮬레이터 가능한 시나리오 이관.
  - `trip_transfer_autolock.yaml` — mock GPS로 시뮬레이터에서 boarding-lock-hop-card 검증 가능성 검토
  - `trip_sticky_subsurface.yaml` — mock barometer fixture 대체 가능성 검토
- **비용**: 이관 검토 공수 (별 이슈). nightly 실행 시간 +5~10분.
- **커버리지**: PR 게이트 변화 없음. 다음날 오전 회귀 탐지.
- **적합 시나리오**: G2 (nightly flakiness) 불안정 시 옵션 A 대신 선택.

### 옵션 C+: fixture runner 확장 (현재 진행 중)

- **내용**: Phase 6.x cold start 경로를 fixture chain runner에 추가.
  - `cold-start-candidate-extracted` stage
  - `cold-start-picker-selected` stage
  - mismatch-detected stage
- **비용**: fixture 확보 공수 (Phase 6.2 PR 포함).
- **커버리지**: chain 논리 + environment classification. UI 회귀 탐지 X.
- **한계**: UI TestID 변경, prebuild drift 탐지 불가.

### 옵션 E: 현 상태 유지 (변경 없음)

- **조건**: G2 (nightly flakiness) 불안정 지속 시, 또는 Phase 6.2 개발 집중 필요 시.
- **비용**: 0.
- **리스크**: prebuild drift 탐지 지연 지속.

### 요약 매트릭스

| 옵션 | PR 게이트 추가 커버리지 | PR당 추가 비용 | 권장 조건 |
| --- | --- | --- | --- |
| A: smoke PR 게이트 | prebuild drift + UI TestID | $0.64~$1.60 | ROI ≥ 3.0 + G1~G4 all pass |
| A+: smoke+scenario | A + 알람 시나리오 5개 | ~$1.50~$3.00 | A 안정화 1개월 후 |
| B+: nightly 강화 | 없음 (nightly만) | 0 | G2 불안정 시 |
| C+: fixture 확장 | 없음 (unit) | 0 | Phase 6.2 fixture PR 포함 |
| E: 현 상태 유지 | 없음 | 0 | Phase 6.2 집중 필요 시 |

---

## §6 재평가 절차 (Step-by-step)

재평가 시점 도달 시 다음 순서로 진행한다:

```
Step 1: 월 PR 수 실측
  → gh pr list --state merged --json mergedAt --limit 100 | jq 집계

Step 2: smoke 실행 시간 실측
  → workflow_dispatch 수동 실행 → step 시간 측정

Step 3: ROI 계산
  → §4 수식 대입 → ROI 판정

Step 4: 옵션 선택 (사용자 결정)
  → ROI ≥ 3.0 → 옵션 A PR 생성
  → ROI < 3.0 → 옵션 B+ 또는 E 유지

Step 5 (옵션 A 선택 시): ci.yml에 smoke job 추가 PR
  → .github/workflows/ci.yml 에 macos-14 smoke job 추가
  → EXPO_PUBLIC_E2E_MOCK=1 빌드 분기 확인
  → 1주 false-positive rate 측정 후 완전 격상
```

---

## §7 CI 격상 시 구현 스케치 (옵션 A 선택 시)

**격상 시에만 구현. 본 PR에서 코드 변경 없음.**

```yaml
# .github/workflows/ci.yml 에 추가할 job (옵션 A 격상 시)
smoke:
  name: "CI / Maestro Smoke"
  runs-on: macos-14
  timeout-minutes: 25
  needs: []  # type-check, test와 병렬
  env:
    EXPO_PUBLIC_E2E_MOCK: "1"
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
        cache: 'npm'
    - run: npm ci
    # DerivedData 캐시 (Podfile.lock + package-lock.json + modules/**)
    - uses: actions/cache@v4
      with:
        path: ~/Library/Developer/Xcode/DerivedData
        key: dd-smoke-${{ hashFiles('ios/Podfile.lock', 'package-lock.json', 'modules/**') }}
    - uses: actions/cache@v4
      with:
        path: ios/Pods
        key: pods-smoke-${{ hashFiles('ios/Podfile.lock') }}
    - name: iOS prebuild (mock 분기)
      run: npx expo prebuild --platform ios --clean
    - name: CocoaPods install
      run: cd ios && pod install --repo-update
    - name: xcodebuild (simulator)
      run: |
        xcodebuild -workspace ios/subwaynow.xcworkspace \
          -scheme subwaynow \
          -configuration Debug \
          -destination "platform=iOS Simulator,name=iPhone 16" \
          -derivedDataPath ~/Library/Developer/Xcode/DerivedData \
          CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO \
          build 2>&1 | tail -20
    - name: 시뮬레이터 부팅
      run: |
        xcrun simctl boot "iPhone 16" || true
        open -a Simulator
    - name: 앱 설치
      run: xcrun simctl install booted ~/Library/Developer/Xcode/DerivedData/**/Build/Products/Debug-iphonesimulator/*.app
    - name: Maestro smoke 실행
      run: |
        "$HOME/.maestro/bin/maestro" \
          --device "$(xcrun simctl list devices booted -j | jq -r '.devices | to_entries[] | .value[] | select(.state=="Booted") | .udid' | head -1)" \
          test .maestro/flows/smoke \
          --format junit \
          --output maestro-smoke-results.xml
    - name: 결과 업로드
      uses: actions/upload-artifact@v4
      if: always()
      with:
        name: maestro-smoke-results
        path: maestro-smoke-results.xml
```

**주의사항 (격상 시 반드시 확인)**:
1. `EXPO_PUBLIC_E2E_MOCK=1` 빌드가 `npm run ios` 와 동일한 mock 분기를 타는지 확인
2. smoke 시나리오 6개 모두 `testId` 매처 사용 여부 확인 (text 매처는 i18n locale 의존 — #1230 이력)
3. DerivedData 캐시 키가 `modules/**` 포함 여부 확인 (native 모듈 변경 시 invalidation 필요)
4. `macos-14` → `macos-15` 전환 시 runner 비용 재계산 필요

---

## §8 Acceptance + Wire-completion 5단

### Acceptance 체크리스트

- [x] §2 Phase 6 완료 트리거 조건 명시 (Sub-step 1~5 머지 ✅ + device verify + 1주 nightly)
- [x] §3 재평가 트리거 조건 4개 gate (G1 device verify / G2 nightly 1주 0건 / G3 smoke 로컬 pass / G4 1주 측정)
- [x] §4 ROI 재계산 framework (수식 + 실측 변수 + 판정 기준)
- [x] §5 옵션 매트릭스 5개 (A / A+ / B+ / C+ / E) — false binary 차단
- [x] §6 재평가 절차 (Step 1~5, 사용자 결정 포함)
- [x] §7 격상 시 구현 스케치 (코드 변경 없음, 참조용)
- [x] §8 Wire-completion 5단

### Wire-completion 5단

1. **Orphan**: 코드 변경 없음 (plan only). `npm run lint:orphan` N/A.
2. **V/X dashboard**: 이 PR은 재평가 framework + plan doc. 측정 대상 없음 — N/A.
3. **의존 PR**: #1854 (Maestro E2E feasibility) 머지됨 (independent).
4. **측정 plan**: G1~G4 gate 조건 달성 시 §4 ROI 수식 실측값 채워서 §6 Step 3 실행.
5. **Device verify**: N/A — plan only. 코드 변경 없음.

---

## §9 관련 메모리 / 참조

- `feedback_e2e_local_gate.md` — mock+smoke 재활성화 진행 중
- `feedback_ci_gate_includes_e2e.md` — Type Check & Test + Data Validation + SonarCloud 3개
- `lesson_expo_native_config_drift.md` — app.config.js 변경 시 expo prebuild → smoke PR 게이트가 이를 차단
- `feedback_chain_validation_not_measurement.md` — 실기기 trip 1회 = chain 검증. 측정 부산물
- `plan-1852-maestro-e2e-feasibility.md` — §6 결정: 옵션 B+C 우선, A는 Phase 6 완료 후 재평가

---

## 결론 요약

| 항목 | 값 |
| --- | --- |
| Phase 6.1 코드 완료 | ✅ 2026-06-25 (PR #1838~#1858) |
| 재평가 시행 조건 | G1 device verify + G2 nightly 1주 + G3 smoke 로컬 + G4 측정 1주 |
| 예상 재평가 시점 | Phase 6.1 device verify + 7일 후 (2026-07-03 이후) |
| ROI 판정 기준 | ≥ 3.0 → 옵션 A / 1.0~3.0 → 옵션 B+ / < 1.0 → 옵션 E |
| 격상 시 추가 CI 비용 | PR당 ~$0.64~$1.60 (캐시 hit 기준) |
| 격상으로 차단 가능한 회귀 | prebuild drift + UI TestID 변경 + 탭 네비게이션 깨짐 |
| 격상으로 차단 불가한 회귀 | LA / silent push / 위젯 (실기기 전용, 영구적) |
