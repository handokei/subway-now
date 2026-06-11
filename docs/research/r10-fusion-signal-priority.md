---
issue: 1008
title: "R-10 — fusion 신호 우선순위 모호 audit + A2-new sub-issue 후보 spec"
created: 2026-06-11
related:
  - "#1008"
  - "#662"
  - "#707"
  - "#1015"
  - "#1016"
  - "#1017"
  - "#921"
  - "#444"
  - "#445"
  - "#584"
  - "#739"
---

# R-10 — fusion 신호 우선순위 모호 audit + A2-new sub-issue 후보 spec

> SSOT: `tasks/epic-lockless-overfire-guard.md` §5 R-10 (`A2-new`, 미착수).
> 본 문서는 R-10에 대한 코드 audit + A2-new 후보 spec 제안. 실제 sub-issue 발행은 사용자 결정 대기.

---

## 1. 현재 fusion 신호 우선순위 audit

### 1.1 위치

| 파일 | 역할 |
| --- | --- |
| `src/features/nearest-station/hooks/useFusedNearestStation.ts` | **메인 결정 사이트.** 모든 source(positionTrainResult, fused, routeResult, gps, estimator)가 한 컴포넌트 안에서 분기되어 `result/confidence/source`를 결정 |
| `src/features/nearest-station/utils/pickFusedStation.ts` | 후보별 arrival + position 두 신호로 단일 후보를 픽 (`fused` branch의 산출물) |
| `src/shared/types/fusion.ts` | `FusionConfidence` (9개) + `FusionSource` (8개) union 정의 |
| `src/features/nearest-station/utils/movementGate.ts` | `shouldDowngradeFusion` — 정적 사용자 misfire 가드 |
| `src/features/nearest-station/utils/fusionDistanceGate.ts` | `passesFusionDistanceGate` — 채택 직전 거리 sanity |

### 1.2 현재 우선순위 (useFusedNearestStation, line 431~628)

```
1. positionTrainResult            (TTL + 거리 + lock-line + arc-window + forward-only 통과 시)
   ├─ trainProgress.trainNo == lockedTrainCode  →  confidence/source = 'boarding-lock'
   └─ 그 외                                       →  confidence/source = 'position-train'

2. fused (pickFusedStation)        (gate pass + (lock 없거나 lock-line 일치))
   ├─ arrival 점수 ≥ 100  →  'arrival-confirmed'
   ├─ position 점수 > 0   →  source='position'
   └─ arrival 점수 > 0    →  source='arrival', confidence='arrival-arriving'

3. routeResult (useRouteProgress)  →  'route-progress'  (gate pass 시)

4. gps.result                       →  'gps-only'

[override 단계]
5. estimator (ADR-008)             →  forward + observation ceiling 통과 시 1~4를 'boarding-lock-interp'로 덮어씀

[강등 단계]
6. shouldDowngradeFusion (정적+accuracy)  →  'gps-only'로 강등 + result도 gps.result로 되돌림
7. barometer.subsurface=true + 'gps-only' →  'gps-only-underground'로 confidence 강등 (source 유지)
```

### 1.3 pickFusedStation 내부 규칙 (`pickFusedStation.ts:79~119`)

- 후보별 점수 = `max(arrival_priority, position_priority)`
- 최댓값 후보 선택 → 동점이면 거리 가까운(=index 작은) 후보
- source 라벨 tie-break: `winnerPosScore >= winnerArrScore` → `'position'` 우선, 아니면 `'arrival'`
- 모두 0 → GPS 최근접 + `'gps-only' / 'gps'`

### 1.4 신호별 명시·암묵 trust

