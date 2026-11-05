# ADR-018: Feature-based + Ports & Adapters 디렉토리 재정비

## 상태

채택됨 — Phase 5 완료 + Step 6 (store 분해 #893) + Step 7 (thin route + thick screen #895) 완료.

## 배경

기존 `src/` 하위가 **기술 레이어(api/hooks/store/utils/components)** 로만 쪼개져 있어 god folder 증상 발생:

- `src/utils` 108개, `src/components` 40개(평탄), `src/hooks` 43개 — 단일 폴더 비대화
- 한 도메인(알람, 역검색, 위젯, 지도, 즐겨찾기, 경로)이 6~7개 폴더에 흩어져 있어 파일 점프 비용 증가
- 알람 SLA 아키텍처(#584~), realtimePosition 로드맵(#322~) 등 도메인 단위 큰 작업의 경계가 코드에 안 보임
- 새 작업자(혹은 미래의 sub-agent)가 "역 검색 관련 코드 다 찾아줘"라고 했을 때 grep 의존도가 너무 높음

GitHub 스타 상위 React 아키텍처(bulletproof-react ~26k★, Obytes Expo Starter)는 일관되게 **feature-based + 단방향 의존**을 권장. Spring 멘탈 모델과도 정합 — `domain/<이름>` ≈ `features/<이름>`, `global/` ≈ `shared/`.

## 옵션 비교

| 패턴 | 채택했다면 | 거절 이유 |
|---|---|---|
| **그대로 (Layered)** | api / hooks / components / utils / store 평탄 | god folder 만들어서 ADR이 깨려는 출발점 |
| **Clean Architecture (Uncle Bob)** | UseCase / Interactor class 잔뜩, 4계층 강제 | React 함수형 + hooks 결에 안 맞음. boilerplate 폭증 |
| **Feature-Sliced Design (FSD)** | layer × slice 2D 구조 (7-layer 강제) | 학습 곡선 1-2주. 작은 모바일 앱엔 over-spec |
| **풀 DDD (Aggregate/Entity/Repository)** | 도메인 모델 강제, Repository 패턴 풀 적용 | single bounded context, 비즈니스 복잡도가 banking 수준 아님 |
| **Feature-based + Ports & Adapters (Hexagonal lite)** | `features/<slice>` × `shared/` + 4 Port | ✅ **채택** |

bulletproof-react가 base인 정량 근거:
- GitHub star 26k (FE 아키텍처 카테고리 압도)
- 토스/배민 등 사실상 같은 패턴
- `import/no-restricted-paths`로 lint가 강제 (의도가 아닌 도구가 보장)
- 학습 곡선 1-2일 (FSD의 1-2주 대비)

## 결정

### 목표 구조

```
src/
├── app-shell/                 # 앱 부트스트랩 (= Spring @Configuration)
├── features/                  # 도메인별 수직 슬라이스 (= Spring domain/)
│   ├── nearest-station/       # GPS → 가장 가까운 역
│   ├── arrival/               # 도착정보 (Bff/SeoulOpenApi/Mock Provider)
│   ├── alarm/                 # 알람 (BoardingLock, ScheduledAlarms)
│   ├── route/                 # 경로 탐색
│   ├── map/                   # 지도 + WebView HTML
│   ├── widget/                # 홈위젯 연동
│   └── settings/              # 취침모드, 언어, 테마
├── shared/                    # 모든 feature 공유 (= Spring global/)
│   ├── ui/                    # 디자인 시스템
│   ├── theme/, i18n/
│   ├── infra/                 # ★ Ports & Adapters의 Adapter 측
│   ├── ports/                 # 추상 인터페이스
│   ├── constants/, types/, utils/
└── data/                      # 정적 데이터
```

### 의존 규칙 (단방향, ESLint로 강제)

```
shared (= global)         → 어디서나 import 가능
features/* (= domain)     → shared만 import 가능, 다른 feature 직접 import 금지
app-shell, app/           → features + shared import 가능
```

`import/no-restricted-paths` ESLint 룰로 CI에서 강제.

### Port 채택 4조건 (정량 기준)

bulletproof는 외부 의존성 **직접 호출**이 표준. 하지만 다음 4조건을 모두 만족하면 Port 신설이 정당화된다.

1. 외부 라이브러리 + 실제 Mock 필요
2. 도메인 비즈니스와 강결합
3. 라이브러리 교체 가능성 실제 있음
4. Platform 분기 필요

| 외부 의존성 | 결정 |
|---|---|
| Notification (expo-notifications) | **Port 유지** — suppress 정책 / 취침모드 / FCM 검토 이력 / iOS-Android 분기 |
| Location (expo-location) | **Port 유지** — E2E mock 필수 / GPS fusion 핵심 / geolocation 대체 가능 |
| Widget Storage (SharedGroupPreferences) | **Port 유지** — iOS native / 위젯 데이터 모델 = 도메인 |
| AsyncStorage | **Port 거절** — 단순 KV, RN 표준, 교체 시나리오 거의 없음 |

## 점진적 마이그레이션 (5단계)

1. **chore: shared/ 신설 + ESLint 경계 룰** (허용 모드)
2. **refactor: features/alarm 슬라이스** (가장 큰 도메인부터)
3. **refactor: features/arrival + nearest-station + route**
4. **refactor: features/map + favorites + widget + settings**
5. **chore: ESLint 경계 enforce + 잔여 정리**

각 단계는 별도 PR + 100% 커버리지 유지. 파일 이동은 `git mv`로 lineage 보존.

### Step 6/7 후속 (완료)

- **Step 6** (#893): `useAppStore` god object 분해 — 7개 store + `setDestination` orchestration은 file-level eslint-disable 옵트인
- **Step 7** (#895): 화면 분리 — `app/(tabs)/*.tsx` 2-3줄 re-export, 본체 `src/screens/{Home,Map,Favorites,Settings,Language}Screen.tsx`
- **Step 8**: 취소 (AsyncStorage Port 거절 결정과 일관)

## 결과

- 시스템 아키텍처 가독성 ↑
- sub-agent도 컨텍스트 격리되어 작업 가능 (BG agent worktree 패턴과 정합)
- "왜 이렇게 설계했나" 면접 질문에 5초 답변 가능
- 새 외부 의존성 추가 시 4조건 표로 일관 판정 가능

## References

- Notion: https://app.notion.com/p/36e30c0194b68148ba29f2bc4554ce8a
- bulletproof-react (alan2207, ~26k★)
- 관련 PR: Step 6 #893 / Step 7 #895
