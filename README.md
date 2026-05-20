# subway-now

GPS 기반으로 현재 탑승 중인 지하철역을 실시간으로 감지하고, 도착 정보를 제공하는 모바일 앱.

## 주요 기능

- **실시간 역 감지**: GPS 좌표와 Haversine 공식으로 500m 반경 내 최근접 역 자동 탐지
- **도착 정보**: 서울 열린데이터 API를 통한 실시간 열차 도착 시간 표시
- **iOS 위젯**: App Groups + SharedGroupPreferences로 홈 화면 위젯에 현재 역 정보 표시
- **Live Activity**: iOS Dynamic Island / Lock Screen에 실시간 도착 정보 표시
- **즐겨찾기**: 자주 이용하는 역 저장 (AsyncStorage 영속화)
- **목적지 알람**: 하차/환승역 도착 시 알림 및 사운드

## 기술 스택

| 영역 | 기술 |
|------|------|
| 프레임워크 | React Native + Expo (TypeScript) |
| 상태 관리 | Zustand + AsyncStorage |
| 위치 | expo-location + expo-task-manager |
| 알림 | expo-notifications |
| 지도 | Kakao Maps (WebView 주입) + Naver Map SDK |
| 테스트 | Jest + @testing-library/react-native (100% 커버리지) |

## 아키텍처

> 상세 설계는 [ARCHITECTURE.md](./ARCHITECTURE.md)를 참고하세요.

### 설계 의도

이 프로젝트는 **벤더 종속성 제거**를 핵심 설계 원칙으로 삼았다.

```
[앱]  →  Provider 인터페이스  →  [BFF 서버]  →  외부 API
```

1. **Provider 패턴**: 앱은 인터페이스에만 의존하고, 구체적인 API 제공자를 모른다
2. **BFF 서버**: API 키 서버 격리, 응답 캐싱, 제공자 교체 시 앱 재배포 불필요
3. **Factory 패턴**: 환경변수로 Provider 전환 (직접 호출 ↔ BFF)

이 구조 덕분에 외부 API 제공자 변경 시 **서버 파일 1개만 교체**하면 된다.
자세한 결정 배경은 [Architecture Decision Records](./docs/decisions/)에 기록했다.

### 데이터 흐름

```
GPS (expo-location)
  → useNearestStation (30초 폴링, Haversine 거리 계산)
  → useArrivalInfo (ArrivalProvider → BFF → Seoul Open API)
  → UI 렌더링 + iOS 위젯 업데이트
```

## 시작하기

### 사전 준비

- Node.js 18+
- Expo CLI (`npm install -g expo-cli`)
- iOS: Xcode 15+ / Android: Android Studio

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
```

## 프로젝트 구조

```
app/                  ← Expo Router (탭 네비게이션)
src/
  providers/          ← Provider 인터페이스 + 구현체 (벤더 추상화)
  hooks/              ← 비즈니스 로직 (폴링, 상태 관리)
  api/                ← 레거시 API 호출 (Provider로 이전 중)
  store/              ← Zustand 전역 상태
  utils/              ← 순수 함수 (haversine, widget 등)
  components/         ← UI 컴포넌트
  data/               ← 정적 데이터 (stations.json)
modules/
  live-activity/      ← iOS Live Activity 네이티브 모듈
  audio-route/        ← 오디오 라우팅 네이티브 모듈
targets/
  subway-widget/      ← iOS 홈 화면 위젯
docs/
  decisions/          ← ADR (Architecture Decision Records)
```

## 관련 저장소

- **[subway-now-bff](https://github.com/handokei/subway-now-bff)** — BFF 서버 (API 프록시 + 캐싱)

## 데이터 출처

`src/data/lineGeometry.json` (서울 지하철 1~9호선 노선 폴리라인 좌표):
Map data © [OpenStreetMap](https://www.openstreetmap.org/) contributors, available under the [Open Database License](https://opendatacommons.org/licenses/odbl/).
재생성: `node scripts/fetch-line-geometry.js`
