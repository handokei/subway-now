# Epic #1862 — 절대압 SSOT (옵션 B): barometer "이미 지하" 보완

Issue: https://github.com/handokei/subway-now/issues/1862
Parent audit: tasks/plan-1845-barometer-threshold-audit.md §6
Status: epic planning doc (코드 변경 없음)
Created: 2026-06-26

---

## §1 사용자 가치

### 직접 가치

1. **"이미 지하" cold start 완전 해결**: 앱을 지하역 안에서 켰을 때 `subsurface=false` 고착 제거 → subsurface gate 의존 downstream(stickyStationGates / subsurfaceStationDetected / FG_WATCH_OPTIONS_SUBSURFACE) 모두 정상 작동
2. **cold start + Phase 6.1 보완**: Phase 6.1(#1836)이 감지한 cold start 위치 미스매치를 subsurface 정보가 보완 — 절대압 판정이 추가 신호 제공
3. **옵션 C와 조합 시 커버리지 향상**: 정차 전(이동 중) + 정차 중 양쪽 모두 커버

### 옵션 C 단독 한계 (본 epic 필요 이유)

옵션 C는 `barometer-stop=true`(정차 중 `|dP| < 0.05 hPa/30s`) 조건에서만 작동하므로:
- "이미 지하 + 열차 이동 중" 구간: dP 변화 있을 수 있어 `stop=false` → 감지 불가
- "이미 지하 + 혼잡 시 에스컬레이터" 구간: 진입 없이 이미 지하여서 dP ≈ 0이어도 `stop=true` 발생 느릴 수 있음

절대압 비교는 정차/이동 불문하고 **현재 위치가 지하인지 지상인지**를 즉시 판단.

---

## §2 Problem

### dP/dt 진입 방식의 구조적 한계 (plan-1845 §2 인용)

```
사용자: 지하역 내부에서 앱 실행
  → useBarometer 마운트 → ring buffer 비어있음
  → 30s warm-up: 기압 변화 없음 (이미 지하 = 깊이 고정)
  → dP ≈ 0 → evaluateSubsurfaceEnter → detected = false
  → subsurface = false (영구 고착)
```

**코드 위치**: `src/shared/utils/barometerSubsurface.ts:79`
```typescript
detected: window.deltaHpa >= BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA - FP_EPSILON
```

이미 지하에서 `deltaHpa ≈ 0` → 항상 `detected = false`.

### downstream 영향 (3곳)

1. `stickyStationGates.ts:72` — `fix.subsurface === true` 조건 false → GPS 오버라이드 허용 증가
2. `useFusedNearestStation.ts:1635` — `subsurfaceStationDetected` 경로 진입 불가
3. `useNearestStation.ts:374` — `FG_WATCH_OPTIONS_SUBSURFACE` 미선택 → 지하 GPS noise 증폭 위험

### 임계값(0.3 hPa) 변경으로는 해결 불가

plan-1845 §6 결론: 임계는 "진입 이벤트" 신호용으로 설계됨.
- 임계 낮추면: 건물 계단 false positive ↑
- 임계 높이면: 얕은 역(5m 이하) miss ↑
- **구조 자체를 바꾸지 않으면 "이미 지하"는 해결 불가**

---

## §3 메커니즘 — surfacePressure 외부 Source 주입 + 절대압 비교

### 핵심 아이디어

```typescript
// 현재 측정 기압과 지상 기준 기압의 차이로 지하 여부 판정
const MIN_UNDERGROUND_DP_HPA = 15 * 0.12; // 15m 기준 = 1.8 hPa
const subsurfaceAbsolute = (measuredHpa - surfaceHpa) > MIN_UNDERGROUND_DP_HPA;
```

- `surfacePressure`: 현재 날씨 기준 해면기압 (외부 API 또는 디바이스 지상 캐시)
- `measuredHpa`: 현재 barometer 측정값
- 차이가 `MIN_UNDERGROUND_DP_HPA`(~1.8 hPa = 15m 등가)를 초과하면 지하로 판정

### 기존 `narrowStationsByPressure` 활용 가능성

`barometerState.ts:131`의 `narrowStationsByPressure`는 이미 측정 절대압과 역 depth 데이터를 비교하는 로직 → 환경 판정 함수로 확장 연계 가능.

### dP/dt 방식과의 공존

두 신호는 **보완 관계** (OR consensus):
- dP/dt: 지하 진입 이벤트 감지 (진입 직후 정확)
- 절대압: 이미 지하 상태 감지 (cold start, 재실행 정확)

```typescript
subsurface = dPdt_detected || absoluteDepth_detected
```

---

## §4 surfacePressure Source 옵션

| Source | 정확도 | 갱신 주기 | API 비용 | iOS 의존성 | 비고 |
|---|---|---|---|---|---|
| Apple WeatherKit | 높음 (기상청 급) | 실시간 | 무료 (Apple Developer) | Apple ID 필수 | iOS 전용, entitlement 필요 |
| 한국 기상청 API | 높음 (국내 최고) | 1시간 | 무료 | 없음 | lat/lng → 격자 변환 필요, quota 제한 |
| Open-Meteo | 중-높음 | 1시간 | 무료 (CC) | 없음 | 상업 무료 tier, REST 간단 |
| OpenWeatherMap | 중간 | 1시간 | 무료 tier 1000/day | 없음 | 간단하나 precision 낮음 |
| 디바이스 지상 캐시 | 중간 (drift 가능) | 마지막 지상 시점 | 0 (local) | 없음 | GPS elevation ≈ 0m에서 캡처, 60분 TTL |

**권장 평가 순서**: 디바이스 지상 캐시(sub 1 탐색) → Open-Meteo(비용 0, 의존 없음) → 한국 기상청 → Apple WeatherKit

---

## §5 트레이드오프

| 항목 | 상세 |
|---|---|
| 정확도 | 절대압 ±1 hPa 오차 가능 → 10m 등가 → 5m 이하 역 mis-classify 위험 |
| latency | 기상 API 응답 1~5초 → cold start 시 첫 판정 지연 가능 |
| API 비용 | Open-Meteo/기상청 무료 tier 내 충분 (1회/hour 기준) |
| Apple ID 의존 | WeatherKit 선택 시 EntitlementRequiredError 처리 필요 |
| 기상 변동 | 날씨 전선 통과 시 ±5 hPa 변동 → 임계 조정 필요 가능성 |
| ttlCache | surfacePressure 60분 TTL — 이동 중 기상 변화 lag 허용 가능 |
| 배터리 | 기상 API 1회/hour 호출 — 무시 가능 수준 |
| iOS BG 제약 | BG fetch 시 API 호출 가능 (URLSession background task) — BG trip에서도 유효 |

---

## §6 Sub-issue 분할

### Sub 1: surfacePressure source 인프라 결정 (API 평가 + sample 호출)

**목표**: 어느 API를 사용할지 결정 + 실제 호출 검증

**작업**:
- Open-Meteo, 한국 기상청, Apple WeatherKit 3개 API 샘플 호출 비교
- 응답 속도, 정확도(서울 기준 기상청 대비 오차), 무료 quota 확인
- iOS BG fetch 가능 여부 검증
- 결정 docs 업데이트

**Acceptance**: API 선택 완료 + 실제 hPa 값 ±1 hPa 이내 확인

**예상 소요**: 0.5~1일

---

### Sub 2: pressureBaseline storage + ttlCache + lat/lng fetch

**목표**: 선택된 API로 surfacePressure를 fetch하고 캐시하는 인프라

**작업**:
- `src/shared/utils/surfacePressureCache.ts` — ttlCache(60분) wrapping + lat/lng 기반 fetch
- 디바이스 지상 캐시 fallback: GPS elevation ≈ 0m 시점에서 현재 barometer값 저장 (캐시 없을 때)
- `useBarometer.ts` 또는 별도 훅에서 앱 cold start 시 1회 fetch
- 단위 테스트 (fetch mock, TTL 만료 동작)

**Acceptance**: cold start 시 `surfacePressureHpa` 값 DebugModal에서 확인 가능

**예상 소요**: 0.5~1일

---

### Sub 3: inferEnvironment 절대압 판정 wire + SSOT consensus 참여

**목표**: `inferEnvironment.ts`에 절대압 기반 subsurface 판정 추가

**작업**:
- `evaluateAbsoluteSubsurface(measuredHpa, surfaceHpa): boolean` 신규 함수
  (`barometerSubsurface.ts` 확장 또는 `barometerAbsolute.ts` 신규)
- `inferEnvironment.ts`에서 `absoluteSubsurface` 신호 참여:
  `subsurface = dPdt_detected || absoluteSubsurface`
- 기존 dP/dt 신호 우선 유지 (하위 호환)
- RAW_SIGNALS 포워드에 `absoluteSubsurface` 필드 추가 (sub 4 의존)
- 단위 테스트: "이미 지하" 시나리오 명시적 케이스 포함

**Acceptance**: "이미 지하" cold start 시뮬레이션 테스트에서 `subsurface=true` 판정

**예상 소요**: 1일

---

### Sub 4: 1주 측정 wire (RAW_SIGNALS forward)

**목표**: 절대압 판정 신호 관측 가능하게 wire

**작업**:
- RAW_SIGNALS payload에 `surfacePressureHpa`, `absoluteSubsurface`, `absoluteSubsurfaceDeltaHpa` 추가
- DebugModal에 `absoluteSubsurface` 표시 (subsurface 행 옆 `abs` badge)
- backend `/raw-signals` → Cloudflare D1 저장 (기존 파이프라인 활용)
- wrangler tail 쿼리로 `absoluteSubsurface=true` 빈도 모니터링 방법 문서화

**Acceptance**: 실기기 trip 1회 후 D1 또는 DebugModal에서 `absoluteSubsurface` 값 확인 가능

**예상 소요**: 0.5일

---

## §7 Acceptance — Epic Close 조건

> **PR 머지 = close 금지.** 아래 evidence 1:1 달성 후 close.

| # | 시나리오 | Evidence | 기준 |
|---|---|---|---|
| E1 | 지하역 내부 cold start | DebugModal `absoluteSubsurface=true` 확인 | 3회 연속 재현 |
| E2 | 지하 이동 중 (정차 전) | `absoluteSubsurface=true` + downstream gate 정상 | 1회 trip 완성 |
| E3 | 지상 false positive 없음 | 지상 보행 중 `absoluteSubsurface=false` 유지 | 1회 지상 trip 확인 |
| E4 | 기상 변동 오판 없음 | surfacePressureHpa 갱신 후 `absoluteSubsurface=false` 유지 | 1주 실측 or 이론 검증 |

**1주 production 회귀 기준**: "이미 지하" cold start에서 `subsurface=false` 고착 재발 0건
(D1 RAW_SIGNALS `absoluteSubsurface=false + measuredHpa - surfaceHpa > 1.8` 쿼리 기반)

---

## §8 Wire-completion 5단

1. **Orphan**: epic doc only — N/A. 각 sub-issue PR에서 `npm run lint:orphan` pass 강제.
2. **V/X dashboard**: 절대압 신호 → DebugModal `absoluteSubsurface` badge + D1 `raw_signals.absoluteSubsurfaceDeltaHpa` 관측
3. **의존 PR**: #1848(barometer threshold audit doc) 머지됨. 옵션 C(F2) PR 머지 후 coverage evidence ↑
4. **측정 plan**: sub 4 RAW_SIGNALS wire → 실기기 1주 trip → D1 쿼리 `absoluteSubsurface=true` 빈도 측정
5. **Device verify**: Epic close 조건 — 실기기 "이미 지하" cold start trip E1~E3 달성 필수

---

## §9 관련 메모리 / 참고 문서

- `memory/feedback_acceptance_drives_code.md` — 사용자 가치 → acceptance → 코드 순서
- `memory/feedback_epic_close_field_verify.md` — Epic close = PR 머지 아님, 실기기 1주 evidence 필수
- `memory/feedback_decision_no_false_binary.md` — 옵션 최소 3개 제시 (plan-1845 §4에서 A/B/C/D/E 5개 제시)
- `tasks/plan-1845-barometer-threshold-audit.md` — 본 epic 출처 audit doc (§6 결론 인용)
- `docs/decisions/ADR-010-sensor-fusion-policy.md` — 두 실패 모드(false positive/miss) 동급 원칙
- `docs/decisions/ADR-014-decision-process-rules.md` — 결정 프로세스 룰

---

## Sub-issue 링크

등록 완료 후 업데이트:
- [ ] Sub 1: surfacePressure source 인프라 결정 (#TBD)
- [ ] Sub 2: pressureBaseline storage + ttlCache + lat/lng fetch (#TBD)
- [ ] Sub 3: inferEnvironment 절대압 판정 wire + SSOT consensus (#TBD)
- [ ] Sub 4: 1주 측정 wire (RAW_SIGNALS forward) (#TBD)

---

## Out of scope

- Sub-issue 본격 구현 (epic close 후 차례로 진행)
- 옵션 C (barometer-stop 힌트) — F2에서 별도 진행
- 옵션 E (accelerometer fingerprint) — Phase 6.2+ 별 epic (#1763)
- 0.3 hPa 임계값 변경 — plan-1845 §6에서 유지 결정 완료
