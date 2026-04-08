# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 프로젝트 개요
GPS 기반으로 현재 탑승 중인 지하철역을 실시간으로 감지하는 React Native(Expo) 모바일 앱.
홈 화면 위젯, 노선 정보, 즐겨찾기 기능을 포함한다.

**기술 스택**: React Native + Expo (TypeScript), Zustand, expo-location + expo-task-manager, expo-notifications

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

---

## 아키텍처

### 데이터 흐름
```
GPS (expo-location)
  → useNearestStation (30s 폴링, 500m 반경 내 최근접 역 탐색)
    → haversine.ts (거리 계산)
    → stations.json (서울 지하철 역 좌표 캐시)
  → useArrivalInfo (30s 폴링, Seoul Open API 호출)
    → arrivalApi.ts (EXPO_PUBLIC_DATA_API_KEY 사용)
```

### 레이어 구조
- **`src/api/`** — 외부 API 호출만 담당. `arrivalApi.ts`가 서울 열린데이터 실시간 도착 정보 API 호출 (응답 없을 시 mock 데이터 fallback)
- **`src/hooks/`** — 비즈니스 로직 캡슐화. 훅 내부에서 setInterval로 자체 폴링 관리, cleanup은 useEffect return으로 처리
- **`src/store/`** — Zustand 전역 상태 (즐겨찾기). AsyncStorage로 영속화
- **`src/utils/`** — 순수 함수들. `haversine.ts` (거리), `widgetStorage.ts` (iOS 위젯 SharedGroupPreferences 브릿지), `buildMapHtml.ts` (Kakao Maps HTML 생성), `kakaoMapLink.ts` (딥링크)
- **`src/components/`** — `StationMap.tsx`는 WebView 안에 Kakao Maps HTML을 embed하는 방식. 플랫폼별 파일 분기: `StationMap.web.tsx`

### 지도 구현
Kakao Maps SDK를 직접 import하지 않고, `buildMapHtml.ts`로 HTML 문자열을 생성하여 `WebView`에 주입하는 방식. 웹 플랫폼은 `StationMap.web.tsx`로 별도 구현 (Expo의 `.web.tsx` 플랫폼 확장자 활용).

### iOS 위젯 데이터 공유
`widgetStorage.ts`가 App Groups를 통해 SharedGroupPreferences에 현재 역 정보를 저장 → iOS 위젯이 해당 데이터를 읽어 표시.

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
```

### 커밋 메시지 형식
```
<type>(#이슈번호): <제목>

- 변경 사항 1
- 변경 사항 2
```

**타입**: `feat` | `fix` | `refactor` | `test` | `chore` | `docs` | `style`

> 커밋 메시지에 `Co-Authored-By` 절대 포함 금지

### 작업 순서
1. GitHub Issue 먼저 생성
2. `dev`에서 브랜치 생성
3. `npm test` 커버리지 100% 확인
4. `npm run type-check` 통과 확인
5. `dev`를 base로 PR 생성 — 본문에 `Closes #이슈번호` 포함
6. GitHub Actions `CI / Type Check & Test` 체크 통과 후 머지

---

## 테스트 규칙

- **커버리지 100%** (lines / functions / branches / statements) — `package.json`의 `coverageThreshold`로 자동 강제
- **테스트 파일 위치**: `src/<모듈>/__tests__/<파일명>.test.ts`
- **Mock 원칙**: `expo-location`, `fetch`, `AsyncStorage`, `widgetStorage`는 `jest.mock()`으로 격리
- 훅 테스트는 `@testing-library/react-native`의 `renderHook` + `act` + `waitFor` 사용
- 인터벌 테스트는 `jest.useFakeTimers()` 사용

---

## 보안 원칙

- 환경변수는 `EXPO_PUBLIC_` 접두사 사용, `.env`에만 보관 (절대 커밋 금지)
- `.env.example`에 키 이름만 남기고 값은 비워둠

```typescript
const apiKey = process.env.EXPO_PUBLIC_DATA_API_KEY;
```

---

## 코딩 컨벤션
- 함수/변수: `lowerCamelCase`
- 컴포넌트: `UpperCamelCase`
- 상수: `UPPER_SNAKE_CASE`
- 파일명: 컴포넌트는 `PascalCase.tsx`, 유틸/훅은 `camelCase.ts`