| 신호 | 명시 위치 | 암묵 trust 순위 (코드 흐름) |
| --- | --- | --- |
| BoardingLock + position-train trainCode match | `useFusedNearestStation:456~464` (#584 PR D2) | 1 — 최고 |
| position-train (lock-line 일치) | `useFusedNearestStation:401~420` | 2 |
| position-train (lock 없음, GPS sanity 통과) | 같은 블록 | 2 |
| pickFusedStation 'position' source | `pickFusedStation:111~112` | 3 |
| pickFusedStation 'arrival-confirmed' | `pickFusedStation:62~63` | 4 (점수상 position과 동급이나 source label은 후순) |
| pickFusedStation 'arrival-arriving' | 같은 위치 | 5 |
| routeResult (1D map matching) | `useFusedNearestStation:469~472` | 6 |
| boarding-lock-interp (estimator override) | `useFusedNearestStation:567~609` | 1~4를 덮어씀 — *별도 layer* |
| gps-only / gps-only-underground | `useFusedNearestStation:473~477, 634~636` | 7 (fallback) |

### 1.5 모호함의 구조적 근원

- 우선순위가 **단일 함수**가 아닌 `useFusedNearestStation` 내 **순차적 if/else + override + 강등** 블록 5단계로 흩어져 있음.
- pickFusedStation은 `arrival`/`position`만 보고 `BoardingLock`/`routeContext`/`estimator`/`barometer` 신호는 모름 → 호출자가 책임 분담.
- "trust hierarchy"가 코드에 weight나 table로 적혀있지 않고 if/else 순서로만 표현됨 → 새 신호(wifi-ssid, sensor fusion) 추가 시 어디에 끼워넣을지 결정 트리 부재.

---

## 2. 모호한 케이스 identification

A. **GPS top-1과 position-train이 다른 station을 가리킴**
   - 현재: position-train 우선 (line 456). `passesFusionDistanceGate` + lock-line check만 통과하면 채택.
   - 모호함: lock 없는 일반 trip에서 position-train이 GPS top-3 후보 중 GPS top-2/3을 가리키면 GPS top-1을 무시. `gateOpts.gpsNearest`로 거리 차이만 체크.
   - 사고 사례: #662 — 환승역에서 옆 노선 통과 열차에 position-train sticky 잠금.

B. **fused 점수(arrival)와 position-train이 다른 station**
   - 현재: position-train이 항상 우선.
   - 모호함: arrival API가 'ARRIVED'(점수 100+) 보고하는데 position-train이 다른 station이면 arrival을 무시. arrival이 "도착 확정" 신호인데도 후순.
   - 정당화: position-train은 trainNo 단위 직접 매칭이라 더 정확하다는 가정. 그러나 `trackTrainProgress`의 sticky/disambiguation 실패 시 신뢰 역전.

C. **BoardingLock 활성 + position-train mismatch (trainCode 불일치)**
   - 현재: trainCode 미일치면 `'position-train'`으로 라벨링 (line 463). `'boarding-lock'` 승격 조건은 `lockMatch === true`.
   - 모호함: position-train이 lock-line 일치 + trainCode 불일치면 채택은 되지만 신뢰는 한 단계 강등. 이 강등이 알람 dedup/UI 표시에 어떻게 반영되는지 호출자별로 다름.

D. **arrival-confirmed vs position-train arvlCd ∈ {0,1}**
   - pickFusedStation 내부: 두 신호원이 같은 priority enum을 공유하지만, `arvlCd=0/1`(전역/도착) 정수 score와 `trainStatus` 정수 score가 점수만 같아도 의미가 다를 수 있음.
   - 동점 시 `winnerPosScore >= winnerArrScore`로 position 우선.
   - 모호함: 점수 동률 시 어느 신호가 더 정확한지에 대한 도메인 결정이 단일 비교 연산자(`>=`)에 묻혀있음.

E. **estimator (boarding-lock-interp) vs position-train**
   - 현재: estimator는 `withinObservationCeiling`을 통과해야 채택 (`useFusedNearestStation:567~609`). position-train이 신선(`freshTrainProgress`)일 때는 strategy='live-position'이라 interpolation으로 흐르지 않음.
   - 모호함: position-train이 게이트 탈락(거리·forward·lock-line) → null이 되면 estimator가 'live-position' strategy를 잃고 ②/③/④로 흘러감. 이때 estimator override가 발생할 수 있는데, "탈락한 position-train"의 마지막 관측을 신호로 쓰는지 여부가 명시되어 있지 않음.

F. **routeResult vs gps**
   - 현재: routeResult가 gate를 통과하면 무조건 gps보다 우선.
   - 모호함: routeResult는 1D map matching 진행도로 GPS 점프에 면역이지만, 자체 검증 신호가 없음(타입 코멘트 명시). gps가 정확한데 routeResult가 stale한 경우 구분 불가.

G. **wifi-ssid (#913) 통합 미정**
   - 타입은 정의됐고 cascade의 첫 단계로 사용한다는 코멘트는 있으나, 본 우선순위 결정 사이트(`useFusedNearestStation`)에 wifi-ssid가 들어갈 위치가 코드에 미반영. 향후 추가 시 어느 단계에 끼울지 결정 트리 부재.

H. **barometer signal (sensor fusion) 통합 미정**
   - `detectionVerdict` (`useFusedStationDetection`)가 별도 hook으로 분리되어 측정 entry에만 첨부되고 cascade 결합 없음 (`useFusedNearestStation:638~661` 코멘트 명시: "본 PR에서는 cascade 비결합 — verdict만 측정").
   - 모호함: 향후 cascade 결합 시 어느 단계에서 강등/승격에 쓸지 spec 없음.

---

## 3. 모호함이 일으킨 실제 사고/회귀

| Issue | 현상 | 우선순위 결정과의 연결 |
| --- | --- | --- |
| #662 | 환승역 정지 시 옆 노선 통과 열차에 position-train sticky 잠금 | position-train이 lock-line/route context보다 우선 → lock-line check 추가로 봉합 (`useFusedNearestStation:401~403`) |
| #707 | BG/silent push/lock 생성 3곳에서 BoardingLock line 가드 부재 | 우선순위 분기가 FG에만 있고 BG path는 별도 — 우선순위 분산이 가드 누락을 유발 |
| #1015 (RC3) | hydrate 직후 첫 cycle에서 backward jump 시 차단 못 함 | position-train forward-only 가드가 없어 우선순위 1번이 잘못된 station 채택 |
| #1016 (RC3) | `userLocation=null` placeholder / accuracy>200m bypass / line-only check 3개 hole | 우선순위 1번(position-train) 진입 게이트 3 hole — 우선순위 자체보다 게이트 정의가 모호한 사례 |
| #1017 (RC4) | `trackTrainProgress` forward-only 가드 없음 | position-train 입력 신호의 sticky/disambiguation 모호 — backward jump 노출 |
| #739 (ADR-008) | estimator backward 정정 시 'station-passed' 알람 재발사 | estimator override layer가 monotone forward만 허용 — 강제 직교 layer로 만든 결정 |
| #898 (Seam B) | LivePosition/ArrivalEta dead-zone에서 적분이 물리 위치보다 앞서 발산 | estimator override 안전 디폴트(observation ceiling) — 우선순위 override 정책의 안전 디폴트 |
| #444 / #445 | fused/route 거리 sanity + position-train TTL 만료 sticky 해제 | 우선순위 단계 간 cross-cutting 게이트가 사이트별로 흩어짐 |
| #921 (B1) | sensor fusion verdict cascade 미결합 — 측정만 | 우선순위 통합 spec 부재로 결합 시점이 미뤄짐 |

**공통 패턴**: 사고가 발생하면 그 사이트에 가드 한 줄을 추가하는 방식으로 봉합 → 가드가 우선순위 사이트 5개에 분산. R-10이 "모호하다"고 표현한 이유는 사고가 날 때마다 가드가 늘어나서 결정 트리가 추적 불가능해짐.

---

## 4. 우선순위 명확화 spec

### 4.1 단일 진입점

`useFusedNearestStation`의 결정 블록(line 431~628)을 단일 함수 `decideFusionResult(...)`로 추출.

```ts
// src/features/nearest-station/utils/decideFusionResult.ts (신규)
export interface FusionDecisionInput {
  gpsResult: NearestStationResult | null;
  candidates: NearestStationResult[];
  fused: FusedStationResult | null;
  positionTrainResult: NearestStationResult | null;
  positionTrainProgress: TrainProgress | null;
  routeResult: NearestStationResult | null;
  estimate: StationProgressEstimate | null;
  boardingLock: BoardingLock | null;
  lockedTrainCode: string | null;
  arcStations: Station[];
  // 강등/override 입력
  speedMps: number | null;
  accuracyM: number | null;
  positionStability: PositionStability;
  motionStationary: boolean | undefined;
  barometerSubsurface: boolean | undefined;
  detectionVerdict: FusionDetectionVerdict | null;  // #921 cascade hook
}

export interface FusionDecisionOutput {
  result: NearestStationResult | null;
  confidence: FusionConfidence;
  source: FusionSource;
  /** 채택된 단계 라벨 — 측정/디버그용. */
  tier: FusionTier;
}
```

### 4.2 명시 trust table

```ts
const FUSION_TIER_PRIORITY: readonly FusionTier[] = [
  'wifi-ssid',                 // #913 미래 — 100% 확정
  'boarding-lock-train-match', // position-train + trainCode == lock.trainCode
  'position-train-locked',     // position-train + lock-line match
  'position-train',            // lock 없음 + GPS sanity 통과
  'fused-position',            // pickFusedStation source='position'
  'fused-arrival-confirmed',   // pickFusedStation arrival score >= 100
  'fused-arrival-arriving',    // pickFusedStation arrival score > 0
  'route-progress',            // 1D map matching
  'estimator-live-position',   // ADR-008 ① (현재는 position-train과 통합)
  'estimator-arrival-eta',     // ADR-008 ②
  'estimator-reanchored-hop',  // ADR-008 ③④
  'gps-only',                  // 최후 fallback
];
```

> *주: 'estimator-*'는 별도 override layer에서 채택. 표는 결정 순서이자 측정 키.

### 4.3 tie-breaker 명시

- **동일 tier**: `(confidence_score, freshness_ts)` lexicographic — 더 높은 score 우선, 동률 시 더 최근 신호.
- **lock 활성 + tier mismatch**: lock.boardingLine과 다른 line의 신호는 1단계 강등.
- **estimator override**: forward-only + observation ceiling 통과 시에만 `boarding-lock-interp`로 표시 (현 구현 유지).
- **강등 사이트**: `shouldDowngradeFusion`(정적), `barometerSubsurface`(지하) — 채택 후 last-step에서 일괄 적용.

### 4.4 검증 인프라

- 각 결정마다 `tier` + `inputsAvailable: Record<FusionTier, boolean>` + `gateRejections: Record<FusionTier, RejectionReason>` 를 fusionDebugBuffer에 적재.
- DebugModal에 tier 결정 트리 표시 (어느 tier가 왜 탈락했는지).
- 1주 운영 후 실측 기반 임계 조정.

---

## 5. A2-new sub-issue 후보 spec

### 제목
`feat(#1008): A2-new — fusion 신호 우선순위 명시 spec + pickFusedStation 리팩토링`

### 배경
SSOT `tasks/epic-lockless-overfire-guard.md` §5 R-10. fusion 결정 사이트가 `useFusedNearestStation` 안에 5단계(positionTrain → fused → route → gps → estimator override → 강등)로 분산되어 새 신호(wifi-ssid #913, sensor fusion #921) 추가 시 결정 트리 부재. 사고(#662 #707 #1015 #1016 #1017)마다 가드를 사이트에 끼워넣는 방식으로 봉합되어 모호도 누적.

### Scope (PR 슬라이스 후보)
1. **PR A — 명시 trust table + decideFusionResult 추출**
   - `src/features/nearest-station/utils/decideFusionResult.ts` 신설
   - `useFusedNearestStation`의 결정 블록을 호출로 대체 (동작 무변경, 측정 키만 추가)
   - 모든 tier 조합에 대한 단위 테스트 (결정 결과 예측 가능)
2. **PR B — gateRejections 측정 + DebugModal 노출**
   - 각 tier 진입 게이트가 어떤 이유로 탈락했는지 fusionDebugBuffer에 적재
   - DebugModal에 결정 트리 섹션 추가
3. **PR C — 1주 실측 후 임계 조정 (별도 이슈)**

### Acceptance
- [ ] 모든 source 조합(positionTrain × fused × route × gps × estimator × lock × barometer)에 대해 결정 결과가 예측 가능 (단위 테스트로 enumerate).
- [ ] `pickFusedStation` 단일 진입점 유지 (호출자가 cascade 결정 책임 가지지 않음 — decideFusionResult로 이동).
- [ ] tier별 입력 가용성 + 게이트 탈락 사유가 fusionDebugBuffer에 기록.
- [ ] 100% coverage 유지.
- [ ] 동작 무변경 — 본 PR은 spec + 추출 + 측정. 임계 조정은 별 PR/이슈.

### 비용
1~2일 (audit 본 문서 + 추출 PR A + 측정 PR B). 임계 조정은 1주 운영 후 별도 이슈.

### 비-목표
- 새 신호(wifi-ssid, sensor fusion cascade) 통합은 본 이슈 범위 밖 — table에 자리만 잡고 실제 결합은 후속.
- ADR-010 (sensor fusion policy) 변경은 본 이슈 범위 밖.

---

## 6. 권장 진행 순서

1. A2-new 작성 후 Epic A의 R-10 monitor로 등록 (`tasks/epic-lockless-overfire-guard.md` §5 update).
2. PR A — `decideFusionResult` 추출 (동작 무변경) + 단위 테스트.
3. PR B — `gateRejections` 측정 + DebugModal 노출 → 1주 운영.
4. 1주 후 실측 기반 임계 조정 (별도 이슈, 본 epic 또는 후속 epic).
5. 새 신호(wifi-ssid #913, sensor fusion cascade #921) 통합 PR은 본 spec의 tier table에 추가하는 형태로 진행 (sub-issue 별도).

> **사전 결정 차단 항목**:
> - B1 (ADR-010 C 폐기 + D 신설) 결정에 따라 sensor fusion의 tier 위치가 바뀔 수 있음 → B1 미결인 동안 PR A는 sensor fusion 자리만 enum에 두고 결합은 보류.
> - B2 (#874 통합) 결정에 따라 #844 잔여 범위(estimator 변형)가 본 spec에 영향 → B2 결정 전 estimator tier 세분화 보류.
