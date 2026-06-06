# Maestro 권한 매트릭스 (#923 E2)

매역 알림 100% epic(#912)의 회귀 가드. iOS Always vs WhileInUse, iOS 17/18,
Android, FG/BG, 지상/지하, 일반/취침 등 권한·환경 조합별로 매역 알람 발사 경로가
의도대로 동작하는지 검증한다.

## 구성

- `scripts/permission-matrix.json` — 매트릭스 정의(cell × expected). 데이터 주도.
- `scripts/permission-matrix-runner.js` — JSON을 읽어 cell 단위로 maestro 실행.
- `.maestro/flows/permissions/<cell-id>.yaml` — cell별 Maestro flow.

## 현재 PR 범위 (E2 첫 PR + 후속)

| cell id | permission | appState | environment | mode | os | 비고 |
| --- | --- | --- | --- | --- | --- | --- |
| `whileInUse-fg-aboveground-normal-ios18` | WhileInUse | FG | 지상 | 일반 | iOS 18 | baseline (첫 PR) |
| `always-fg-aboveground-normal-ios18` | Always | FG | 지상 | 일반 | iOS 18 | 권한 대조군 |
| `whileInUse-fg-aboveground-sleep-ios18` | WhileInUse | FG | 지상 | 취침 | iOS 18 | 권한↓ + 취침 결합 |
| `always-fg-aboveground-sleep-ios18` | Always | FG | 지상 | 취침 | iOS 18 | SLA 정본 조합 |
| `always-bg-aboveground-normal-ios18` | Always | BG | 지상 | 일반 | iOS 18 | BG 차원 첫 진입 (2차 wave) |
| `whileInUse-fg-aboveground-normal-ios17` | WhileInUse | FG | 지상 | 일반 | iOS 17 | iOS 17 차원 첫 진입 (2차 wave) |
| `always-fg-aboveground-normal-android` | Always | FG | 지상 | 일반 | Android | Android 플랫폼 첫 진입 (2차 wave) |
| `always-fg-underground-normal-ios18` | Always | FG | 지하 | 일반 | iOS 18 | underground 차원 첫 진입 (3차 wave) |
| `always-bg-aboveground-sleep-ios18` | Always | BG | 지상 | 취침 | iOS 18 | BG × sleep 결합 첫 진입 (3차 wave) |
| `always-bg-underground-normal-ios18` | Always | BG | 지하 | 일반 | iOS 18 | BG × underground 결합 첫 진입 (3차 wave) |
| `always-bg-underground-sleep-ios18` | Always | BG | 지하 | 취침 | iOS 18 | SLA 최난도 결합(Always+BG+지하+취침) 첫 진입 (4차 wave) |
| `whileInUse-bg-aboveground-normal-ios18` | WhileInUse | BG | 지상 | 일반 | iOS 18 | WhileInUse × BG 결합 첫 진입 (4차 wave) |
| `whileInUse-fg-underground-normal-ios18` | WhileInUse | FG | 지하 | 일반 | iOS 18 | WhileInUse × underground 결합 첫 진입 (4차 wave) |

후속 PR에서 추가될 cell (`scripts/permission-matrix.json`의 `cells` 배열에
entry만 추가하면 runner와 CI matrix가 자동으로 픽업):

- E2E mock fixture 확장 — `*-underground-*` cell이 강남(지상) 대신 지하역(예: 신도림)을
  반환하도록 분기. 현재 underground cell은 GPS dispatch만 검증(dispatch-only).
- WhileInUse × BG × sleep / WhileInUse × underground × sleep / WhileInUse × BG × underground
  등 권한↓ × 가혹 환경 추가 결합
- iOS 17 / Android cell의 실제 시뮬레이터/디바이스 부팅 분기 (현재는 iOS 18 시뮬에서 권한 dispatch만 검증)
- 실측 recall 측정 (`expectedRecallPct` placeholder → 실측치)

## 로컬 실행

```bash
# E2E mock 모드로 시뮬레이터 빌드 + 설치 (smoke와 동일)
EXPO_PUBLIC_E2E_MOCK=1 npm run ios

# baseline cell만 실행
node scripts/permission-matrix-runner.js --baseline

# 특정 cell만
node scripts/permission-matrix-runner.js --cell whileInUse-fg-aboveground-normal-ios18

# cell 목록 확인
node scripts/permission-matrix-runner.js --list

# 명령만 출력(시뮬레이션)
node scripts/permission-matrix-runner.js --dry-run
```

## 새 cell 추가 절차

1. `.maestro/flows/permissions/<cell-id>.yaml` 작성 (본 README의 baseline flow 템플릿 사용).
2. `scripts/permission-matrix.json`의 `cells` 배열에 entry 추가:
   ```jsonc
   {
     "id": "always-bg-underground-sleep-ios18",
     "permission": "always",
     "appState": "bg",
     "environment": "underground",
     "mode": "sleep",
     "os": "ios18",
     "expectedRecallPct": 90,
     "flow": "always-bg-underground-sleep-ios18.yaml"
   }
   ```
3. CI(`.github/workflows/e2e.yml`)의 `permission-matrix` job matrix에 cell id 추가.
4. runner와 flow는 추가 수정 불필요 (데이터 주도).

## CI

`.github/workflows/e2e.yml`의 `permission-matrix` job이 nightly로 실행한다.
첫 PR에서는 baseline 1셀만 matrix에 등록. PR 게이트 아님(nightly only).

## 이번 PR 제외

- 나머지 15+ cell flow (후속 PR에서 추가)
- Slack 알림
- 실측 recall 측정(`expectedRecallPct`는 baseline placeholder)
- Always BG / 지하 / 취침 모드 차원 변동
