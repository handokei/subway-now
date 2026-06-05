# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 프로젝트 개요
GPS 기반으로 현재 탑승 중인 지하철역을 실시간으로 감지하는 React Native(Expo) 모바일 앱.
홈 화면 위젯, 노선 정보, 즐겨찾기, 경로 탐색, 취침 모드 알람 기능을 포함한다.

**기술 스택**: React Native + Expo 54 + TypeScript, Zustand, expo-location + expo-task-manager, expo-notifications, expo-router 6

---

## Agent skills

### Issue tracker

GitHub Issues (`handokei/subway-now`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `docs/adr/` at repo root. See `docs/agents/domain.md`.

---

## 개발 명령어

```bash
npm start             # Expo 개발 서버 시작
npm run ios           # iOS 시뮬레이터 실행
npm run android       # Android 에뮬레이터 실행
npm test              # 전체 테스트 + 커버리지 리포트 (100% 미달 시 실패)
npm run test:watch    # 파일 변경 감지 테스트
npm run type-check    # TypeScript 타입 오류 확인
```

**단일 테스트 실행:**
```bash
npx jest src/hooks/__tests__/useNearestStation.test.ts
npx jest --testNamePattern="should return nearest station"
```

**빌드 & 배포:**
```bash
eas build --profile production --platform ios    # 프로덕션 빌드 (buildNumber 자동 +1)
eas build --profile development --platform ios   # 개발 빌드 (실기기 테스트)
eas submit --platform ios --latest               # TestFlight 업로드
```

### 버전/빌드 번호 관리 정책

| 값 | 의미 | 출처 (SSOT) | 변경 방법 |
| --- | --- | --- | --- |
| `version` (CFBundleShortVersionString) | 마케팅 버전 (예: 1.2.2) | `package.json` | 새 chore 이슈 → `npm version patch/minor/major` |
| `ios.buildNumber` (CFBundleVersion) | iOS 빌드 번호 | **EAS Remote** | production 빌드 시 자동 +1 |
| `android.versionCode` | Android 빌드 번호 | **EAS Remote** | production 빌드 시 자동 +1 |

- `eas.json`: `appVersionSource: "remote"` + production 프로파일 `autoIncrement: true`.
- `development` / `preview` 프로파일은 autoIncrement 미적용 → remote 마지막 값 재사용 (테스트 빌드가 production 카운터를 소진하지 않음).
- `app.config.js`에는 `buildNumber` / `versionCode`를 두지 않는다. (remote 모드에서 무시되며 혼란만 유발)

### EAS Remote Version 운영 명령

```bash
eas build:version:get --platform ios       # 현재 remote 값 확인
eas build:version:set --platform ios       # 값 강제 지정 (예외 상황)
eas build:version:sync                     # 로컬 → remote 동기화
```

### 1회성 마이그레이션 절차 (`appVersionSource: "local"` → `"remote"` 전환 시점)

**중요: 이 절차는 PR `chore/#363` 머지 직후 단 한 번만 실행.**

```bash
# 1) 현재 remote 상태 확인
eas build:version:get --platform ios
eas build:version:get --platform android

# 2) remote가 비어 있거나 직전 출시값(iOS 43, Android 1) 이하라면 baseline 명시 지정
#    autoIncrement는 (remote 값) + 1 부터 발급하므로 안전치로 +1 해서 set
eas build:version:set --platform ios       # 값: 44
eas build:version:set --platform android   # 값: 2

# 3) 첫 production 빌드로 검증 (buildNumber가 45, versionCode가 3으로 찍혀야 정상)
eas build --profile production --platform ios
```

이 절차를 건너뛰면 autoIncrement 결과가 App Store 기존 빌드 번호 이하로 떨어져 다시 거부될 수 있다.

---

## 아키텍처

### 데이터 흐름
```
GPS (expo-location)
  → useNearestStation (30s 폴링, 500m 반경 내 최근접 역 탐색)
    → haversine.ts (거리 계산)
    → stations.json (서울 지하철 528개 역 좌표)
  → useArrivalInfo (30s 폴링, Seoul Open API 호출)
    → Provider 패턴 (BffArrivalProvider / SeoulOpenApiProvider / MockProvider)
  → useStationAlarm (경로 기반 환승/도착 알람)
    → stationNotification.ts (Live Activity + 푸시 알림)
```

### 레이어 구조 (Feature-based + Ports & Adapters, ADR Phase 5)
ADR "Feature-based + Ports & Adapters 디렉토리 재정비" (https://app.notion.com/p/36e30c0194b68148ba29f2bc4554ce8a) 적용.
의존 방향: `app/` → `src/features/*` → `src/shared/*`. features 끼리는 ESLint(`import/no-restricted-paths`)로 직접 import를 차단한다.

- **`src/features/<slice>/`** — 도메인별 슬라이스. 각 슬라이스는 자체 `api/`, `hooks/`, `components/`, `utils/`, `tasks/`, `providers/`, `store/` 등을 내부에 둔다.
  - `alarm/` — 알람·BoardingLock·silent push
  - `arrival/` — 실시간 도착 정보
  - `nearest-station/` — GPS 기반 최근접 역 탐색 + fusion
  - `route/` — 경로 탐색·환승·trip 진행
  - `map/` — 지도 화면(Kakao Maps WebView)
  - `widget/` — iOS 홈 위젯 데이터 게이트웨이
  - `settings/` — 설정·언어·취침모드
  - `debug/` — DebugModal (cross-feature observer)
- **`src/shared/`** — 모든 features가 공유하는 공통 인프라.
  - `types/` — 도메인 type (`station`, `arrival`, `boardingLock`, `fusion`, `journey`, `position`, `providers`, `exitSide`, `alarm` 등)
  - `utils/` — 순수 함수 (`haversine`, `stationRoute`, `stationLookup`, `stationDisplay`, `stationEta`, `logger`, `formatTime`, `ttlCache`, `normalizeStationName`, `apnsEnv`, `barometer*`)
  - `hooks/` — 공용 hook (`usePolling`, `useCountdown`, `useBarometer`)
  - `ui/` — 공용 컴포넌트 (`ScreenContainer`, `Card`, `LineBadge`, `SectionHeader`, `Toast`, `ActionBanner`, `LocationStateView`)
  - `theme/` — 테마 시스템 (`ThemeProvider`, `useTheme()`)
  - `constants/` — 상수 (`lineColors`, `lineApiNames`, `storageKeys`, `trainTypes`, `arrivalCodes`, `eta`, `labels`, `debugFlags`, `gpsStatus`, `trainStatus`, `barometer`)
  - `i18n/` — i18next 설정 + locales(ko/en/ja/zh)
  - `infra/` — Adapter 구현 (`location/Expo*`, `notification/Expo*`, `storage/AsyncStorage*`, `storage/SharedGroup*`)
  - `ports/` — Adapter가 구현하는 추상 인터페이스 (`LocationPort`, `NotificationPort`, `WidgetStoragePort`)
- **`src/store/useAppStore.ts`** — Zustand 전역 상태 (즐겨찾기, 목적지, 취침모드 등). AsyncStorage 영속화. favorites slice 분해는 ADR Phase 5 follow-up.
- **`src/testUtils/`** — 테스트 유틸리티 (`renderWithTheme`, `fixtures`, `routeFixtures`, `i18nLanguageOverride`)
- **`modules/`** — 네이티브 모듈 (`live-activity`, `audio-route`, `motion-activity`)
- **`targets/`** — `subway-widget` (iOS 홈 위젯)

### 테마 시스템
- `ThemeProvider` (`src/shared/theme/ThemeContext.tsx`)가 `app/_layout.tsx`에 마운트
- `useColorScheme()`으로 OS 다크모드 자동 감지
- 라이트: Editorial Light (B) — 크림톤(`#F5F2EC`) + 어스레드(`#C8553D`)
- 다크: C · Focus — 퓨어블랙(`#0A0A0A`) + 라임그린(`#C8E600`)
- 모든 컴포넌트가 `useTheme()`으로 동적 색상 참조 (정적 `colors` import 금지)
- StyleSheet.create는 레이아웃 전용, 색상은 인라인 `[layout, { color: colors.xxx }]`

### 지도 구현
- `src/features/map/utils/buildMapConfig.ts`로 HTML 생성 → `WebView`에 주입 (Kakao Maps SDK)
- `MarkerClusterer`로 528개 역 마커 성능 최적화 (자동 클러스터링)
- SDK 로드 실패 시 `window.onerror` → RN fallback UI 표시
- 웹 플랫폼은 `src/features/map/components/StationMap.web.tsx`로 별도 구현

### iOS 위젯 & Live Activity
- `src/features/widget/api/widgetStorage.ts`가 App Groups → SharedGroupPreferences에 현재 역 정보 저장
- `modules/live-activity/` — iOS Dynamic Island + Lock Screen Live Activity

---

## GitHub 워크플로우 (필수 준수)

### 브랜치 전략
- **`main`**: 운영 전용 — 직접 커밋 금지, `dev → main` PR로만 반영
- **`dev`**: 개발 기준 브랜치 — 모든 작업 브랜치의 출발점이자 머지 대상

### 브랜치 네이밍
```
feat/#이슈번호-기능명       예: feat/#3-nearest-station-hook
fix/#이슈번호-버그명         예: fix/#7-gps-permission-crash
chore/#이슈번호-작업명      예: chore/#1-project-init
refactor/#이슈번호-대상     예: refactor/#12-haversine-util
perf/#이슈번호-대상         예: perf/#139-map-clustering
```

### 커밋 메시지 형식
```
<type>(#이슈번호): <제목>

- 변경 사항 1
- 변경 사항 2
```

**타입**: `feat` | `fix` | `refactor` | `test` | `chore` | `docs` | `style` | `perf`

> 커밋 메시지에 `Co-Authored-By` 절대 포함 금지

### 작업 순서
1. GitHub Issue 먼저 생성
2. `dev`에서 브랜치 생성
3. `npm test` 커버리지 100% 확인
4. `npm run type-check` 통과 확인
5. `dev`를 base로 PR 생성 — 본문에 `Closes #이슈번호` 포함
6. GitHub Actions `CI / Type Check & Test` 체크 통과 확인 후 머지

### PR 머지 규칙
- **CI 통과 필수 확인** — `gh pr checks <PR번호>`로 `Type Check & Test` pass 확인 후 머지
- `E2E Smoke (mock mode)`는 ci.yml의 `changes` job이 UI 영향 경로 변경을 감지한 PR에서만 실행 (i18n/백엔드/문서 PR은 자동 스킵). 안정화 후 branch protection required로 승격 예정 (Phase 4)
- E2E 스킵 기준 경로 (변경되어도 smoke 미실행): `src/shared/i18n/`, `src/shared/types/`, `src/testUtils/`, `src/data/`, `src/features/<slice>/types/`, `src/features/<slice>/tasks/`, `src/**/__tests__/`, `backend/`, `docs/`, `scripts/`, `tasks/`, `img/`, `subway/`, `locales/`(top), `__mocks__/`, `.maestro/manual/`, `.maestro/flows/{gps,scenario}/`, `.github/workflows/{e2e,ci}.yml`, `eas.json`, `jest.setup.js`, `sonar-project.properties`, `.env.example`, `.gitignore`, `.prettierrc*`, `.eslintrc*`, `.editorconfig`, `*.md`, `*.txt`
- nightly의 gps/scenario(`e2e.yml`)는 PR 게이트 아님. 실기기 수동 회귀는 `.maestro/manual/`

---

## 테스트 규칙

- **커버리지 100%** (lines / functions / branches / statements) — `package.json`의 `coverageThreshold`로 자동 강제
- **테스트 파일 위치**: `src/<feature 또는 shared>/<sub>/__tests__/<파일명>.test.ts`
- **Mock 원칙**: `expo-location`, `fetch`, `AsyncStorage`, `widgetStorage`, `react-native-webview`는 `jest.mock()`으로 격리
- 훅 테스트는 `@testing-library/react-native`의 `renderHook` + `act` + `waitFor` 사용
- 테마 의존 컴포넌트는 `renderWithTheme` (`src/testUtils/renderWithTheme.tsx`) 사용
- 인터벌 테스트는 `jest.useFakeTimers()` 사용
- barrel re-export 파일(`**/index.ts`)은 `collectCoverageFrom`에서 제외

## 디렉토리 경계 룰 (ESLint)

- `import/no-restricted-paths` enforce(error). `npm run lint` 또는 CI에서 검증.
- `src/features/<X>/`는 `src/features/<Y>/`를 직접 import할 수 없다 — 공용 코드는 `src/shared/`로 추출한다.
- `src/shared/`는 `src/features/`를 import할 수 없다.
- 본질적 cross-feature orchestrator(예: `useFusedNearestStation`, `backgroundLocationTask`, `useStationAlarm` 등)는 파일 헤더의 `eslint-disable import/no-restricted-paths` 주석으로 명시 옵트인한다. 후속 PR에서 orchestration 슬라이스로 이전 예정.

---

## 환경변수

- `EXPO_PUBLIC_` 접두사 사용, `.env`에만 보관 (절대 커밋 금지)
- `.env.example`에 키 이름만 남기고 값은 비워둠
- EAS 빌드 시 `eas env:create`로 등록 필요

```
EXPO_PUBLIC_DATA_API_KEY=          # (미사용)
EXPO_PUBLIC_SEOUL_DATA_API_KEY=    # 서울 열린데이터 API
EXPO_PUBLIC_KAKAO_MAP_KEY=         # 카카오맵 JavaScript API
```

---

## 코딩 컨벤션
- 함수/변수: `lowerCamelCase`
- 컴포넌트: `UpperCamelCase`
- 상수: `UPPER_SNAKE_CASE`
- 파일명: 컴포넌트는 `PascalCase.tsx`, 유틸/훅은 `camelCase.ts`
- 색상: `useTheme()`으로 동적 참조. 정적 `import { colors }` 사용 금지 (테스트 제외)

### 확장성/재사용성 (글로벌 규칙 3번 적용)
- 노선/역 관련 분기: `if-else`/`switch` 대신 `stations.json`, `lineColors.ts` 등 데이터로 구동
- 상수 위치: `src/shared/constants/`에 `UPPER_SNAKE_CASE`로 분리
- API Provider: 새 제공자 추가 시 `src/features/<도메인>/providers/` 인터페이스 구현체만 추가
- 알람/경로 로직: 환승 횟수에 의존하지 않고 `transfers` 배열 순회로 처리
