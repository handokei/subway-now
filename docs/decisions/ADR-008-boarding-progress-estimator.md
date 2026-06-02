# ADR-008: 탑승 진행 추정을 관측 구동(Observation-driven)으로 전환

## 상태

제안됨 (2026-06-02)

관련: #584(BoardingLock), #621(시간 interpolation), #624(hopTime lookup), #622(BFF sync)

## 배경 — 증상

활성 trip 중 화면/알람의 현재역이 **실제 탑승 열차보다 1~2개역 앞서가는** 현상이 보고됨.
"타기 전에 곧 도착할 열차를 미리 탭하면 더 심해진다"는 사용자 관찰이 핵심 단서.

### 디버그 로그 근거

```
## Arrival
up:   성수행 16s (1분 후)
down: 성수행 46s (전역 도착)     ← 아직 한 정거장 전인 열차도 목록에 노출/탭 가능

## Alarm log
08:35:11 | fg | fired | station-passed | 건대입구
08:35:39 | fg | fired | station-passed | 성수      ← 28초 만에 다음 역 통과(실 이동보다 빠름)
```

## 원인 분석

현재역을 1~2개역 앞으로 밀어내는 유일한 메커니즘은 **BoardingLock 시간 interpolation**
(`boarding-lock-interp`)이다. 도착정보 융합만으로는 `MAX_FUSION_DELTA_KM = 0.2km` 제한 때문에
1~2개역(역간 ~1km)을 앞설 수 없다. 즉 증상은 lock 활성 trip 중에만 발생한다.

해당 보간이 어긋나는 3가지 구조적 이유:

### ① 탭한 "순간"을 탑승 시각으로 고정

`src/hooks/useBoardingLockController.ts:114`

```ts
boardedAt: Date.now(),   // 열차를 탭한 순간
```

`BoardingTrainList`의 현재역 목록은 `walkingBufferSeconds`가 없어 **아직 도착하지 않은 열차
("전역 도착", "1분 후")도 탭 가능**(`BoardingTrainList.tsx:60-61`). 미리 탭하면:

- 탭 시각 `T0`에 `boardedAt = T0`
- 열차는 `T0 + 60~120초`에 플랫폼 도착 → 정차 → 출발
- **열차가 탑승역을 떠나기도 전에 보간 시계는 이미 60~120초를 소비** → 출발 시점에 +1 hop

### ② HOP 시간이 90초 고정 — 실제보다 짧음

`src/constants/boardingLock.ts:23`

```ts
export const HOP_TIME_MS = 90_000;   // uniform 90s
```

`src/utils/boardingLockInterpolation.ts:50-54`

```ts
const hopsElapsed = Math.floor(elapsed / HOP_TIME_MS);          // floor((now - boardedAt)/90s)
const idx = Math.min(boardingIdx + hopsElapsed, lastIdx);
```

서울 도심 역간 실소요는 정차 포함 보통 120~150초. 90초 계산은 **매 hop마다 30~60초씩 앞서간다.**
(상수 주석에도 `노선별/시간대별 정밀화는 후속(#624)`로 명시됨.)

### ③ 전진 래칫(monotone forward) — 뒤로 보정 불가

`src/hooks/useFusedNearestStation.ts:363-377`

```ts
if (chosenIdx === -1 || interpResult.index > chosenIdx) {   // 보간이 GPS보다 앞설 때만 override
  result = { station: interpResult.station, ... };
  confidence = 'boarding-lock-interp';
}
```

한 번 앞서가면 GPS가 더 앞서기 전까지 되돌아오지 않는다. 지하 dead zone에서 GPS가 stale이면
보간이 계속 이겨 **앞선 편향이 고착**된다.

### 누적 효과

| 요인 | 누적 오차 |
|---|---|
| ① 도착 전 열차를 미리 탭 | 출발 시점에 이미 +1 hop |
| ② HOP 90초 < 실제 ~135초 | hop당 +약 45초 → 3~4정거장이면 +1 hop 추가 |
| ③ 전진 래칫 | 벌어진 격차가 GPS로 안 좁혀짐 |

→ 출발 직후 1개역, 몇 정거장 지나면 2개역까지 앞서감. 보고된 증상과 정확히 일치.

