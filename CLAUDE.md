# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 프로젝트 개요
GPS 기반으로 현재 탑승 중인 지하철역을 실시간으로 감지하는 React Native(Expo) 모바일 앱.
홈 화면 위젯, 노선 정보, 즐겨찾기, 경로 탐색, 취침 모드 알람 기능을 포함한다.

**기술 스택**: React Native + Expo 54 + TypeScript, Zustand, expo-location + expo-task-manager, expo-notifications, expo-router 6

---

## 결정 / Acceptance 룰 (필수, 2026-06-12 추가)

2026-06-11 일괄 결정 사고로 사용자 가치 손실 후 도입. 상세는 `tasks/lessons.md` L1~L4.

### 결정 옵션 제시 (B1~BN 같은 차단 항목 결정 PR 작성 시)
- **false binary 금지** — "강제 적용 vs 면제" 두 옵션만 제시 X. 최소 3개 옵션 보장
- 빠뜨리기 쉬운 옵션: **"정확성 게이트 보강 (현재 코드에 없음, 신규 작업 X주 필요)"** — 현재 코드에 없어도 옵션 테이블에 포함
- 자가 점검: "사용자가 한쪽 극단 선택 시 ADR 첫 줄 원칙 위반?" → Yes면 옵션 누락
- 출처: `memory/feedback_decision_no_false_binary.md`

### Epic close 조건
- **PR 머지 = close 금지.** "Seam A~G 7개 PR 머지"는 진행 척도일 뿐
- close 조건 필수: 본문 evidence 시나리오 실기기 1주 재발 0건 OR 1주 production 측정 회귀 0건
- 자가 점검: "epic 본문 evidence가 acceptance에 1:1 매핑되는가?"
- 출처: `memory/feedback_epic_close_field_verify.md`

### Acceptance 정의 순서
- **사용자 가치 → acceptance → 코드** 순서. "이미 머지된 sub-issue" 기준 acceptance 금지
- 회귀 정의 점검:
  1. lock 활성 / lockless 둘 다 카테고리?
  2. 사용자 명시 의향(C 토글 ON / boardingPrompt 응답 / 직접 탭) trip이 lock 활성과 동급으로 다뤄지는가?
  3. ADR 첫 줄 원칙이 acceptance까지 적용되는가?
  4. 권한 매트릭스(WhileInUse/Always × FG/BG/취침) 모두 커버?
  5. 환경 매트릭스(지하/지상/환승) 모두 커버?
- 출처: `memory/feedback_acceptance_drives_code.md`

### 사용자 명시 의향 trip
- **C 토글 ON / boardingPrompt 응답 / BoardingTrainList 직접 탭 = lock 활성과 동급 정확도 보장 의무**
- "정보용 토글" 라벨은 UI 텍스트로만, acceptance/게이트는 동급
- 다음 표현 금지: "사용자 선택 영역 → acceptance 위반 아님", "정보용이라 정확성 게이트 의무 없음", "best effort"
- ADR-010 첫 줄: "두 실패 모드(false positive / miss)는 비대칭이 아니라 **동급**."
- 출처: `memory/feedback_user_intent_equal_protection.md`, `docs/decisions/ADR-014-decision-process-rules.md`

### 검증은 새 실기기 라이드에 의존하지 않는다 (필수, 2026-09-24 사용자 재지시)

**회귀 fix의 acceptance를 "다음 라이드에서 fired>0 확인"으로 잡지 않는다.** 매번 새 라이드를 요구하는 것은 반복 실패 패턴이며, 라이드로만 알 수 있게 만드는 순간 감시 인프라가 존재할 이유가 없어진다. 검증 자원은 **이미** 있다:

