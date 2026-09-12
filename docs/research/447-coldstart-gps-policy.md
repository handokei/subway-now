---
issue: 447
title: "chore: 콜드스타트/저정확도 GPS 신뢰 정책 재검토"
created: 2026-06-11
---

# #447 — 콜드스타트 / 저정확도 GPS 신뢰 정책 audit

> **목적**: 앱 콜드스타트 직후 GPS 정확도가 매우 낮은(>500m, 종종 >1500m) 상태에서 코드가 그 좌표를 사용해 station 매칭을 시도하면 misfire가 발생한다는 의심. 현 정책 audit + risk 분석 + 권장 변경.
>
> **본 문서는 코드 변경이 아닌 정책 audit이다.** 실제 변경은 sub-issue로 분리한다.

---

## 1. 현재 정책 audit

### 1.1 위치 상수 SSOT — `src/shared/constants/location.ts`

| 상수 | 값 | 용도 |
| --- | --- | --- |
| `MAX_LOCATION_AGE_MS` | `15_000` ms (15s) | freshness 게이트. `getLastKnownPositionAsync` 결과의 age. BG `timeInterval`(30s)보다 짧음 — stationary OS 캐시 좌표 drop 의도 |
| `MAX_ACCURACY_M` | `200` m | **알람 경로 엄격 게이트**. `isAccuracyAcceptable()`. 역간 평균 800m+ 대비 안전 마진. fusion distance gate, 알람 phase ETA, station-passed 모두 이 임계 사용 |
| `MAX_ACCURACY_M_DISPLAY` | `250` m | **표시 경로 게이트**. `isAccuracyAcceptableForDisplay()`. `useNearestStation`이 result 갱신/캐시 hydrate 시 사용. drop된 동안 `locationUncertain=true`로 노출 |
| `MAX_STATION_DISTANCE_KM` | `1.0` km | `findNearestStations` 반경 |
| `MAX_PLAUSIBLE_SPEED_MPS` | `50` m/s | jump gate(#527). 21:29 효창공원앞↔신내 25km/8s 텔레포트 차단 |
| `MIN_JUMP_DISTANCE_M` | `100` m | jump gate 면제 임계 (GPS 노이즈 흡수) |

> 주의: `useNearestStation.ts:41` 주석은 “MAX_ACCURACY_M_DISPLAY=1500m”라고 적혀 있는데, 실제 상수는 **250m**. 주석이 stale (과거 1500m 시절의 잔재로 추정). 후속 cleanup 필요.

`useNearestStation.ts:279~284`의 inline 주석에는 “지하 구간 horizontalAccuracy(300~1500m)도 표시용으로는 수용”이라고 적혀 있으나 실제로는 250m에서 drop된다. 정책 일관성을 위해 어느 한쪽으로 맞춰야 한다. 본 audit 시점 권고: **주석을 코드(250m)에 맞춘다** — 250m가 보수 정책으로 옳다.

### 1.2 `useNearestStation` — cold start hydrate 흐름 (`src/features/nearest-station/hooks/useNearestStation.ts`)

`startWatch` 진입 시 cold-start hydrate 분기는 다음 4단계:

1. `Location.getLastKnownPositionAsync()` 호출 (#808에서 도입).
2. `isLocationFresh(timestamp)` — `MAX_LOCATION_AGE_MS=15s` 이내인지.
3. fresh + `isAccuracyAcceptable` (≤200m) → `applyLocation` 정상 경로, `uncertain=false`.
4. fresh + `isAccuracyAcceptableForDisplay` (≤250m) → `applyLocation` + `uncertain=true` (cold start 빈 화면 회피).
5. 위 둘 모두 실패 → 진단 카운터(`lastKnownStaleCountRef` / `lastKnownLowAccuracyCountRef`) 증가 후 무시.

이후 `Location.watchPositionAsync({ accuracy: High, timeInterval: 2000 })`로 연속 스트리밍. 매 fix:

- `isAccuracyAcceptableForDisplay` 실패 → `uncertain=true` + `gps-drop` 진단 push, **result 갱신 안 함**.
- 통과 → `applyLocation`에서 `isPlausibleJump` 추가 검사. 통과해야 `lastFixAtMs` / `userLocation` 갱신.

> **현재 정책 요점**: 콜드스타트 캐시 좌표는 `MAX_LOCATION_AGE_MS` + `MAX_ACCURACY_M_DISPLAY` 두 게이트로 거부하고, 통과해도 200~250m 사이 fix는 `locationUncertain=true`로 호출자에 신뢰도를 알린다.

### 1.3 `movementGate.ts` — accuracy 게이트 (`src/features/nearest-station/utils/movementGate.ts`)

알람 발사 4개 채널(ETA, API imminent, silent push, 사전 예약) 공통 SSOT. 평가 순서:

1. `no-location`
2. `stale-timestamp` (`STALE_AGE_MS = 30_000` — `MAX_LOCATION_AGE_MS`와 다른 값임에 주의)
3. **`low-accuracy`** (`MAX_ACCURACY_M = 100` — `location.ts`의 200m과 다른 값!)
4. `motion-stationary`
5. `static-speed`
6. `static-position`
7. **`motion-warmup`** (#1013 — fg-hydrate 직후 신호 부재 구간)

> **불일치 발견**: `movementGate.ts`의 `MAX_ACCURACY_M=100`은 `location.ts`의 `MAX_ACCURACY_M=200`과 **다른 값을 같은 이름으로 재선언**. 의도는 명확(fusion downgrade는 100m 이하만 신뢰)하나, naming collision은 위험.
>
> 권고: `MOVEMENT_GATE_MAX_ACCURACY_M=100` 같이 이름을 분리.

#### `motion-warmup` (#1013)

`motionStationary === undefined`(CMMotionActivity 초기화 중) + `speedMps == null`(iOS speed=-1) + `positionStability === 'unknown'`(60s 수집 미완) **세 신호 모두 부재**할 때만 차단. fg-hydrate 직후 ~30s window 동안만 영향. 자연 해소 보장.

### 1.4 `useFusedNearestStation` — fusion 경로 accuracy 활용 (`src/features/nearest-station/hooks/useFusedNearestStation.ts`)

- L387, L435: `passesFusionDistanceGate({ accuracyMeters, lockActive })` 호출.
- `fusionDistanceGate.ts:53` — `lockActive=false` + `accuracy > 200m` → 게이트 **bypass(통과)**. 즉 지하 dead zone(±1.5km)에서 fusion 거리 검사 자체를 skip해 fusion 신호가 elevated된 상태를 유지하게 한다.
- `lockActive=true`(BoardingLock 존재) → bypass 거부 → 엄격 검사.
- L619 `shouldDowngradeFusion` — 사용자 정적(`isStaticSpeedSignal`) + accuracy 정상이면 fusion → gps-only로 강등.

### 1.5 `useStationAlarm` — 알람 경로 accuracy 가드 (`src/features/alarm/hooks/useStationAlarm.ts`)

- L456 (Phase ETA effect): `if (!isAccuracyAcceptable(accuracyMeters)) { logSuppressedPhaseGate('gate-phase-accuracy', ...); return; }` — early return.
- L462 (#670/#672): `gate-phase-warmup` — 첫 trigger suppress. fg-hydrate 직후 stale state 발사 차단.
- L521 (`evaluateMovement` 호출): Phase 발사 직전 movement gate (motion/speed/position/warmup 통합).
- L662 (station-passed effect): `accuracyOk = isAccuracyAcceptable(accuracyMeters)`. `!accuracyOk && !arrivalConfirmed` → return.
- L691~697 (#1010): `STATION_PASSED_HYDRATE_WARMUP_MS = 30_000`. lock hydrate 완료 시각으로부터 30s 동안 station-passed 발사 보류 → `gate-station-passed-warmup` 로그.

> Phase 알람과 station-passed 알람 양쪽에 각각 warmup 가드가 있다. Phase는 “첫 trigger suppress” (1회), station-passed는 “30s window”.

---

## 2. 콜드스타트 시나리오

### 2.1 expo-location 동작 (iOS)

- `Location.Accuracy.High` + `distanceInterval:0` + `timeInterval:2000` — GPS hardware fix 없으면 WiFi BSSID / Cell tower triangulation으로 fallback (`BestForNavigation`은 fallback 없이 stale, #808 이슈 본문 확인).
- 첫 fix latency: 옥외 cold start 5~15s, 실내/지하 30~60s+ 또는 영영 fix 없음.
- `getLastKnownPositionAsync()` — OS 캐시. 마지막 종료 시점의 fix. 앱 종료 후 몇 시간 지났을 수 있어 age 검사가 필수.

### 2.2 iOS coarse vs fine permission

- 코드 베이스는 `requestForegroundPermissionsAsync` 호출만 — coarse(approximate) 권한 분기 처리는 **없음**.
- 사용자가 “정확한 위치 끄기”를 선택했다면 accuracy 수십~수백m로 들어오며 현 게이트(`MAX_ACCURACY_M=200/250`)에서 자주 drop된다.
- **gap**: coarse 권한 사용자에게는 “정확한 위치를 켜주세요” 안내가 필요한데 현재 UI에 노출 없음.

### 2.3 콜드스타트 직후 1-2분 accuracy/speed 추이 (이슈 #808 문서 + #621 회귀)

- 0~5s: `getLastKnownPositionAsync` 또는 fallback(WiFi/Cell) → accuracy 100~500m
- 5~30s: GPS hardware lock 진행 → accuracy 30~100m로 수렴
- speed: 정지 상태 cold start 시 `speed=-1` (iOS 미측정). #808에서 `positionStability`/`motionStationary` fallback 도입.
- BG 진입/복귀: AppState 'background' 시 `stopWatch`, 'active' 복귀 시 `setLocationUncertain(true)` + `refresh()` (`useNearestStation.ts:362~382`).

---

## 3. 현재 정책의 risk 분석

### 3.1 잘못된 station 매칭 위험

- `MAX_ACCURACY_M_DISPLAY=250m`은 역간 평균 거리 800m+ 대비 **약 1/3**. 250m 정확도면 이론상 인접역과 구분 가능하나 **반경 250m 원 안에 두 역이 들어가는 환승역(예: 동대문역사문화공원, 종로3가)** 에서는 위험.
- cold-start lastKnown hydrate(L256~263)는 `uncertain=true` 플래그로 알람 경로(`isAccuracyAcceptable`, 200m)는 차단된다. **표시값만 영향**.
- 알람 경로는 200m + warmup 가드 + movement gate (motion/speed/position)로 **다층 보호**. 단일 게이트로 뚫을 수 없는 구조.

### 3.2 BoardingLock 활성 시 hydrate 직후 첫 fix 신뢰 정책 (#1010)

- #1010이 station-passed에 도입한 30s warmup이 정확히 본 audit의 핵심. lock hydrate 직후 GPS가 stabilize되기 전 stale 좌표로 “다음 역 통과” 알람이 잘못 발사되던 회귀.
- Phase 알람은 “첫 trigger suppress”(1회) 가드만 있고, **30s window 가드가 없다**. 같은 회귀 패턴이 Phase 알람에서도 발생 가능.
- silent push / 사전 예약 / API imminent 채널에는 hydrate warmup 가드가 아예 없다. movement gate(`motion-warmup`)가 부분 보호하나, motion 권한 거절 사용자에게는 보호 공백.

### 3.3 station-passed misfire 사례 (#1010 본문 + #1008 RC2/RC4)

- Epic #1008 4 root cause 중 RC2(`hydrateLockFromCandidate` 무검증) + RC4(`trackTrainProgress` forward-only 가드 없음)가 본 audit과 직결.
- #1010 머지 후 alarmLog reason 'gate-station-passed-warmup' 발생률을 모니터링하고 있으나, 콜드스타트 + GPS 저정확도 케이스 통계는 아직 수집 안 됨.

---

## 4. 데이터 기반 분석

### 4.1 진단 카운터 (이미 코드에 있음)

`useNearestStation.ts:139~140`:

```ts
const lastKnownStaleCountRef = useRef<number>(0);
const lastKnownLowAccuracyCountRef = useRef<number>(0);
```

콜드스타트 hydrate 시 freshness/accuracy 게이트에서 거부된 횟수가 누적된다. 그러나 **UI/로그 외부에 노출되지 않음** — 운영 telemetry로 수집되지 않는다.

- `logger.info('lastKnown rejected: stale', { ageMs, cumulativeStale })` — console.log 수준만.
- alarmLog buffer에 적재되지 않으므로 DebugModal 또는 외부 export 경로 없음.

### 4.2 alarmLog 관련 reason 코드 (이미 정의됨, `src/features/alarm/utils/alarmLog.ts:79~100`)

- `movement-motion-warmup` (#1013) — fg-hydrate 직후 신호 부재 차단
- `gate-phase-accuracy` — Phase ETA effect의 accuracy 게이트 차단
- `gate-phase-warmup` — Phase ETA 첫 trigger suppress
- `gate-station-passed-warmup` — station-passed 30s window 차단

운영 1주+ 실측 시 본 4 reason의 발생 분포로 콜드스타트 misfire 위험을 정량화 가능.

### 4.3 git log 사고 사례 trace

- **#808** (`fix/#808-cold-start-gps-and-speed-fallback`, 머지 b144797): cold start stale current station 회귀. lastKnown hydrate + speed=-1 fallback 도입. 본 audit의 기준선.
- **#1010** (Epic #1008 sub): station-passed hydration warmup. 본 audit의 직접 prerequisite.
- **#1013** (motion-warmup): fg-hydrate 직후 신호 부재 차단. 본 audit과 짝 패턴.
- **#1016** (lock-active hole): accuracy>200m bypass / line-only check 보강. BoardingLock 사용자 보호.

---

## 5. 권장 정책 변경 (sub-issue 후보)

### P1 — 즉시 (1주 내)

1. **stale 주석 정정**: `useNearestStation.ts:41`, `:279~284`의 “1500m” 주석을 250m(실제 상수값)로 일치. 30분 작업.
2. **`movementGate.MAX_ACCURACY_M` 이름 분리**: `location.ts`와 같은 이름·다른 값. `MOVEMENT_GATE_MAX_ACCURACY_M`(또는 `FUSION_DOWNGRADE_MAX_ACCURACY_M`)로 rename. 1~2h 작업.
3. **lastKnown 진단 카운터 외부 노출**: 현재 ref에 누적만 되고 DebugModal/alarmLog 어디에도 보이지 않음. `fusionDebugBuffer`에 `lastKnown-rejected` event push 추가 → DebugModal에서 콜드스타트 분포 확인. 0.5d.

### P1 — 측정 후 결정 (#447 본 이슈 acceptance와 직결)

4. **운영 로그 ≥1주 수집 후 `MAX_ACCURACY_M_DISPLAY` 임계 재평가** — 본 #447의 원래 요구. P1.1~P1.3 머지 후 측정 가능.
   - 가설 A: 250m가 관대 — 150m 또는 200m로 강화하고 표시 fix drop을 더 자주.
   - 가설 B: 250m가 적절 — 운영 분포로 검증.
5. **Phase 알람에 station-passed와 동일한 30s warmup window 확장** (#1010의 station-passed 가드를 Phase에도 적용). 현재는 “첫 trigger suppress”만 — 두 번째/세 번째 fix까지 stale 가능.

### P2 — 신규 정책

6. **accuracy 임계 동적 조정**: 콜드스타트(첫 fix 후 60s) vs 정상 운영. 콜드스타트 동안만 더 엄격(예: 100m)하게. 운영 안정화 후 검토.
7. **coarse permission 분기 UX**: 사용자가 “정확한 위치 끄기”를 선택했을 때 안내 배너 노출. P2 — UX 변경 작업.
8. **lastKnown rejected → metrics export**: 단순 console.log → Cloudflare Workers 또는 SonarCloud 외부 sink. R-8 quota 검토 필요.

### 트레이드오프

| 변경 | 비용 | 가치 | 우선순위 |
| --- | --- | --- | --- |
| 주석 정정 | 30m | 정책 가독성 | P1 |
| `MAX_ACCURACY_M` 네이밍 분리 | 2h | 회귀 예방 | P1 |
| lastKnown 진단 노출 | 0.5d | 측정 인프라 | P1 |
| Phase warmup 30s window | 1d (테스트 포함) | misfire 차단 다층화 | P1 (#1010과 같은 epic으로) |
| 임계 동적 조정 | 2~3d | 콜드스타트 misfire 추가 차단 | P2 |
| coarse permission UX | 1d | 사용자 가시성 | P2 |
| 외부 metrics export | 3~5d | 장기 운영 모니터링 | P2 |

---

## 6. 후속 sub-issue 후보

| # | 제목 | 우선순위 | 비고 |
| --- | --- | --- | --- |
| (a) | chore: `MAX_ACCURACY_M_DISPLAY` 관련 stale 주석 정정 (250m 실제값과 일치) | P1 | 단발 cleanup |
| (b) | refactor: `movementGate.MAX_ACCURACY_M` 이름 분리(`MOVEMENT_GATE_MAX_ACCURACY_M`) | P1 | naming collision 해소 |
| (c) | feat: lastKnown rejected 진단을 `fusionDebugBuffer`에 push (DebugModal 노출) | P1 | 측정 인프라 — 본 #447 acceptance의 prerequisite |
| (d) | feat: Phase 알람에 `gate-phase-warmup-window` 30s 가드 확장 (#1010 패턴) | P1 | Epic #1008 sub로 부착 가능 |
| (e) | research: 1주 운영 로그로 accuracy 분포 분석 + `MAX_ACCURACY_M_DISPLAY` 재평가 | P1 | #447 본 acceptance |
| (f) | feat: cold start window(60s) 내 accuracy 임계 동적 강화(예: 100m) | P2 | (e) 결과 기반 |
| (g) | feat: coarse(approximate) permission 사용자에게 안내 배너 | P2 | UX 변경 |
| (h) | chore: lastKnown rejected metrics 외부 sink 검토 | P2 | R-8 quota 영향 |

> **선행 의존**: (a)/(b)는 (c)~(h)와 독립. (c) → (e) → (f) 직렬. (d)는 Epic #1008에 흡수 권장.

---

## 참고

- 코드: `src/features/nearest-station/hooks/useNearestStation.ts`, `src/features/nearest-station/utils/{locationGates,movementGate,fusionDistanceGate}.ts`, `src/features/alarm/hooks/useStationAlarm.ts`, `src/shared/constants/location.ts`
- 이슈: #808 (cold start fix), #1008 (Epic Lockless Over-Fire Guard), #1010 (station-passed warmup), #1013 (motion-warmup), #1016 (lock-active hole)
- 정책 메모: `feedback_realtime_priority.md` (실시간성 우선, 나쁜 좌표 거부), `feedback_whileinuse_must_work.md` (WhileInUse 1차 시나리오)
