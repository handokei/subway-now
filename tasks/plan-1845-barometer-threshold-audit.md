# Plan #1845 — Barometer 임계 0.3 hPa 적합성 + 이미 지하 사용자 대응 옵션 평가

Issue: https://github.com/handokei/subway-now/issues/1845
Parent: #1821 (environment-unknown-classification plan §3 audit 3)
Status: audit doc

---

## §1 메커니즘 — dP 계산 + 0.3 hPa의 물리적 의미

### 코드 위치
- 임계: `src/shared/constants/barometer.ts:21` — `BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA = 0.3`
- 평가: `src/shared/utils/barometerSubsurface.ts:evaluateSubsurfaceEnter()`
- 윈도우: 30s (`BAROMETER_DPDT_WINDOW_MS = 30_000`)
- 로직: `deltaHpa = latest.pressureHpa − baseline.pressureHpa` (baseline = 30s 이전 가장 최근 reading)

### 물리 계산

| 구분 | 수치 |
|---|---|
| ISA 표준 대기 hPa/m (해수면 근처) | 0.12 hPa/m |
| 0.3 hPa 임계 → 환산 깊이 | **2.5m 하강** (= 0.3 / 0.12) |
| 서울 지하철 평균 플랫폼 깊이 | 15~30m (부산/서울 선로 조사, 2호선 노출구간 제외) |
| 서울 지하철 진입 소요 시간 | 15~40s (에스컬레이터 속도 기준) |

**결론**: 0.3 hPa/30s는 ~2.5m/30s 수준의 하강 이벤트가 있을 때 트리거한다.
- 일반 계단 보행: ~0.5m/s → 30s = 15m → dP ≈ 1.8 hPa → **임계 초과** (감지 가능)
- 에스컬레이터 (~0.5m/s 동일): 유사
- 엘리베이터 (0.5m/s 고속): 같은 범위 → 지상 고층 빌딩 엘리베이터 false positive 우려 있음

### 임계 선정 근거 (constants 주석 검토)

코드 주석에 명시된 근거:
1. 지상 → 10m 하강 = 약 1.2 hPa 상승 (표준 대기)
2. 서울 지하철 진입 깊이 5~25m, 진입 소요 15~40s
3. **0.3 hPa/30s = 약 2.5m/30s → 엘리베이터/계단 일반 보행은 임계 미달이어야 한다** — 그러나 실측상 계단/에스컬레이터는 임계 초과 가능

> **주석 설계 의도 vs 물리 실측 간 불일치**: 일반 계단 보행(1층~지하 1층, 약 4m)은 dP ≈ 0.48 hPa/30s로 임계 초과. 즉, 지하 진입이 아닌 단순 건물 내 계단 이동에서도 false positive가 발생할 수 있다.

### Hysteresis 완화 설계

- `BAROMETER_SUBSURFACE_CONFIRM_SAMPLES = 3` — 임계 초과가 3회 연속 확인돼야 subsurface=true
- 3초 지연은 순간적 spike(문 개폐, 터널 압력파)를 차단하는 목적

---

## §2 한계 — "이미 지하" 사용자 진입 시점 신호 무효

### 시나리오 재현

```
사용자 동작: 지하철역 내부에서 앱 실행 (이미 지하 위치)
  → useBarometer 마운트 → ring buffer 비어있음
  → 30s warm-up 동안 기압 변화 없음 (이미 지하 = 깊이 고정)
  → dP ≈ 0 (정차 상태와 동일)
  → evaluateSubsurfaceEnter → deltaHpa ≈ 0 → detected = false
  → subsurface = false
  → inferEnvironment: subsurface=false + surfaceSSOT=false + undergroundSSOT=? → 'unknown' 또는 'surface'
```

### 코드 레벨 확인

`evaluateSubsurfaceEnter` (barometerSubsurface.ts:79):
```typescript
detected: window.deltaHpa >= BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA - FP_EPSILON
```

이미 지하인 상태에서는 `deltaHpa ≈ 0`이므로 항상 `detected = false`.

### inferEnvironment에서의 영향 (inferEnvironment.ts:29)

```
subsurface=false + surfaceSSOT=false → undergroundSSOT에 의존
  undergroundSSOT=false → 'unknown' 반환
```

**"이미 지하" 사용자 = subsurface 진입 신호 100% 무효** — 구조적 결함.

### 추가 downstream 영향

