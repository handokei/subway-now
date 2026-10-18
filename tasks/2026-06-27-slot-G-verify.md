# Slot G — Verify: candidate generation 환경 분기 & 4-signal fusion 정신

## ADR-015 4-signal fusion + 환경 분기 정의 (있는가/없는가)

**4-signal 정의 (§3 신호 분류 + undergroundSSotConsensus 구현)**:
- Station pair (station 제공) : (a) WiFi+Arrival, (b) Position-Train+Arrival
- Environment vote (환경만)   : (c) Barometer stop, (d) Cellular env vote, (e) Accelerometer automotive

ADR-015 §3은 "fire 게이트"를 분기별 N-of-M으로 정의 — `surface=A+B`, `underground=C+B or D+B`(GPS reject), `mixed=strong 2개`. **§3 의도된 분기점은 환경 SSOT(`§1 stations.json environment 필드`) 기반 deterministic**이지만 §1은 미구현. 현재 environment는 `inferEnvironment.ts`가 `subsurface(barometer) + surfaceSSOT/undergroundSSOT` 활성도로 추론 — barometer warmup 불안정성에 영향받는다.

**candidate generation 단계는 ADR-015 본문에 명시되지 않음**. §5(allowedLines)만 후보 단계 게이트로 정의. 환경 분기는 `fire 게이트(§3)`와 `cascade picker tier 승급(#1646/#1657)` 단계에서만 등장.

## cellularTech + subsurface 분기가 이미 적용된 layer 목록

| Layer | cellularTech | subsurface | 코드 위치 |
|---|---|---|---|
| candidate enumerate (`findTopNearestStations`) | X | X | `findNearestStation.ts:55` — line filter만 |
| candidate train enumerate (`pickCandidateTrains`) | X | X | `pickCandidateTrains.ts:70` — anchor window + 거리(R12-a)만 |
| `useNearestStation` GPS gate | X | 사용 (drop 임계 강화) | `useFusedNearestStation.ts:448` |
| `undergroundSSOTConsensus` | 사용 (`surface`=null, `surface-weak`=envVotes−1) | 간접(barometerStop) | `undergroundSSotConsensus.ts:145,166-167` |
| `weightedVoteFusion` fallback | 사용 (threshold 1.1→1.6) | 간접 | `weightedVoteFusion.ts:252` |
| cascade tier #1646 (positionTrain 승급) | X | `=== true` 필수 | `useFusedNearestStation.ts:1017` |
| cascade tier #1657 (gpsDerivedFastPath) | X | `=== false` 필수 | `useFusedNearestStation.ts:1051` |
| `inferEnvironment` 라벨 | X | 1순위 결정자 | `inferEnvironment.ts:45-58` |

