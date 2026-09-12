# 🚇 subway-now

## 🖥️ 프로젝트 소개

> **지하·터널·환승 환경에서도 끊기지 않는 지하철 자동 안내**가 필요합니다.
> 네이버·카카오 지도 앱은 출발 시점에만 경로를 안내하고, 지하철 안에서는 신호가 끊기는 순간 안내가 멈춥니다.
>
> subway-now는 **GPS·가속도·기압계·Cellular 4 신호를 융합**하여
> 통신이 닿지 않는 지하 환경에서도 현재 탑승 중인 역과 도착 정보를 실시간으로 추적합니다.
>
> 사용자가 한 번 안내를 시작하면, **자동으로 환승역·하차역에서 알람**이 울립니다.
>
> **이동은 단순하게, 안내는 정확하게.**

---

## 📜 목차

- [📌 핵심 기능](#-핵심-기능)
- [🛠️ 기술스택](#️-기술스택)
- [📌 시작하기](#-시작하기)

### 📚 상세 문서 (Wiki)

| 페이지 | 내용 |
|---|---|
| [🏛️ Architecture](https://github.com/handokei/subway-now/wiki/Architecture) | 시스템 아키텍처 · 4 신호 융합 flow · Cloudflare Workers Edge |
| [📢 Tech-Decisions](https://github.com/handokei/subway-now/wiki/Tech-Decisions) | 21개 ADR × 2026 채용 트렌드 매핑 |
| [🔔 Development-Rules](https://github.com/handokei/subway-now/wiki/Development-Rules) | Wire-completion 5단 · Acceptance 룰 · 커밋/브랜치 컨벤션 |
| [📈 Testing-Results](https://github.com/handokei/subway-now/wiki/Testing-Results) | Coverage 100% · Fixture chain runner |
| [🚩 Troubleshooting](https://github.com/handokei/subway-now/wiki/Troubleshooting) | GPS 한계 → Backend SSoT → 4 신호 융합 → Consensus 게이트 5단계 진화 |
| [🤖 AI-Collaboration](https://github.com/handokei/subway-now/wiki/AI-Collaboration) | BG agent multi-agent orchestration paradigm |
| [📊 Debug-Dashboard](https://github.com/handokei/subway-now/wiki/Debug-Dashboard) | DebugModal · V/X acceptance 매트릭스 |

---

## 📌 핵심 기능

![기능 다이어그램](./docs/images/feature-diagram.png)

<details>
<summary><b>실시간 역 감지 / Nearest Station</b></summary>

**기능**
- GPS 좌표 기반 500m 반경 내 최근접 역 자동 탐지
- 528개 서울 지하철역 좌표 (`stations.json`) 자체 DB 구축
- 30초 폴링 + Haversine 공식으로 거리 계산

**설명**
- `expo-location` + `expo-task-manager`로 FG/BG 모두 GPS 추적
- 지하철 노선·역 변경 시 데이터(JSON)만 갱신, 코드 무수정 (확장성)
- 지하/터널 환경에서는 GPS 단독으로 부정확 → 4 신호 융합으로 보완

</details>

<details>
<summary><b>4 신호 융합 fusion / Multi-Signal Fusion</b></summary>

**4가지 신호 소스**
1. **GPS** (`expo-location`) — 지상 환경 메인 신호
2. **가속도 패턴** (`expo-sensors`) — 정차/주행/감속 fingerprint
3. **기압계** (`barometer`) — 지하/지상 환경 판별 (지하는 기압이 높음)
4. **Cellular 기술** (`react-native-cellular-info`) — 5G/LTE/3G vote로 환경 추정

**설명**
- 단일 신호 단독 의존 시 false positive 빈발 → 4 신호 합의 게이트로 보완
- 합의 게이트 통과 시만 자동 lock + station progression
- 각 신호는 단독 결정 권한 X, vote 합산만 (ADR-015)

</details>

<details>
<summary><b>실시간 도착 정보 / Arrival Info</b></summary>

**기능**
- 서울 열린데이터 API를 통한 실시간 열차 도착 시간 표시
- Provider 패턴 (BFF/Direct/Mock) — 벤더 종속성 제거
- Cloudflare Workers BFF로 API 키 격리 + 응답 캐싱

**설명**
- 외부 API 제공자 변경 시 서버 파일 1개만 교체, 앱 재배포 불필요
- 30초 폴링 + TTL 캐시로 API 호출 최소화
- API 장애 시 silent fallback (마지막 정상 데이터 유지)

</details>

<details>
<summary><b>자동 안내 paradigm / Auto Navigation</b></summary>

**기능**
- 사용자가 "안내 시작" 한 번 누르면, 환승역·하차역까지 자동 알람
- BackgroundTask + Silent Push로 백그라운드에서도 동작
- WhileInUse 권한만으로도 작동 (Always 권한 강제 X)

**설명**
- 네이버/카카오는 출발 시점에만 안내. 지하 진입 후 안내 중단
- subway-now는 lockless 환경(지하)에서도 4 신호 융합으로 추적 지속
- 이동 중 환승 알림 / 하차 알림을 자동 발송 (사용자 매번 확인 불필요)

</details>

<details>
<summary><b>iOS 위젯 + Live Activity</b></summary>

**기능**
- 홈 화면 위젯: 현재 역 + 다음 도착 정보 1줄 표시
- Dynamic Island: 실시간 도착 카운트다운 (Live Activity)
- Lock Screen: 환승/하차 임박 시 자동 표시

**설명**
- App Groups + SharedGroupPreferences로 React Native ↔ Swift 위젯 데이터 공유
- `modules/live-activity/` 자체 네이티브 모듈 (expo-modules-core 기반)
- 위젯 데이터는 위치 변경 시점에만 업데이트 (배터리 최적화)

![Widget Screenshot](./docs/images/widget-screenshot.png)

![Live Activity Screenshot](./docs/images/live-activity-screenshot.png)

</details>

<details>
<summary><b>경로 탐색 & 환승 / Route & Transfer</b></summary>

**기능**
- 출발/도착역 입력 후 최적 경로 탐색
- 환승 횟수 표시 + 환승역 자동 알림
- 다국어 (한/영/일/중) 지원

**설명**
- `transfers` 배열을 순회로 처리 — 환승 횟수에 의존 X (확장성)
- 경로 데이터는 `lineGeometry.json` (OpenStreetMap 출처) 활용
- 4개 언어 i18n으로 외국인 관광객 접근성 보강

</details>

<details>
<summary><b>즐겨찾기 · 취침 모드 · 설정</b></summary>

**즐겨찾기**
- 자주 이용하는 역 저장 (AsyncStorage 영속화)
- Zustand 전역 상태 + 즉시 동기화

**취침 모드**
- 알람 사운드 + 진동 + 음성으로 도착 즉시 깨움
- 음성은 시스템 TTS (한국어/영어) 활용

**설정**
- 알람 사운드 토글 / 음성 알람 토글 / 다국어 / 다크 모드
- OS 다크 모드 자동 감지 (Editorial Light / C·Focus 테마)

</details>

---

## 🗒️ 설계 문서

시스템 아키텍처, 4 신호 융합 flow, Cloudflare Workers Edge 구조, mermaid 다이어그램 → **[Wiki › Architecture](https://github.com/handokei/subway-now/wiki/Architecture)**

---

## 🔔 개발 규칙

Wire-completion 5단 체크, Acceptance 룰, 커밋/브랜치 컨벤션, 디렉토리 구조 → **[Wiki › Development-Rules](https://github.com/handokei/subway-now/wiki/Development-Rules)**

---

## 🛠️ 기술스택

| 분류 | 기술 |
|---|---|
| **Language** | TypeScript |
| **Frontend** | React Native, Expo SDK 54, Expo Router 6 |
| **State** | Zustand, AsyncStorage |
| **Location** | expo-location, expo-task-manager |
| **Sensors** | expo-sensors (accelerometer, barometer), react-native-cellular-info |
| **Notification** | expo-notifications, Live Activity (iOS) |
| **Map** | Kakao Maps SDK (WebView 주입), Naver Map SDK |
| **i18n** | i18next (ko/en/ja/zh) |
| **Native Module** | expo-modules-core (Swift) |
| **Backend (BFF)** | Cloudflare Workers, Workers KV, R2, Cron Trigger |
| **Push** | APNs (silent push for BG reconcile) |
| **Monitoring** | Sentry, R2 raw signals, DebugModal Dashboard |
| **Test** | Jest, @testing-library/react-native (Coverage 100% 강제) |
| **CI/CD** | GitHub Actions, EAS Build, TestFlight |
| **Docs** | ADR (Architecture Decision Records) |
| **Collaboration** | GitHub Issues, GitHub Projects, Claude Code (AI agent) |

---

## 📢 기술적 의사결정

21개 ADR이 [`docs/decisions/`](./docs/decisions/)에 박제됨. 2026 백엔드 신입 시장 트렌드(AI Orchestrator / Edge / 분산 시스템 / 아키텍처 / Observability)에 매핑된 전체 표 → **[Wiki › Tech-Decisions](https://github.com/handokei/subway-now/wiki/Tech-Decisions)**

---

## 📈 테스트 결과

Coverage 100% 강제, Fixture chain runner(12 stages × 4 환경 × 2 권한 = 96 조합) → **[Wiki › Testing-Results](https://github.com/handokei/subway-now/wiki/Testing-Results)**

---

## 🚩 트러블슈팅

GPS 단독 한계 → Backend SSoT → 4 신호 융합 → Consensus 게이트 → 측정 인프라 5단계 진화 과정 → **[Wiki › Troubleshooting](https://github.com/handokei/subway-now/wiki/Troubleshooting)** · [Wiki › Debug-Dashboard](https://github.com/handokei/subway-now/wiki/Debug-Dashboard)

---

## 🤖 AI 협업 paradigm

Plan/Issue max + Code medium 분리, BG agent 4~5 병렬 + worktree 격리, Wire-completion 5단 자동화 → **[Wiki › AI-Collaboration](https://github.com/handokei/subway-now/wiki/AI-Collaboration)**

---

## 📌 시작하기

### 사전 준비

- Node.js 18+
- Expo CLI (`npm install -g expo-cli`)
- iOS: Xcode 15+ / Android: Android Studio
- Cloudflare 계정 (BFF 서버 deploy 시)

### 설치 및 실행

```bash
git clone https://github.com/handokei/subway-now.git
cd subway-now
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일에 API 키 입력

npm start          # Expo 개발 서버
npm run ios        # iOS 시뮬레이터
npm run android    # Android 에뮬레이터
```

### 테스트

```bash
npm test              # 전체 테스트 + 커버리지 (100% 필수)
npm run type-check    # TypeScript 타입 검사
npm run lint:orphan   # Orphan export 검출 (Wire-completion 1단)
```

### 빌드 & 배포

```bash
eas build --profile production --platform ios    # 프로덕션 빌드
eas build --profile development --platform ios   # 개발 빌드
eas submit --platform ios --latest               # TestFlight 업로드
```

### 환경변수

```
EXPO_PUBLIC_SEOUL_DATA_API_KEY=    # 서울 열린데이터 API
EXPO_PUBLIC_KAKAO_MAP_KEY=         # 카카오맵 JavaScript API
```

---

## 🔗 관련 저장소

- **[subway-now-bff](https://github.com/handokei/subway-now-bff)** — Cloudflare Workers BFF (API 프록시 + 캐싱 + trip token SSoT)

## 📄 데이터 출처

`src/data/lineGeometry.json` (서울 지하철 1~9호선 노선 폴리라인 좌표):
Map data © [OpenStreetMap](https://www.openstreetmap.org/) contributors, available under the [Open Database License](https://opendatacommons.org/licenses/odbl/).
재생성: `node scripts/fetch-line-geometry.js`

`src/data/stations.json` (서울 지하철 528개 역 좌표):
서울 열린데이터 (https://data.seoul.go.kr/)
