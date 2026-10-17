# Sentry 설정 운영 가이드 (#1038 / S13 #1546)

본 문서는 Sentry React Native DSN 발급 → 등록 → 활성화 검증 절차의 SSOT.

- **SDK init**: `src/shared/infra/monitoring/sentryInit.ts`
- **Breadcrumb 유틸**: `src/shared/infra/monitoring/breadcrumb.ts`
- **활성 상태 SSOT**: `src/shared/infra/monitoring/sentryState.ts` (`isSentryEnabled`)
- **app.config plugin**: `app.config.js` (`@sentry/react-native/expo`)

## 이중 게이트

DSN이 있어도 사용자가 opt-in 하지 않으면 외부 전송 0. 모든 코드 경로(`enableSentry`, `addLogBreadcrumb`, `addDomainBreadcrumb`, `recordEnvironmentTransition`)가 `isSentryEnabled()` 또는 DSN 가드를 통과해야 한다.

| 조건 | 결과 |
| --- | --- |
| `SENTRY_OPT_IN_KEY` AsyncStorage = `'true'` + `EXPO_PUBLIC_SENTRY_DSN` 설정 | Sentry SDK init + breadcrumb 전송 |
| opt-in O / DSN X | logger.info "DSN 미설정" → no-op |
| opt-in X | `initSentryIfOptedIn` early return |

기본값: opt-in OFF. 사용자가 설정 화면에서 명시 동의 후만 활성. 개인정보 정책상 GPS/푸시토큰/이메일은 breadcrumb data에 넣지 않는다 (역 이름·노선·trainCode 등 공개 정보만).

## 운영자 액션 절차

DSN 발급은 운영자(`handokei`) 액션. 본 PR은 인프라 + 문서만 제공한다.

### 1. Sentry 프로젝트 생성

1. https://sentry.io → Settings → Projects → Create Project
2. Platform: **React Native**
3. Project name: `subway-now` (기존이 있으면 재사용)
4. 프로젝트 생성 후 Settings → Client Keys (DSN) → 기본 DSN 복사

### 2. 로컬 `.env` 등록

```
EXPO_PUBLIC_SENTRY_DSN=https://<public_key>@oXXXXXX.ingest.sentry.io/<project_id>
```

`.env` 자체는 커밋 금지 (`.gitignore`에 이미 포함). `.env.example`에는 키 이름만.

### 3. EAS production 환경 등록

```bash
eas env:create production --name EXPO_PUBLIC_SENTRY_DSN --value '<DSN>'
eas env:create preview    --name EXPO_PUBLIC_SENTRY_DSN --value '<DSN>'   # 선택
```

development profile은 등록하지 않거나 별도 DSN으로 분리(production 노이즈 격리).

### 4. 검증

1. EAS production 빌드 → TestFlight 설치
2. 앱 설정 → 진단 → Sentry opt-in 토글 ON
3. 1분 내 boot → Sentry Issues 페이지에서 첫 session event 도착 확인
4. 의도적 crash 경로(설정 → 디버그 → "테스트 에러 발생" 등이 있다면) 또는 자연 trip 1회로 breadcrumb 5개 이상 누적 확인:
   - `trip:start`
   - `boarding:lock-create`
   - `lifecycle:environment-transition` (지하 진입 시)
   - `push:silent-push`
   - `alarm:fire`

## Breadcrumb 카테고리 (현재 wired)

| 카테고리 | 발사 지점 | 파일 |
| --- | --- | --- |
| `trip` | destination set/clear, sentinel rehydration | `useDestinationStore.ts`, `useStateRehydration.ts` |
| `boarding` | createLock / releaseLock | `useBoardingLockStore.ts` |
| `alarm` | 알람 fire, trip-ended-surface | `stationNotification.ts` |
| `push` | silent push payload 수신 | `silentPushTask.ts` |
| `permission` | notification 권한 변경 | `stationNotification.ts` |
| `lifecycle` | FG/BG transition, environment 전환 | `useStateRehydration.ts`, `useFusedNearestStation.ts` |

## 개인정보·데이터 정책

- DSN 발급된 Sentry 프로젝트는 EU 또는 US region 둘 다 가능. 한국 사용자 대상이면 EU region 권장 (GDPR-aligned).
- breadcrumb data: 역 이름·노선·trainCode·환경 전환은 OK. GPS 좌표는 호출자가 100m round 후 전달 (`breadcrumb.ts` 주석 참고).
- 사용자 식별자/푸시토큰 전체 전달 금지.
- 동의 철회 경로: 설정 → Sentry opt-in 토글 OFF → `Sentry.close()` 즉시 호출 (`setSentryOptIn(false)`).

## Instruments freeze 캡처

JS 로직 외 native hang(15:42 freeze 같은 케이스)은 Sentry로 잡히지 않는다. Xcode Instruments Time Profiler + Hang Tracer 절차는 [xcode-instruments-freeze-capture.md](./xcode-instruments-freeze-capture.md) 참고.
