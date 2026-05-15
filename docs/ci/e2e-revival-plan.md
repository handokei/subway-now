# E2E CI 재활성화 플랜 (#390)

## 1. 현재 상태 진단

### 1.1 빨강불의 진짜 원인
PR #383~#387에서 일관되게 동일 실패:
```
[Failed] 홈 화면 - 앱 실행 및 역 감지 (49s)
  Assertion is false: id: destination-button is visible
[Failed] 홈 화면 - 목적지 설정 (1m 11s)
[Failed] 홈 화면 - 목적지 초기화 (1m 23s)
[Failed] 홈 화면 - 취침 모드 토글 (56s)
4/4 Flows Failed
```

코드 확인 결과 `destination-button` testID는 `app/(tabs)/index.tsx:483`에 정상 존재. 실패는 selector 누락이 아니라 **렌더 자체가 안 된 것**.

### 1.2 렌더가 막힌 경로
`app/(tabs)/index.tsx`는 다음 분기가 있다:
- L254 `if (permissionDenied)` → 권한 거부 화면
- L275 `loading` → "Locating..." 스피너
- 그 외에만 destination-button 렌더

Phase 2A (#326 머지, dev에 포함) 이후 `useFusedNearestStation`은 `locationUncertain`을 더 까다롭게 판정 → 시뮬레이터의 거친 accuracy로는 영구히 `loading=true` 상태. 그래서 15s extendedWaitUntil이 항상 만료.

추가로 BG 권한 모달(#387) 등 게이트 컴포넌트가 늘면서 fresh launch에서 home content가 가려지는 빈도가 증가.

### 1.3 결론
- "GPS flake 때문에 어쩔 수 없다"는 진단은 **틀렸다**. 시뮬레이터에서 `setLocation`이 들어와도 앱이 의도적으로 그 좌표를 거절하기 때문에 결정적으로 실패한다.
- 즉 현재 E2E는 **flaky가 아니라 영구 고장**. 그래서 무시되고 있고, 무시되니 가치도 없다.

### 1.4 부수적 문제
- 시뮬레이터 선택: "사용 가능한 마지막 iPhone devicetype" → Xcode 업데이트마다 비결정적.
- 매 PR마다 `expo prebuild --clean` + pod install + xcodebuild → 매크OS 러너 5~8분 소모, 캐시 0.
- 분기점이 `if: github.event_name == 'pull_request'`만이라 push에서는 안 돌고 PR에서만 빨강불.
- `needs: test`로 묶여 있지만 CLAUDE.md 우회 정책으로 실질 게이트 효과 없음.

---

## 2. 재설계 원칙

1. **앱이 결정적이지 않으면 E2E도 결정적일 수 없다.** GPS 의존을 빌드 타임 플래그로 끊는다.
2. **smoke vs scenario 분리.** Smoke는 모든 PR에서 5분 안에 grenn/red 결정, scenario는 별도 트랙.
3. **CI는 신뢰 가능한 게이트로만 사용.** 신뢰 못 하면 차라리 비활성화하고 다시 활성화는 점진 도입.
4. **노이즈 금지.** 빨강불이 무시되는 순간 CI는 -EV다.

---

## 3. 단계별 실행 계획

### Phase 0 — 출혈 멈추기 (this PR, #390)
- [ ] `e2e` job을 `workflow_dispatch` + `nightly cron` 전용으로 분리. PR에서는 잠정 비활성화.
- [ ] CLAUDE.md의 "E2E Tests (Maestro)는 CI 환경 제약으로 실패할 수 있음" 문구 삭제 (그 정책 자체가 신호 약화의 원흉).
- [ ] 후속 이슈(Phase 1~3)를 본 이슈에서 분기.

**완료 기준**: PR이 빨강불 노이즈 없이 머지 가능. dev/main은 그대로.

### Phase 1 — E2E mock mode (#393)
앱에 `EXPO_PUBLIC_E2E_MOCK=true` 플래그 도입:
- [x] `src/constants/e2e.ts` 신규 — `IS_E2E_MOCK` 빌드타임 상수 + 강남역 고정 fixture.
- [x] `useNearestStation`이 mock 활성 시 권한/watch 흐름 우회 → 강남역(37.4980, 127.0277, accuracy 10m) 즉시 노출. 다운스트림 `useFusedNearestStation` / `useStationAlarm` / `useRouteProgress`는 자연 deterministic.
- [x] `permissionDenied`/`locationUncertain` false 고정 → 홈 화면 게이트 통과.
- [x] 프로덕션 번들에는 dead-code-eliminate (`process.env.EXPO_PUBLIC_E2E_MOCK === 'true'` 빌드 시점 상수).
- [x] 테스트 1350 통과, 커버리지 100% 유지.

**산출물**: 시뮬레이터 cold launch → 5초 내 destination-button 가시.

### Phase 2 — flow 디렉토리 재편 (별도 이슈)
```
.maestro/flows/
  smoke/        # GPS 비의존, 5분 이내, 머지 게이트
    01_app_launch.yaml
    02_destination_set_clear.yaml
    03_tab_navigation.yaml
    04_favorites_add_remove.yaml
  gps/          # setLocation 의존, nightly만
    01_near_station.yaml
    02_station_change.yaml
    03_route_locked_jump_rejection.yaml
  scenario/     # 알람·취침 등 시나리오
    01_alarm_overlay.yaml
    02_sleep_mode.yaml
```
기존 flow 4개 중 home/* 다수는 smoke로 이전(mock mode 전제).

### Phase 3 — CI workflow 재작성 (별도 이슈)
```yaml
jobs:
  test:                # 현행 유지, required
  e2e-smoke:           # PR마다 실행, required
    needs: test
    runs-on: macos-latest
    env:
      EXPO_PUBLIC_E2E_MOCK: '1'
    steps:
      - 시뮬레이터 핀: 'iPhone 16, iOS 18.2'
      - DerivedData/Pods/node_modules 캐시
      - maestro test .maestro/flows/smoke/ --retry 1
  e2e-gps:             # workflow_dispatch + cron, optional
    runs-on: macos-latest
    if: github.event_name != 'pull_request'
```

**핵심 변경**:
- 시뮬레이터 동적 탐색 제거 → 고정.
- Pods/DerivedData 캐시로 빌드 시간 1/3 수준.
- smoke만 required로 승격.

### Phase 4 — 게이트 승격 (별도 이슈)
- e2e-smoke가 2주간 안정(연속 20회 green) 확인 후 branch protection에 required check 추가.
- CLAUDE.md PR 머지 규칙을 "Type Check & Test + E2E Smoke 통과 필수"로 갱신.

---

## 4. 비용/효과

| 항목 | 현재 | 재설계 후 |
|---|---|---|
| PR마다 macOS 러너 사용 | 7~8분 (실패) | 4~5분 (캐시 hit 시) |
| 신호 가치 | 0 (무시됨) | 회귀 자동 감지 |
| 머지 차단 | Type Check만 | Type Check + Smoke |

## 5. 비결정 사항 / 결정 필요

- **Mock mode 진입점**: `useFusedNearestStation` 내부 vs Provider 레벨 vs `__mocks__` jest 스타일. → Phase 1 이슈에서 결정.
- **시뮬레이터 버전**: iOS 18.x 시리즈 어떤 마이너 버전 핀할지. → Phase 3에서 macos-14 러너 기본 가용성 확인 후 결정.
- **scenario 트랙의 알람 flow**: 알람은 notification + Live Activity로 simulator에서 검증 한계. Nightly에서도 보조 신호로만 취급하고 실기기 수동 회귀를 별도로 유지할지 결정 필요.

---

## 6. 이 PR(#390)의 스코프

오로지 Phase 0만:
1. `.github/workflows/ci.yml`에서 e2e job을 PR trigger 제외, `workflow_dispatch`만 남김.
2. CLAUDE.md "E2E Tests (Maestro)는 CI 환경 제약…" 문구 삭제.
3. 본 plan 문서 추가.
4. 후속 이슈 3개 등록(Phase 1, 2/3 묶음, 4).