**subsurface 결정 경로**: `useBarometer` → `barometer.subsurface` prop → `useFusedNearestStation.ts:443` `barometerSubsurface`. 47 readings = 60s window 정착치. `subsurface=false`는 dP/dt 정착 + surface 신호 (#1860 barometer-stop hint와 결합).

## useFusedNearestStation fusion priority + 환경 분기 위치

`useFusedNearestStation.ts:1203-1287` cascade picker. 우선순위 (지상/지하 분기 in-line):

1. `positionTrainBoardingLockMatch` (lock + 지하 + lockMatch) — `subsurface===true` 강제 (L1017)
2. `gpsDerivedFastPath` (lock + 지상 + GPS 신선) — `subsurface===false` 강제 (L1051)
3. `arvlCdArrivedMatch` (ARRIVED+trainCode) — 환경 무관
4. `backendSsotAccepts` — 환경 무관
5. `wifiStationResolved` — 환경 무관
6. `positionTrainResult` — 환경 무관 (단, GPS+arc forward-only)
7. `fused (pickFusedStation)` — 환경 무관
8. `detectionVerdictAccepts` — 환경 무관
9. `routeResult` (route-progress) — 환경 무관
10. `gpsFallbackResult` — stale gate만

**Position-train GPS sanity (영역 F overlap)**: L765-777 `passesFusionDistanceGate`. lockActive 무관 max 0.6km/0.5km 절대 + delta. 단 lock 활성 시 `lockActive=true`로 accuracy>200m bypass 거부. **GPS와 무관한 환경(지하 dead zone)에서 lock의 distance 자체 sanity check 없음** — L786-800 `isWithinArcWindow` + forward-only가 막지만 lock의 boardingStationId 자체가 거리상 사용자와 멀어도 통과.

**pickFusionSource 같은 단일 함수 없음** — cascade가 if/else 11분기 in-line. ADR-014 옵션 결정 시 단일 함수 추출하지 않은 이유는 "tier별 게이트가 강하게 결합되어 추출 어려움".

## 영역 G 재정의 결론 (단순 route 제한 vs 다층 paradigm)

**사용자 의문은 정확하다.** "GPS 기반 candidate generation + R12-a 거리 게이트만" 방향은 paradigm 차원에서 결함이 있다:

1. **candidate generation 단계에 환경 분기 0**. `findTopNearestStations`는 GPS 좌표만 의존. 지하 GPS drift 시 잘못된 영역의 candidates → 잘못된 호선 enumerate → cellularTech가 fire 단계에서 reject해도 cascade tier 6/7/9는 통과 가능.

2. **§5 allowedLines가 노선 화이트리스트는 했지만 거리 sanity가 GPS 기반** — `findTopNearestStations(...maxDistanceKm)`는 GPS 좌표 기준 haversine. GPS drift 시 잘못된 위치의 trip route 노선 역이 후보로 들어간다.

3. **§3 환경별 N-of-M 게이트 미구현** — 현재 fire 게이트는 cascade의 if/else 우선순위로만 표현. ADR-015 §3 "지하: C+B or D+B 2-of-2" 명시 게이트는 cascade tier 5/6에 간접 reflect. cellularTech는 `surface=hard-reject` + `surface-weak=−1`만 적용, GPS reject(§3) 미적용.

4. **사용자 의문의 핵심 — "지상/지하 분기도 안 된 상태에서 GPS가 candidate generation, R12-a만 reject"는 ADR-015 §3 위반.** 단순 "route arc 제한"으로 fix 가능 X, 다층 paradigm 필요:
   - L1: candidate generation 단계 환경 분기(stations.json `environment` 필드, §1 미구현)
   - L2: GPS sanity가 환경 분기에 따라 달라짐(지하=GPS reject, 지상=GPS strong A)
   - L3: pickCandidateTrains에 환경 vote 입력(지하 시 R12-a threshold 보수화)
   - L4: cascade tier도 환경 분기에 따라 reorder

**영역 F("position-train GPS sanity")와 영역 G("환경 분기")의 paradigm 관계**: 같은 paradigm("GPS는 환경에 따라 신호 등급이 다름")의 두 측면. F는 fire 단계(`passesFusionDistanceGate` lock 활성 시 bypass), G는 후보 enumerate 단계. 같이 fix해야 paradigm 정합 — ADR-015 §3 "GPS는 underground 입력 set에서 reject"가 두 layer 모두 적용돼야 의미가 있다.

## 영역 G 확률 업데이트

**65% → 80%**.

상향 근거:
- candidate generation 단계 환경 분기 0 확정 (ADR-015 §3 명시적 위반)
- cellularTech가 fire 단계에만 적용, 후보 단계 미적용 (§3 정신 partial implementation)
- §1 stations.json environment 필드 미구현 (deterministic SSOT 없이 barometer warmup 의존)
- R12-a 거리 3.0km는 GPS drift 5km+에서 무력화 가능 (2026-06-19 evidence 이수↔학동)

하향 보존(15%): `allowedLinesFromRoute`(§5)가 noise 80% 차단. `pickCandidateTrains` anchor window 3 station + R12-a 3.0km로 잘못된 영역 후보 대부분 차단. cascade tier 1-3은 lock+lockMatch+ARRIVED를 요구해 강한 신호 합의 우선. trip 회귀 0건 가설은 cascade tier가 cellularTech surface-weak를 fire 게이트로 reflect하므로 GPS-only fallback이 최후 tier에만 도달.

**Fix 방향**: 단순 route arc 제한 NO. ADR-015 §1(environment 필드) + §3(GPS reject in underground 입력 set)을 candidate enumerate 단계까지 propagate. epic 단위.
