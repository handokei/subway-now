# ADR-005: 급행 정차역 데이터셋

- 상태: Accepted
- 일자: 2026-05-19
- 관련 이슈: #425

## 컨텍스트

`stations.json`은 모든 역에 대한 좌표/노선/이름만 제공하고, 어느 역이 급행/특급/ITX 정차역인지 알 수 있는 메타데이터가 없다. 사용자가 현재 보는 역이 급행 통과역인지 알 수 없어 다음 문제가 발생한다:

- 통과역에서 급행 도착 알림만 보고 헛되이 대기
- 목적지가 통과역인데 급행에 탑승해 지나침
- 급행 다음 정차역 미리보기, 급행 필터 등 후속 기능이 불가능

## 결정

급행 정차역을 별도 정적 데이터셋(`src/data/expressStops.ts`)으로 관리한다.

### 데이터 구조

```ts
Partial<Record<LineNumber, Partial<Record<TrainType, ReadonlySet<stationName>>>>>
```

- **노선 키는 `LineNumber` 타입 (`src/types/station.ts`)**: stations.json의 `line` 필드 값과 동일(`'1'`·`'9'`·`'bundang'`·`'gyeongui'`·`'airport'` 등). 컴파일 타임 타입 검증.
- **역 키는 `stations.json`의 `name`**: station id는 API/내부 데이터 갱신으로 변동될 수 있어 더 안정적인 이름으로 join. 일부 역은 부제 포함 이름(`'이촌(국립중앙박물관)'`, `'왕십리(성동구청)'`)으로 등록되어 있으므로 stations.json 표기와 정확히 일치시킨다.
- **TrainType별 분리**: ITX와 특급이 다른 정차 패턴을 갖는 경우를 자연스럽게 표현.
- **노선/타입 단위 누락 허용**: 8호선처럼 급행이 없는 노선은 단순히 키가 없다.
- **stations.json 미포함 역은 등록하지 않음**: 1호선 경부선 수원 이남, 9호선 가락시장/올림픽공원, 경춘선 등은 stations.json에서 해당 노선으로 등록되지 않아 매칭이 일어나지 않으므로 데이터셋에서도 제외한다. stations.json 확장 시 별도 PR로 함께 추가.

### 조회 유틸 (`src/utils/expressLookup.ts`)

- `isExpressStop(name, line, type)`: 데이터가 없거나 `normal`이면 `true` — "알 수 없을 때 통과라고 단정하지 않음"이 사용자 안전성 측면에서 더 보수적.
- `getExpressStopsOnLine(line, type)`: 빈 셋 fallback. `normal`은 빈 셋(의미 없음).

## 대안

1. **station id 기반 매핑** — 거부. stations.json 형식이 바뀌면 일일이 갱신 필요.
2. **stations.json에 `expressTypes: string[]` 필드 추가** — 거부. 528개 역 중 급행 관련 역은 ~100개로 sparse하다. 단일 데이터셋이 검토/갱신에 유리.
3. **외부 API에서 매번 조회** — 거부. 서울 열린데이터 API는 정차 패턴을 안정적으로 노출하지 않으며, 30초 폴링마다 비용 증가.

## 갱신 정책

- 노선 운영사(서울교통공사·코레일·공항철도)의 시간표가 변경되면 PR 형태로 갱신.
- 출처 변경 시 본 ADR의 "출처" 섹션 갱신.
- 신규 노선/급행 패턴 추가 시: `expressStops.ts`에 키 추가만으로 동작 (코드 변경 불필요).

## 출처

- 서울교통공사 공식 시간표 (https://www.seoulmetro.co.kr) — 1·9호선
- 코레일 광역철도 시간표 (https://www.letskorail.com) — 경부/경인 1호선 급행, 경춘선, 수인분당선, 경의중앙선
- 공항철도 직통열차 안내 (https://www.arex.or.kr) — 공항철도

기준일: 2026-05-19.
