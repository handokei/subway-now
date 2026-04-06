# subway-now — Claude 협업 가이드

## 프로젝트 개요
GPS 기반으로 현재 탑승 중인 지하철역을 실시간으로 감지하는 React Native(Expo) 모바일 앱.
홈 화면 위젯, 노선 정보, 즐겨찾기/알림 기능을 포함한다.

---

## 기술 스택
- **프레임워크**: React Native + Expo (TypeScript)
- **위치**: expo-location + expo-task-manager
- **위젯**: expo-widgets (iOS) / react-native-android-widget (Android)
- **상태 관리**: Zustand
- **알림**: expo-notifications

---

## GitHub 워크플로우 (필수 준수)

### 작업 순서
1. **GitHub Issue 먼저 생성** — 모든 작업은 이슈에서 시작
2. **이슈 번호로 브랜치 생성** — `feat/#이슈번호-기능명` 형식
3. **작은 단위로 커밋** — 기능 단위로 세세하게 남김
4. **PR 생성 시 이슈 연결** — 본문에 `Closes #이슈번호` 포함
5. **리뷰 후 머지**

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

---

## 보안 원칙 (필수 준수)

- **API 키를 코드에 직접 작성 금지** — `.env` 파일에만 보관
- `.env` 파일은 `.gitignore`에 등록되어 있으며 절대 커밋하지 않음
- 환경변수는 `EXPO_PUBLIC_` 접두사 사용 (Expo 클라이언트 노출 규칙 준수)
- `.env.example`에 키 이름만 남기고 값은 비워둠

### 환경변수 접근 방법
```typescript
// process.env로 직접 접근 (Expo가 자동으로 주입)
const apiKey = process.env.EXPO_PUBLIC_DATA_API_KEY;
```

---

## 프로젝트 구조
```
subway-now/
├── app/                    # Expo Router 화면
│   ├── (tabs)/
│   │   ├── index.tsx       # 현재 역 메인
│   │   ├── lines.tsx       # 노선 정보
│   │   └── favorites.tsx   # 즐겨찾기
│   └── _layout.tsx
├── src/
│   ├── api/                # API 호출 함수
│   ├── data/               # stations.json (역 좌표 캐시)
│   ├── hooks/              # 커스텀 훅
│   ├── utils/              # haversine 등 유틸
│   └── store/              # Zustand 스토어
├── .env                    # 로컬 환경변수 (git 제외)
├── .env.example            # 환경변수 템플릿 (git 포함)
└── CLAUDE.md               # 이 파일
```

---

## 코딩 컨벤션
- 함수/변수: `lowerCamelCase`
- 컴포넌트: `UpperCamelCase`
- 상수: `UPPER_SNAKE_CASE`
- 파일명: 컴포넌트는 `PascalCase.tsx`, 유틸/훅은 `camelCase.ts`
