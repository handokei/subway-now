# Architecture

## 시스템 개요

subway-now는 GPS 기반 실시간 지하철 탑승 감지 모바일 앱이다.
외부 API 의존성을 **Provider 패턴**으로 추상화하고, **BFF(Backend for Frontend) 서버**를 통해 API 호출을 중앙화하는 구조로 설계되었다.

---

## 아키텍처 진화

### AS-IS: 앱 → 외부 API 직접 호출

```
┌─────────────┐
│   React Native App   │
│                      │
│  useArrivalInfo      │──── fetch ────→  Seoul Open API
│  useNearestStation   │──── GPS ─────→  expo-location
│  StationMap          │──── WebView ──→  Kakao Maps
└─────────────┘
```

**문제점**:
- API 키가 앱 번들에 포함 → 추출 가능 (보안 취약)
- 제공자 변경 시 앱 전체 수정 + 스토어 재배포 필요
- 각 훅이 특정 API에 직접 의존 → 교체 불가

### TO-BE: Provider 패턴 + BFF 서버

```
┌─────────────────────┐     ┌──────────────────┐     ┌──────────────┐
│   React Native App         │     │   BFF Server          │     │   외부 APIs       │
│                            │     │                       │     │                   │
│  useArrivalInfo            │     │   /api/arrival        │     │  Seoul Open API   │
│    → ArrivalProvider ──────────→│     → SeoulProvider ───────→│                   │
│                            │     │     → Cache (Redis)   │     │                   │
│  useRoute (예정)           │     │   /api/route          │     │  ODsay API        │
│    → RouteProvider ────────────→│     → ODsayProvider ───────→│                   │
│                            │     │                       │     │                   │
│  usePlaceSearch (예정)     │     │   /api/place          │     │  Kakao Local      │
│    → PlaceProvider ────────────→│     → KakaoProvider ───────→│  → Nominatim(미래)│
└─────────────────────┘     └──────────────────┘     └──────────────┘
```

**핵심 원칙**:
- 앱은 **인터페이스(Provider)**에만 의존한다
- 구체적인 API 제공자는 **Factory**에서 런타임에 결정한다
- BFF 서버가 API 키를 보유하고, 캐싱으로 호출 횟수를 절감한다

---

## 레이어 구조

```
app/                     ← UI 레이어 (Expo Router, 탭 네비게이션)
src/
  providers/             ← Provider 인터페이스 + 구현체 (핵심 추상화 계층)
    types.ts             ← 공통 인터페이스 정의
    arrival/             ← 도착 정보 Provider
    route/               ← 경로 탐색 Provider (예정)
    place/               ← 장소 검색 Provider (예정)
    factory.ts           ← Provider 생성 팩토리
  hooks/                 ← 비즈니스 로직 (Provider에만 의존)
  api/                   ← 레거시 API 호출 (Provider로 이전 중)
  store/                 ← Zustand 전역 상태
  utils/                 ← 순수 함수 (haversine, widget 등)
  components/            ← UI 컴포넌트
  data/                  ← 정적 데이터 (stations.json)
  types/                 ← TypeScript 타입 정의
```

---

## Provider 패턴 상세

### 인터페이스 계층

```typescript
// 모든 Provider는 이 인터페이스를 구현
interface ArrivalProvider {
  getArrival(stationName: string, options?: ArrivalOptions): Promise<StationArrival>
}
```

### 구현체 교체 시나리오

| 시나리오 | 변경 범위 | 앱 재배포 |
|---------|----------|----------|
| Seoul API → 다른 API | BFF 서버 Provider 파일 1개 | 불필요 |
| Kakao 지도 → OSM | BFF 서버 Provider 파일 1개 | 불필요 |
| 캐싱 전략 변경 | BFF 서버 cache 모듈 | 불필요 |
| BFF 없이 직접 호출로 복귀 | 환경변수 1개 변경 | 불필요 |

### Factory 패턴 (의존성 주입)

```typescript
// 환경변수로 Provider 전환
function createArrivalProvider(): ArrivalProvider {
  if (USE_BFF) return new BffArrivalProvider(BFF_URL)
  return new SeoulOpenApiProvider(API_KEY)
}
```

---

## BFF 서버

별도 저장소 `subway-now-bff`로 관리한다.

### 기술 스택
- **Node.js + Fastify**: 경량, 빠른 응답, TypeScript 네이티브 지원
- **Redis**: 응답 캐싱 (TTL 기반)
- **Docker Compose**: 로컬 실행 및 배포 환경 일치

### 캐싱 전략

| 데이터 | TTL | 근거 |
|--------|-----|------|
| 도착 정보 | 15초 | 실시간성 유지하면서 API 호출 절감 |
| 경로 탐색 | 5분 | 대중교통 시간표는 분 단위로 변경되지 않음 |
| 장소 검색 | 1시간 | POI 정보는 거의 정적 |

### API 엔드포인트

```
GET /api/arrival/:stationName  → 실시간 도착 정보
GET /api/route?from=&to=       → 대중교통 경로 탐색 (예정)
GET /api/place/search?q=       → 장소 검색 (예정)
GET /health                    → 헬스체크
```

---

## 기술 결정 기록 (ADR)

주요 아키텍처 결정은 [`docs/decisions/`](./docs/decisions/) 에 ADR(Architecture Decision Record) 형태로 기록한다.

| ADR | 제목 | 상태 |
|-----|------|------|
| [001](./docs/decisions/ADR-001-bff-layer.md) | BFF 레이어 도입 | 채택됨 |
| [002](./docs/decisions/ADR-002-provider-pattern.md) | Provider 패턴 적용 | 채택됨 |
| [003](./docs/decisions/ADR-003-caching-strategy.md) | BFF 캐싱 전략 | 채택됨 |
| [004](./docs/decisions/ADR-004-vendor-migration-path.md) | 벤더 마이그레이션 경로 | 채택됨 |

---

## 데이터 흐름

```
사용자 앱 시작
  → expo-location (GPS 좌표 획득)
  → useNearestStation (30초 폴링, haversine으로 500m 내 최근접 역)
  → useArrivalInfo (ArrivalProvider → BFF → Seoul Open API)
  → 화면에 실시간 도착 정보 표시
  → iOS 위젯에 SharedGroupPreferences로 데이터 공유
```