1. **stickyStationGates.ts:72** — `fix.tripActive && fix.subsurface === true` → false → sticky lock 없이 GPS 오버라이드 허용 증가
2. **useFusedNearestStation.ts:1635** — `subsurfaceStationDetected` 조건에 `subsurface=true` 포함 → 이미 지하 사용자는 해당 경로 진입 불가
3. **useNearestStation.ts:374** — `FG_WATCH_OPTIONS_SUBSURFACE` 선택 안 됨 → GPS throttle 미적용 (배터리 소모 과다 또는 지하 GPS noise 증폭)

### Warm-up 종료 후에는?

30s 이후 readings가 채워지면:
- 플랫폼에 정차 중 → `deltaHpa ≈ 0` → `detected = false` (계속 무효)
- 열차 출발 → 터널 진입 시 Venturi 압력파 → dP 변화 가능하나 30s 윈도우 기준은 적지 않음
- 다음 역 진입 시 → 깊이 변화 유무에 따라 극히 드물게 감지 가능

**결론**: "이미 지하" 사용자는 앱 실행 전체 세션 동안 subsurface=false 고착 가능성이 높음.

---

## §3 시장 비교 — 경쟁 앱/학술의 임계 또는 처리 방식

### Snips (Paris Metro, 2016)

- **Venturi effect barometer** 방식 — 터널 열차 통과 시 일시 압력 spike (수 hPa)
- 방향 검출 90% (left/right)
- 역 정지 감지: stop 패턴 dP ≈ 0 일치 (현재 코드 `BAROMETER_STOP_DP_THRESHOLD_HPA` 방향과 같음)
- 임계 공개 없음 — spike는 0.3 hPa보다 수십 배 큰 이벤트

### SubwayAPPS (학술, Springer 2016)

- barometer로 stop station 추정 정확도 **58%** (단독)
- 학술 합의: 단독으로 역 결정 불가 → barometer는 보조 신호 위상
- 임계 미공개, 상대 변화량 spike 검출 패턴 사용

### Transit App

- accelerometer fingerprint 사용 — barometer 미사용 (blog 명시)
- 지하 진입/지상 전환 감지 = barometer 아닌 accelerometer 주파수 변화

### 카카오/네이버

- barometer 미사용 — 사용자 manual train 선택

### 결론

| 방법 | 시장 사례 | 정확도 | "이미 지하" 대응 |
|---|---|---|---|
| dP/dt 진입 시점 (현재 코드) | Snips (방향만) | 방향 90%, 역 ID X | **무효** |
| 정차 dP ≈ 0 패턴 | SubwayAPPS | 58% (보조) | **가능** (이미 지하에서도 정차 중이면 감지) |
| accelerometer fingerprint | Transit App | 90% | **가능** (지하 진입 불문하고 열차 진동 패턴) |
| WiFi SSID 매핑 | 카카오/네이버 X, subway-now F2 | 지하 커버 역 한정 | **가능** (지하 도착 후 wifi 연결 시) |

---

## §4 옵션 3+ (false binary 차단)

### 옵션 A — 임계 유지 + "이미 지하" 보완 없음 (현상 유지)

**설명**: 0.3 hPa 임계 그대로, "이미 지하" 사용자는 subsurface=false 허용.

**장점**:
- 변경 없음 (0 작업)
- 지하 진입 케이스는 정상 동작

**단점**:
- Day 2 evidence 사용자 시나리오 100% 무효
- 사용자가 이미 지하에서 trip 시작하면 subsurface 신호 영구 dead → 연관 게이트 전부 bypass
- "이미 지하" 사용자 비율 추정: 통근 중 앱 재실행, BG kill 후 재시작 → 비율 낮지 않음

**수용 여부**: **미수용** — ADR-010 "두 실패 모드 동급" 위반. "이미 지하" miss가 방치됨.

---

### 옵션 B — 절대 압력 기반 지하 판정 (narrowStationsByPressure 확장)

**설명**: `narrowStationsByPressure` (barometerState.ts:131)는 측정 절대압과 지상 기준압의 차이로 역 depth를 비교한다. 이 함수를 환경 판정에도 적용: `observedPressure − surfacePressure > threshold_m * 0.12` 이면 "지하"로 판정.

**예시 로직**:
```typescript
// stationAbsolutePressure.json 평균 depth (약 15m) 기준
const MIN_UNDERGROUND_DP_HPA = 15 * 0.12; // = 1.8 hPa 초과 시 '지하 공간'
const subsurfaceAbsolute = (measuredHpa - surfaceHpa) > MIN_UNDERGROUND_DP_HPA;
```

**장점**:
- "이미 지하" 사용자도 절대압 차이로 즉시 판정 가능
- 진입 시점 불필요 — 앱 실행 즉시 subsurface 판단