> `useMisBoardingDetector`는 *열차 자체가 틀린 경우*만 잡으므로, 열차는 맞고 타이밍 모델만
> 틀린 이 케이스는 검출하지 못한다.

## 핵심 통찰 — 진짜 신호는 이미 들어와 있다

`90_000` 시간 적분은 원래 **실시간 위치 신호가 stale일 때만 메꾸는 보조 신호**여야 한다.
그런데 코드베이스는 이미 다음을 파싱해 보유한다:

| 신호 | API / 파일 | 내용 |
|---|---|---|
| 실시간 열차 위치 | `realtimePosition` → `positionApi.ts` (`TrainPosition`) | `trainNo`별 현재역(`statnId`) + 진입/도착/출발(`trainStatus`) + 신선도(`receivedAtMs`) |
| 도착 ETA | `realtimeStationArrival` → `arrivalApi.ts` (`ArrivalInfo`) | 역별 `trainCode`의 남은 초(`arrivalSeconds`) + `arrivalCode` |
| 탑승 잠금 | `BoardingLock.trainCode` | 사용자가 탭한 바로 그 열차 식별자 |

> 코드베이스는 이미 `arrival.trainCode === position.trainNo`를 동일 식별자로 취급한다
> (`useFusedNearestStation`의 `trainProgress.trainNo === lockedTrainCode` 매칭).
> 즉 **탭한 열차 → 실시간 위치 직접 조회**가 원래 가능하다.

## 결정

탑승 진행 추정을 **시간 적분(dead reckoning)에서 관측 구동(observation-driven)으로 전환**한다.
`HOP_TIME_MS` 매직넘버를 데이터 테이블/Provider로 추상화하고, 추정은 4단 전략 우선순위로 합성한다.
기존 arrival/position Provider 패턴(ADR-002)과 동형으로 설계해 OCP·테스트 용이성을 유지한다.

```
StationProgressEstimator (lock.trainCode 기준 현재역 추정)
 ├─ ① LivePositionStrategy   — realtimePosition에서 trainNo 직접 발견 → 그 statnId (정확, 보간 0)
 ├─ ② ArrivalEtaStrategy     — 다음 역 arrival에서 trainCode 발견 → arrivalSeconds로 실 ETA 투영
 ├─ ③ ReanchoredHopStrategy  — ①②가 마지막으로 본 (역, 시각)에 재앵커 + 실측 hop time
 └─ ④ DefaultHopStrategy     — 최후수단, per-line/segment 데이터 테이블 (90초 매직넘버 제거)
```

### ① LivePositionStrategy — 보간 자체가 불필요

`trackTrainProgress`를 `lock.trainCode`로 조회. 위치 API가 신선하면(`receivedAtMs > 0`, TTL 내)
추정이 아니라 **사실**이다. 이 신호가 살아있는 동안 보간 코드는 돌지 않는다. → 지상 + API 정상 시 drift=0.

### ② ArrivalEtaStrategy — 실측 ETA로 hop 시간 대체

①이 stale이면 **경로상 다음 역의 도착정보를 폴링**해 `trainCode === lock.trainCode`인 행의
`arrivalSeconds`를 읽는다. 이것이 "내 열차가 다음 역까지 진짜 몇 초"다. 90초 추측 대신 실측 ETA로
투영하고, `arrivalCode`(전역도착 5 / 진입 0 / 도착 1)로 현재역도 정밀 판정한다.

### ③ ReanchoredHopStrategy — multi-station drift 제거 (핵심)

①②도 끊긴 완전 dead zone에서만 동작. **`lock.boardedAt`(탭 시각) 대신, 마지막으로 위치 API가
이 trainNo를 본 `(역 인덱스, 관측 시각)`에 재앵커**한다:

```
idx = lastObservedIdx + floor((now - lastObservedTs) / hopTime)
```

위치 API는 5초 폴링이라 역이 바뀔 때마다 앵커가 갱신된다 → **보간이 메꾸는 구간은 최대 1 hop**.
출발역부터 N hop을 통째로 적분하지 않으므로 "1~2개역 앞섬"이 구조적으로 불가능해진다.
(원인 ①의 정면 해결)

### ④ DefaultHopStrategy — 90_000을 데이터 테이블로

