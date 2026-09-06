# ADR-021: 경로 카테고리를 1급 개념으로 승격

## 상태

채택됨 — PR #194 (2026-05-11), 이슈 #193.

## 배경

역 경로 결과 화면에서 출발/도착역을 선택해도 "최적경로 / 최소환승" 탭 UI가 표시되지 않는 버그 발생. 사용자는 어떤 경로 옵션이 있는지, 무엇을 선택했는지 알 수 없음.

### 재현 시나리오

1. 같은 노선 두 역 선택 (예: 1호선 종로3가 → 시청) → 탭이 없음
2. 한 경로가 시간·환승 모두 우위인 경우 탭이 없음
3. 단일 환승만 가능한 노선 조합에서도 동일

### Root Cause (3개 결함 결합)

증상은 하나지만 원인은 데이터 레이어와 UI 레이어 양쪽의 독립적인 3개 결함이 결합되어 발생.

**1. UI 렌더 조건이 후보 배열 길이에만 의존**

```typescript
// app/(tabs)/index.tsx (수정 전)
{candidates.length > 1 && (
  <View ... testID="route-segment-control">{/* 탭 UI */}</View>
)}
```

후보가 1개 이하이면 탭 UI 자체가 렌더되지 않음. **"카테고리(최적/최소환승)"라는 1급 개념 없이 단순 배열 길이로 분기**.

**2. 경로 탐색이 strict domination 필터로 후보 축소**

```typescript
// src/utils/stationRoute.ts (수정 전)
const filtered = candidates.filter((c, i) => {
  // 다른 후보가 시간·환승 양면에서 우위면 현재 후보 제거
});
```

후보 풀이 1개로 축소됨. 직통은 원래 1개, 단일 환승만 가능한 경로도 1개로 줄어듦.

**3. 탭 라벨이 매직 조건으로 결정 (하드코딩)**

```typescript
// app/(tabs)/index.tsx (수정 전)
const label = c.transferCount <= 1 ? '최적경로' : '최소환승';
```

라벨이 후보의 환승 횟수와 배열 순서에 강하게 결합. **카테고리 수가 정확히 2개이고 후보도 정확히 2개일 거라는 암묵적 가정**.

## 결정

카테고리를 1급 개념으로 승격하고, **"탐색" 책임과 "카테고리별 선정" 책임을 분리**.

| 변경 위치 | 핵심 |
|---|---|
| `src/utils/stationRoute.ts` | `RouteCategory` 타입 + `ROUTE_CATEGORIES` 상수 (key/label/comparator) 도입. strict domination 필터 제거. 신규 `findRouteCandidatesByCategory(originIds, destinationId, categories?)` |
| `app/(tabs)/index.tsx` | `candidates`+`selectedIdx`(인덱스) → `categorized`+`selectedKey`(카테고리 키). 렌더 조건 `> 1` → `> 0`. 라벨 하드코딩 제거 → `category.label`. testID도 키 기반(`route-tab-optimal`) |
| `app/(tabs)/settings.tsx` | 하드코딩 카테고리 배열 → `ROUTE_CATEGORIES.map(...)` |
| `src/store/useAppStore.ts` | `loadRoutePreference` 검증을 `ROUTE_CATEGORIES.some(c => c.key === parsed)`로 파생 → 신규 카테고리 silently drop 방지 |
| `pickRouteByPreference` | 독립 정렬 → `ROUTE_CATEGORIES.comparator`로 통일 (단일 진실 소스) |

## 결과

### 자동 검증

- `npm test` — 46 suites, 690 tests, 커버리지 100%
- `code-reviewer` 에이전트 리뷰 — P0 0건, P1 2건 반영 (pickRouteByPreference 통일, loadRoutePreference 검증), P2 2건 반영

### 수동 (재현 시나리오 차단 확인)

1. 1호선 직통 두 역 선택 → "최적경로 / 최소환승" 두 탭 모두 표시, 둘 다 동일 직통 경로
2. 환승 필요 두 역 선택 → 두 탭 표시, 각 카테고리 시간/환승 수가 다르게 표시
3. 설정 화면에서 기본 경로 "최소환승"으로 변경 후 홈 진입 → 최소환승 탭이 기본 선택

## Lessons Learned

- **데이터 레이어가 UI 의사결정을 미리 하면 위험하다**. "후보를 버리는 책임"은 카테고리 선택 함수에 있어야지, 탐색 단계에서 미리 줄이면 UI 옵션이 silently 사라진다.
- **`length > 1` 같은 매직 조건은 카테고리 개념이 빠졌을 때 나오는 코드 냄새**. 첫 카테고리 도입 시점에 1급 개념으로 승격해야 회귀가 안 생긴다.
- **단일 진실 소스는 끝까지 따라가야 한다**. 카테고리 정의를 분리했어도 스토어 검증이 동기화 안 되면 새 카테고리 추가 시 silently drop된다.
- **회귀 버그는 종종 기능 도입 PR의 그림자**. #146(다중 경로 옵션 도입)에서 카테고리를 1급으로 만들지 않은 결과가 #193으로 돌아옴.

## References

- Issue #193, PR #194
- Notion: https://app.notion.com/p/35d30c0194b6811f908af53c2e4fe9b3
- 원본 기능 도입: Issue/PR #146
- 동일 영역 후속 버그 패턴: Issue #154