**단점**:
- `surfacePressureHpa` 기준값 확보 필요 (날씨 변동 ±5 hPa — 현재 외부 주입 없음)
- GPS 지상 기준점 없으면 기상 변동이 오판 유발 가능
- 구현 없음 → 신규 작업 1~2주
- `stationAbsolutePressure.json` 역 데이터 완성도 의존

**적용 범위**: "이미 지하" 판정 보완 전용. dP/dt 진입 감지와 병렬 운영.

---

### 옵션 C — barometer-stop 역검출 (현재 가능)

**설명**: "이미 지하 + 정차 중" → `evaluateBarometerStop` → `detected=true` (`|dP| < 0.05 hPa/30s`). 이 신호는 이미 지하 사용자에게도 유효하다. 현재 fusion에서 `barometer-stop`을 역 도착 신호로 사용 중. **단, `subsurface=false` 상태에서도 `barometer-stop=true`이면 "지하에 있을 가능성"으로 해석하는 게이트를 추가**한다.

**구체적 변경**:
- `inferEnvironment.ts`에 `barometerStopDetected=true + subsurface=false` 조합 처리 추가
- `subsurface === false` 브랜치에서 surfaceSSOT/undergroundSSOT 이전에 바로미터 정차 신호 체크
- dP ≈ 0 + tripActive=true → 'underground' 강제 판정 없이 'unknown'(방어) 또는 hint로 사용

**장점**:
- **추가 구현 최소** — `evaluateBarometerStop` 이미 작동
- "이미 지하" 사용자가 열차 탑승 후 정차 시 보완 신호 즉시 발생
- 기상 변동 영향 없음 (상대 변화량)

**단점**:
- `barometer-stop=true`는 지상 보행 정지(버스 대기, 건물 내 정지)에서도 발생 → tripActive 조건 없이 단독 사용 불가
- "이미 지하 + 열차 이동 중" 구간은 감지 못함 (dP 변화 있을 수 있음)

**작업량**: 소 (~2~4시간, `inferEnvironment.ts` + 테스트)

---

### 옵션 D — WiFi SSID + barometer 조합 (현재 부분 가능)

**설명**: `undergroundSSOT=true` (WiFi SSID 지하 매핑 매칭)이 있으면 subsurface 신호 없어도 이미 지하 판정. 현재 `inferEnvironment.ts:30-33`에서 `subsurface===false + undergroundSSOT=true → 'underground'` 이미 구현됨.

**장점**:
- **이미 구현** — 변경 불필요
- WiFi 매핑 커버 역에서는 "이미 지하" 완전 해결

**단점**:
- WiFi SSID 매핑 커버리지 한계 (445/445 SSID 매핑 완성이나 WiFi 미연결 사용자는 무효)
- iOS BG에서 WiFi SSID 읽기 불가 (`reference_ios_bg_lockless_infrastructure_research` C1)
- FG 전용 — BG trip에서는 무효

---

### 옵션 E — accelerometer fingerprint (별 epic, 참고)

**설명**: Transit App 방식 — 열차 진동 패턴(5Hz) vs 보행(2Hz) 분리. 이미 지하 불문하고 열차 탑승 여부 판정.

**장점**:
- "이미 지하" 구조적 해결 (진입 시점 불필요)
- Transit App 90% 정확도