①②③ 전부 없을 때만 쓰는 기본 hop time조차 매직넘버 대신 데이터 구동:

```ts
// src/constants/hopTimes.ts (#624)
// 측정값으로 점진 채움. 미등록 segment는 line 평균 → 전역 기본 순으로 fallback.
export const HOP_TIME_TABLE: Record<LineNumber, number> = { '2': 132_000, '7': 126_000, /* ... */ };
export function resolveHopTimeMs(line: LineNumber, fromId?: string, toId?: string): number { /* ... */ }
```

②③에서 관측한 실측 hop 소요를 세그먼트별 캐시에 누적하면 테이블이 자가 보정된다.

## 이유 / 확장성

1. **Provider 패턴 일관성(ADR-002)**: `src/providers/arrival`·`src/providers/position`과 동형.
   순수 함수 + 전략 배열로 두면 테스트 100% 커버 용이, 새 신호원 추가 = 전략 1개 추가.
2. **백엔드 위임 엔드게임(#622)**: lock의 `trainCode`는 이미 BFF로 sync됨. ETA/hop을 서버가
   권위 있게 내려주면 앱은 소비만 — ②를 `BffProgressProvider`로 빼면 자연스럽게 확장.
3. **신선도 계약 재사용**: `receivedAtMs`(0=stale) 규약이 arrival/position 양쪽에 통일돼 있어
   전략 간 신뢰도 비교가 추가 비용 없이 가능.
4. **데이터 구동(글로벌 규칙 3)**: 노선/세그먼트 분기를 if-else가 아닌 `HOP_TIME_TABLE` 데이터로.

## 구조 / 변경 대상

| 파일 | 변경 |
|---|---|
| `src/utils/boardingLockInterpolation.ts` | `lock.boardedAt` 앵커 → `lastObservedStation/Ts` 앵커로 시그니처 변경 (전략 ③) |
| `src/utils/stationProgressEstimator.ts` (신규) | 4단 전략 합성, 순수 함수 |
| `src/constants/hopTimes.ts` (신규) | `HOP_TIME_TABLE` + `resolveHopTimeMs` — `HOP_TIME_MS` 매직넘버 대체(#624) |
| `src/hooks/useFusedNearestStation.ts:355-378` | interp 호출부를 estimator 호출로 교체, `lock.trainCode`로 ①② 신호 주입 |
| `src/hooks/useBoardingLockController.ts` | `boardedAt`는 자동만료(`isBoardingLockExpired`) 용도로만 유지 — 추정에서 분리 |

## 트레이드오프

| 장점 | 단점 |
|------|------|
| 매직넘버 제거, trip 정확도가 실제 API 신호로 구동 | estimator + 전략 레이어 추가 |
| dead zone에서도 drift가 최대 1 hop로 제한 | 다음 역 arrival 추가 폴링(②) — fusion 캐시와 dedup 가능 |
| 새 신호원/백엔드 위임을 전략 추가로 흡수 | 전략 우선순위·신선도 경계 테스트 필요 |

**판단**: `90_000`은 trip 정확도를 좌우하는 1차 신호가 아니라 4순위 데이터 테이블의 기본값으로만
남아야 한다. 핵심 한 줄 요약 — **"탭 시각 + 고정 90초로 적분"을 "탭한 trainCode를 실시간 위치/
도착 API로 추적, 끊기면 마지막 실관측에 재앵커"로 바꾼다.**

## 결과 (기대)

- 미리 탭한 trip에서도 현재역이 실제 열차 위치를 추종 (drift ≤ 1 hop)
- `HOP_TIME_MS` 의존 제거 → 노선/구간/시간대 확장이 데이터 추가만으로 가능
- 추정 로직이 fusion에서 분리돼 단위 테스트·재사용성 향상

## 구현 단계 (제안)

1. 전략 ① + ③(재앵커)만 우선 — 가장 큰 drift 원인을 최소 변경으로 제거
2. 전략 ② ArrivalEtaStrategy 추가 — hop time 실측화
3. 전략 ④ `hopTimes.ts` 데이터 테이블로 매직넘버 대체(#624)
4. (엔드게임) `BffProgressProvider`로 ② 서버 위임(#622)
