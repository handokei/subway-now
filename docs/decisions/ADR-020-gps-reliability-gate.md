# ADR-020: GPS 신뢰성 게이트 도입 — 실시간성 우선 임계값

## 상태

채택됨 — PR #196 (2026-05-11), 이슈 #192. direct route 잔존 검증 미흡은 후속 #195로 추적.

## 배경

사용자가 실제로 타지 않은 역(예: 건대입구)에 "역 통과" 푸시 알림이 발송되는 버그 발생. 실시간 GPS와 위치 캐시 처리 로직에 신뢰성 검증이 없어, stale·저정확도 좌표가 그대로 "현재 역"으로 판정되고 즉시 알림이 발송됨.

앱의 핵심 가치는 "현재 역을 빠르게 알림"이므로, 단순히 알림 발송을 지연(grace period)시키는 대신 **좌표 자체의 신뢰성을 게이트로 검증**하는 방향으로 설계.

## 결정

4개의 GPS·알림 게이트를 도입하되, grace period는 두지 않고 첫 valid 좌표가 들어오면 즉시 알림 발송.

### 임계값 결정

| 게이트 | 값 | 근거 |
|---|---|---|
| MAX_LOCATION_AGE_MS | 30,000 (30초) | 한 정거장 이동 시간(~2분)보다 짧음. 5분 이상이면 2~3정거장 분 이동 가능. |
| MAX_ACCURACY_M | 150 | 지하/터널 진입 시 GPS는 ±100~150m가 흔함. 100m면 지하 환승역에서 진짜 좌표도 거부. |
| MAX_STATION_DISTANCE_KM | 1.0 | 한국 지하철 역간 평균 거리. 1km 초과면 "역 사이". |
| grace period | 없음 | 다른 게이트가 통과한 좌표는 신뢰. grace는 실시간성과 정면 충돌. |

### 트레이드오프 분석

**stale 캐시 임계값**
- 30초: 안전. GPS fix 1~2초 지연은 사용자가 거의 못 느낌 ← 채택
- 60초: 균형이지만 false 가능성 ↑
- 5분: 위험. 본 버그 시나리오와 일치

**정확도 임계값**
- 50m: 매우 엄격. 야외만 통과. 지하/실내 정상 좌표 거부
- 100m: 표준. 지하 환승역 일부 거부
- 150m: 실시간성 우선. 지하 진입 통과. 거리 상한이 2차 방어선 ← 채택
- 200m: 도심 빌딩숲 멀티패스 오차 통과 가능

**거리 상한**
- 0.5km: 환승역 광역에서 누락
- 1.0km: 한국 지하철 평균 역간 거리에 정확히 맞춤 ← 채택
- 1.5km: 역 사이 중간 지점에서도 표시

**grace period**
- 0초: 다른 게이트로 충분. 실시간성 손해 0 ← 채택
- 2~5초: 첫 valid 좌표를 의도적으로 무시 → 실시간성 손해

## Architecture

### 4개 결함 → 4개 게이트

1. **stale 캐시 위치 차단** (`useNearestStation`, `backgroundLocationTask`)
   - `getLastKnownPositionAsync.timestamp`가 30초 초과 시 캐시 무시, watch만 시작
2. **GPS 정확도 필터** (위 두 곳)
   - `coords.accuracy > 150m` 시 좌표 자체를 무시
3. **거리 상한** (`findNearestStation`)
   - `findNearestStation(lat, lng, maxDistanceKm?)` 시그니처 확장. 최소 거리가 maxDistanceKm 초과면 null 반환
4. **경로상 역 검증** (`stationPipeline`, `useStationAlarm`)
   - per-station 알림 발송 직전 `isStationOnRoute(station, route)` 검증. 경로 외 노선의 역에서는 알림 skip
   - direct route는 후속 #195로 추적

### 공유 유틸

`src/utils/locationGates.ts`에 `isLocationFresh` / `isAccuracyAcceptable`을 분리하여 포그라운드와 백그라운드가 동일 검증을 공유. 임계값 변경 시 한 곳만 수정.

## 결과

### 긍정

- 본 버그 시나리오(어제 캐시 → 오늘 다른 곳)에서 false 알림 차단 확인
- 실시간성 유지: 첫 valid 좌표 즉시 알림
- 게이트는 데이터 주도(상수) → 임계값 튜닝 용이
- 커버리지 100% 유지 (711 tests)

### 부정

- 지하 환승역에서 GPS가 매우 약하면 (>150m) 첫 표시가 GPS fix 후로 지연 가능 (수 초)
- direct route의 경우 isStationOnRoute가 노선 검증 못함 → 잔존 위험 (후속 #195)

## References

- Issue #192, PR #196
- Notion: https://app.notion.com/p/35d30c0194b681afbbe2dbfcba51480e
- 트러블슈팅: 건대입구 false 통과 알림
- 관련 ADR: ADR-019 (알림 상태 단일 출처)