**단점**:
- **별 epic 필요** (#1763 / Phase 6.2+)
- 단일 사용자 model 학습 필요 (1~2주 trip 수집)
- Out of scope (본 audit 명시적 제외)

---

## §5 트레이드오프 표

| 옵션 | "이미 지하" 해결 | 작업량 | false positive 위험 | 즉시 도입 |
|---|---|---|---|---|
| A — 현상 유지 | ❌ 무효 | 0 | 낮음 | ✅ |
| B — 절대압 판정 | ✅ 완전 | 대 (1~2주) | 중 (기상 변동 의존) | ❌ |
| C — barometer-stop 힌트 | 부분 (정차 시 보완) | 소 (2~4h) | 낮음 (tripActive 게이트 가능) | ✅ |
| D — WiFi SSID | ✅ FG 커버 역 한정 | 0 (이미 구현) | 낮음 | ✅ (FG만) |
| E — accelerometer | ✅ 완전 | 대 (별 epic) | 낮음 (Transit 90%) | ❌ |

### 옵션 조합

**권장 즉시 조합**: D (이미 구현, FG) + C (정차 보완, 소작업) = "이미 지하" 케이스를 최소 비용으로 부분 커버.
- D: WiFi SSID 매핑 역에서 FG trip은 완전 해결.
- C: WiFi 없는 환경 + BG에서 tripActive+barometer-stop 힌트로 partial 보완.

**중기**: B (절대압 판정) — surfacePressure 외부 주입 인프라 (GPS 지점 기상 API 또는 앱 지상 마지막 기압 캐시) 완성 후.

---

## §6 결론 1택 + 이유

### 결론: 옵션 C (barometer-stop 힌트) 즉시 도입 + 옵션 B (절대압 판정) 중기 Epic 등록

**이유 (우선순위 순)**:

1. **0.3 hPa 임계는 물리적으로 합리적** — "이미 지하" 문제는 임계 자체의 문제가 아니라 신호 종류 문제. 진입 dP/dt는 "지하 진입 이벤트"를 감지하도록 설계된 신호이므로 "이미 지하"에서 무효인 것은 예상된 동작. 임계를 낮추거나 높여도 이 구조적 한계는 해결 안 됨.

2. **barometer-stop은 이미 지하 + 정차 시 유효** — 현재 `evaluateBarometerStop`이 작동 중이며, `tripActive=true + stop=true`는 "지하에서 열차 정차" 상황에 대응. `inferEnvironment`에 이 힌트를 반영하면 추가 구현 없이 보완 가능.

3. **WiFi SSID는 FG에서 이미 해결** — FG 사용자 중 WiFi 연결된 경우 `undergroundSSOT=true` 경로로 'underground' 판정됨. 추가 작업 불필요.

4. **임계 변경 (0.3 → 다른 값) 근거 없음** — 임계를 낮추면 계단 보행 false positive 증가. 높이면 깊이가 낮은 역(5m 이하) 감지 불가. 현재 0.3 hPa는 tradeoff 균형점.

5. **accelerometer fingerprint (옵션 E)는 구조적 해결책이나 Out of scope** — #1763 / Phase 6.2+ epic으로 등록.

### 즉시 액션 (C 옵션)

- `inferEnvironment.ts`에 `barometerStopDetected=true + tripActive=true + subsurface=false` 조합 힌트 추가 (`'unknown'` 유지하되 tag로 "likely underground" 가능)
- 단독 판정 사용 금지 (ADR-010 동급 원칙 — false positive 방지)
- 별 이슈 등록 후 구현 (#1845 후속)

### 중기 액션 (B 옵션 Epic 등록)

- surfacePressure 주입 인프라 (앱 지상 마지막 압력 캐시 60분 TTL + 기상 API fallback)
- `narrowStationsByPressure` 활용 절대압 환경 판정 함수 추가
- 별 issue (#1845 follow-up)

---

## §7 이슈/후속 액션 요약

| 항목 | 이슈 | 우선순위 |
|---|---|---|
| barometer-stop 힌트 inferEnvironment 반영 | 별 이슈 (#1845 후속) | Medium |
| surfacePressure 외부 주입 + 절대압 판정 | 중기 epic | Low |
| accelerometer fingerprint (열차 진동) | #1763 / Phase 6.2+ | Low (별 epic) |
| 0.3 hPa 임계 유지 결정 | 본 문서로 결정 완료 | — |

---

## §8 DebugModal 관측 포인트 (V/X dashboard)

현재 barometer 신호 관측 가능 위치:

| 신호 | 관측 위치 | 필드 |
|---|---|---|
| subsurface | DebugModal GPS section | `subsurface=true/false` |
| stop | DebugModal GPS section | `stop=true/false/undefined` |
| unavailableReason | DebugModal GPS section | `unavailableReason=sensor/permission/readings` |
| readingCount | DebugModal GPS section | `readingCount=N` |
| deltaHpa (raw) | `evaluateLatestSubsurface()` 직접 호출 필요 | `deltaHpa` |

"이미 지하" trip 검증 시 확인 체크리스트:
1. `readingCount` ≥ 30 (30s 이상 수집 확인)
2. `subsurface=false` (진입 미감지 확인)
3. `stop=true` (정차 중 확인)
4. `unavailableReason=undefined` (readings 충분 확인)

---

## §9 측정 plan (1주)

Day 3+ trip에서 수집:

1. **지하 진입 시나리오**: 지상 → 지하역 진입 후 30s 대기 → `subsurface` 전환 시점 확인. deltaHpa raw 값 수집.
2. **이미 지하 시나리오**: 지하역 내부에서 앱 cold start → 60s 후 `subsurface` 값 확인. `stop` 값 확인.
3. **DebugModal dump** 2건 이상: 진입 케이스 vs 이미 지하 케이스 비교.

목표 메트릭:
- 지하 진입 케이스에서 `subsurface=true` 전환율
- 이미 지하 케이스에서 `stop=true` 발생율 (대안 신호 유효성 검증)
- deltaHpa 분포 (0.1~0.5 hPa 구간 비율)