1. **한 달치 실기기 덤프** — `~/.claude/uploads/*.txt`. 새로 계측·라이드하기 전에 **먼저 교차로 읽는다**. "없음" 표기는 왜 비었는지 코드로 확인(신선도 창·종료 시 clear).
2. **replay 테스트** — 실측 덤프 / D1 레코드를 **불변 fixture**로 박아 CI에서 24/7 재현(`replay_YYYYMMDD_*.test.ts`, `REPLAY_LIBRARY`). fix 검증은 **합성 fixture가 아니라 회귀를 실제로 일으킨 실측 트립**으로 한다. fixture 데이터는 실측이고 불변 — 통과시키려 조정 금지.
3. **D1 `trip_metrics` / `trip_events`** — authoritative(device 덤프는 밀림). 회귀 정의(예: `lock=1 && fired=0`)를 실 데이터로 **backfill 검증**한다.
4. **자동 감시(#2795)** — 배포 후 회귀 재발을 24h 내 D1로 잡는다.

**acceptance 문장 규칙**: "실제 라이드 1회 fired>0"이 아니라 "**회귀를 낳은 실측 트립을 replay했을 때 fix 후 fired>0** + backfill 감지 + 프로덕션 측정 회귀 0"으로 쓴다. 실기기 라이드는 배포 후 최종 sanity check일 뿐 **1차 검증 수단이 아니다** — 라이드 없이 실측으로 증명할 수 있는데 라이드를 요구하면 룰 위반.
- 출처: `memory/feedback_read_existing_logs_before_adding_instrumentation.md`, `memory/lesson_fixture_replay_verification_infrastructure.md`

### Wire-completion 5단 룰 (#1582)

"코드만 머지되고 실제 연결 안 됨" 회귀 차단. 모든 PR에 5단 체크 필수 (`.github/PULL_REQUEST_TEMPLATE.md`).

1. **Orphan 없음** — `npm run lint:orphan` pass. CI `Orphan Export Detection` job이 강제. 신규 export 추가 시 caller 반드시 존재.
   - 의도적 entry-point(`app/` route, `modules/*/index.ts`, barrel `providers/index.ts` 등)는 `scripts/check-orphan-exports.sh`의 `IGNORE_PATTERN`에 추가.
   - "(used in module)" 라인은 false-positive로 자동 무시.
2. **V/X dashboard** — 변경된 신호가 어디서 시각화/관측 가능한지(DebugModal / wrangler tail / Cloudflare Dashboard / Sentry) PR 본문에 명시.
3. **의존 PR** — 본 PR이 작동하려면 머지돼야 할 다른 PR(backend/device/infra) 번호 명시. 없으면 "N/A".
4. **측정 plan** — 회귀 신호를 1주 안에 어떻게 측정할지(시나리오 / log query / 사용자 trip 캡처) 명시.
5. **Device verify** — 실기기 검증 필요 여부 + 시나리오. 코드-only면 "N/A — type+unit only" 명시.

검증 절차:
- `npm run lint:orphan` 로컬 실행 → 0 orphan 확인 후 PR 생성.
- CI `Wire-completion CI / Orphan Export Detection` job pass 확인 후 머지.
- 신규 entry-point export 추가 시 ignore pattern 갱신 PR을 분리하지 말고 같은 PR에 포함.

---

## Agent skills

### Issue tracker

GitHub Issues (`handokei/subway-now`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `docs/decisions/` at repo root (ADR-001~). See `docs/agents/domain.md`.

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

### Cloudflare Workers 배포 (웹 export + backend, #2698)

**절대 bare `wrangler deploy`(또는 `wrangler dev`)를 직접 실행하지 않는다.** 레포에 `wrangler.jsonc`(루트, 웹 export용 `subway-now`)와 `wrangler.toml`(`backend/alarm-worker/`, `subway-now-alarm-worker`) 두 config가 공존하며, `backend/alarm-worker/`에서 실행해도 wrangler 4.x가 상위 디렉토리의 루트 `wrangler.jsonc`를 채택해 cron·바인딩 없는 엉뚱한 worker를 배포하는 사고가 실제 발생했다(2026-09-17, 사용자·에이전트 각 1회). 반드시 아래 npm 스크립트로만 배포한다 — 두 스크립트 모두 `--config` 명시 + 배포 후 worker명/바인딩/cron 자동 검증을 내장하고 있어 실수 시 스크립트가 실패로 알린다.

```bash
npm run deploy:web                                # 웹(Expo export) 정적 에셋 → subway-now (루트에서 실행)
cd backend/alarm-worker && npm run deploy          # backend cron worker → subway-now-alarm-worker
```

- 배포 전 config 해석만 확인하고 싶으면(실배포 없이): `cd backend/alarm-worker && npx wrangler deploy --dry-run --config wrangler.toml` — 바인딩 7종(KV×4/D1/R2/DO)이 나오면 정상, `No bindings found`면 config 하이재킹.
- 배포 결과 재확인: `cd backend/alarm-worker && npx wrangler deployments list --config wrangler.toml` (최신 항목의 날짜/author 확인).

### D1 마이그레이션 운영 절차 (#2783)

`trip_metrics` 테이블은 `backend/alarm-worker/src/db/schema.ts`(Drizzle ORM 엔티티)가 SSoT다. write 경로(`d1TripMetrics.ts`)는 이 엔티티만 거친다 — raw SQL INSERT/UPDATE 재발은 `src/__tests__/noRawSqlGuard.test.ts`가 CI에서 차단한다.

**절대 bare `wrangler d1 migrations apply`를 직접 실행하지 않는다** — #2698과 동일한 이유(상위 루트 `wrangler.jsonc` 하이재킹 위험)로 반드시 `--config` 명시 npm 스크립트로만 적용한다.

```bash
cd backend/alarm-worker
npm run db:migrate:local     # 로컬 D1(.wrangler/state)에 미적용 migrations/*.sql 적용 + 검증
npm run db:migrate:remote    # 프로덕션 D1에 적용
```

스키마 변경 절차:
1. `src/db/schema.ts`를 손으로 수정(컬럼 추가/제거).
2. 대응하는 `migrations/NNNN_설명.sql`을 손으로 작성(`0007_trip_metrics_drop_unfilled_columns.sql`이 예시) — 기존 데이터가 있는 테이블은 `ALTER TABLE`로, 컬럼 삭제 근거는 마이그레이션 파일 주석에 남긴다.
3. `npm run db:migrate:local`로 로컬 검증 후 `npm run db:migrate:remote`로 적용.
4. `src/db/__tests__/schema.test.ts`의 기대 컬럼 목록을 갱신 — drift 감지 테스트가 엔티티와 실제 DDL의 불일치를 잡는다.

**알려진 갭**: `drizzle-kit generate`(스키마 diff 자동 마이그레이션 생성)는 아직 채택하지 않았다 — 기존 0001~0007이 손으로 작성돼 drizzle-kit 자체 journal이 없고, journal 없이 `generate`를 돌리면 이미 존재하는 테이블에 대해 처음부터 `CREATE TABLE`을 다시 만들어내 프로덕션과 충돌한다. 상세 근거는 `backend/alarm-worker/drizzle.config.ts` 헤더 주석 참고 — journal 부트스트랩이 별도로 검증되기 전까지는 위 수동 절차를 따른다.

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

### 레이어 구조 (Feature-based + Ports & Adapters, ADR Phase 5 + Step 7)
ADR "Feature-based + Ports & Adapters 디렉토리 재정비" (https://app.notion.com/p/36e30c0194b68148ba29f2bc4554ce8a) 적용.
의존 방향: `app/` (thin route) → `src/screens/*` (controller) → `src/features/*` → `src/shared/*`. features 끼리, features → screens, shared → screens는 ESLint(`import/no-restricted-paths`)로 직접 import를 차단한다.

- **`app/`** — expo-router route entry (각 파일 1~2줄 re-export). 화면 본체는 `src/screens/`에 둔다 (bulletproof-react "thin route + thick screen", Step 7 / #894).
- **`src/screens/`** — 화면 본체. features를 조합하는 controller layer. expo-router의 route entry는 `app/(tabs)/X.tsx`가 `src/screens/XScreen.tsx`를 default re-export하는 형태. coverage 제외 (E2E + 수동 검증).
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
  - `infra/` — Adapter 구현 (`location/Expo*`, `storage/AsyncStorage*`, `storage/SharedGroup*`)
  - `ports/` — Adapter가 구현하는 추상 인터페이스 (`LocationPort`, `WidgetStoragePort`)
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
6. GitHub Actions `CI / Data Validation` + `CI / Type Check & Test` 체크 통과 확인 후 머지

### PR 머지 규칙
- **CI 통과 필수 확인** — `gh pr checks <PR번호>`로 `Data Validation` + `Type Check & Test` pass 확인 후 머지
- **Branch protection의 required status check** — `Data Validation`, `Type Check & Test` (구 `E2E Smoke (mock mode)` 제거됨, #1335). repo settings에서 수동 갱신 필요
- **CI 범위 = 정적 검증만**. type-check + unit(coverage 100%) + stations.json 정합성. iOS Release 빌드/시뮬레이터 실행/Maestro는 CI에 없음 (#1335)
- **빌드/실기기 검증은 사용자 책임** — prebuild drift / Pods 충돌 / native compile 깨짐은 사용자가 다음 로컬 빌드(`npm run ios` / EAS) 시 발견. CI가 미리 막아주지 않음
- **에이전트 PR은 device 검증 갭 존재** — 에이전트는 type-check + unit만 검증. runtime/native/위젯/LA/지하 등 device-only 회귀는 에이전트가 검증 불가. 사용자가 머지 전 결정 권한자이며, 의심 PR은 본인 실기기 빌드 후 머지
- nightly gps/scenario(`e2e.yml`)는 PR 게이트 아님. 실기기 수동 회귀는 `.maestro/manual/`

---

## 테스트 규칙

### TDD 필수 (2026-09-20 결정)

**커버리지 100%는 floor이지 TDD가 아니다.** test-after는 구현을 거울처럼 베껴 배선·시나리오 결함을 원리적으로 못 잡는다 — 9,000개 테스트·커버리지 100% 상태에서 유령 trip 이중 등록·prompt 한 달 0건·목적지 통과가 전부 사전 차단되지 못했다.

모든 fix/feat 작업은 아래 순서를 지킨다.

1. **이슈 스펙만 보고 실패 테스트를 먼저 작성한다.** 구현 코드를 보며 기대값을 맞추지 않는다.
2. **돌려서 실패를 확인**하고 출력을 기록한다.
3. **실패하는 상태로 먼저 커밋** — `test(#N): red — <무엇이 왜 실패하는지>`
4. **최소 구현으로 green** — 별도 커밋 `fix(#N): ...`
5. **커밋 순서가 증거다.** `git log`에서 test 커밋이 fix 커밋보다 앞서야 한다. PR 본문에 **test-first인지 test-after인지 명시**한다(커밋 순서로 검증 가능).

**"구현 후 되돌려서 red 확인"은 TDD가 아니다.** 그것은 사후 검증이며, "테스트가 실패할 수 있다"만 증명할 뿐 "테스트가 구현을 모른 채 스펙에서 나왔다"는 증명하지 못한다.

**실패 테스트가 곧 제약이다:**
- 실패 케이스를 충분히 만든다. 고쳐서 통과할 것 / 고친 뒤에도 실패해야 할 것(거부 케이스)을 모두 포함한다.
- **결과값만이 아니라 실패 사유까지 assert**한다. 다른 이유로 실패해도 통과하는 테스트는 제약이 아니다.
- **타입 레벨 red도 red다.** 필수 파라미터화처럼 런타임으로 안 잡히는 변경은 **컴파일 에러 목록이 red**이며, 그 목록이 곧 "어디가 누락됐는가"의 증거다. PR 본문에 첨부한다.

**이미 구현을 시작한 뒤 이 룰을 적용하게 된 경우** 되돌리지 않는다. 남은 케이스만이라도 test-first로 쓰고, PR 본문에 "test-after였다"고 명시한다.

시나리오·배선 결함은 unit으로 못 잡는다 → 실기기 dump를 fixture로 박는 replay 테스트가 짝이다(`replay_YYYYMMDD_*.test.ts`, `REPLAY_LIBRARY`). **fixture 데이터는 실측이고 불변** — 통과시키려고 조정하지 않는다.

### 공통

- **커버리지 100%** (lines / functions / branches / statements) — `package.json`의 `coverageThreshold`로 자동 강제
- **테스트 파일 위치**: `src/<feature 또는 shared>/<sub>/__tests__/<파일명>.test.ts`
- **Mock 원칙**: `expo-location`, `fetch`, `AsyncStorage`, `widgetStorage`, `react-native-webview`는 `jest.mock()`으로 격리
- 훅 테스트는 `@testing-library/react-native`의 `renderHook` + `act` + `waitFor` 사용
- 테마 의존 컴포넌트는 `renderWithTheme` (`src/testUtils/renderWithTheme.tsx`) 사용
- 인터벌 테스트는 `jest.useFakeTimers()` 사용
- barrel re-export 파일(`**/index.ts`)은 `collectCoverageFrom`에서 제외
- 역명 hardcoding 금지 — base name(예: `'교대'`) assertion은 `canonicalStationName(base, line)` (`src/testUtils/canonicalStationName.ts`) 사용. stations.json BLDN_NM drift(#1410) 자동 흡수.

## 디렉토리 경계 룰 (ESLint)

- `import/no-restricted-paths` enforce(error). `npm run lint` 또는 CI에서 검증.
- `src/features/<X>/`는 `src/features/<Y>/`를 직접 import할 수 없다 — 공용 코드는 `src/shared/`로 추출한다.
- `src/shared/`는 `src/features/`, `src/screens/`를 import할 수 없다.
- `src/features/`는 `src/screens/`를 import할 수 없다 (screens는 features 위 layer, Step 7).
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
