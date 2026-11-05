# Plan #1821 — device environment=unknown 100% 분류 회귀 fix

**SSoT**: 본 문서. evidence 추가 audit 권고 포함.

## 1. 문제

device가 지하 trip을 underground/hybrid로 분류하지 못함. 100% unknown 잔존.

### Production evidence (2026-06-25 Day 2 dump)

```
## Environment Distribution
surface=0.0% underground=0.0% hybrid=0.0% unknown=100.0%
totals: surface=0s underground=0s hybrid=0s unknown=7s
transitions=0
observed=7s
```

- Trip 2 (한양대→왕십리→마장, 13:46~13:50): 환승 1회, 5호선 마장 지하 ~15m
- Trip 3 (마장→사가정, 13:55~14:24): 7호선 용마산/사가정 지하 ~20m
- 35분간 지하 trip — **하지만 환경 분류 0 transitions, 결국 unknown 100%**

### 사용자 가치 손실

- environment=unknown → backend `boardingPrompt.ts:225` `isGpsDependentBypassEnv` 분기 false → motion 게이트 직격
- 잔여 회귀 #1 (motion-not-moving) production 36회 증폭
- 신호 분류 (autoLock candidate, fusion confidence 등) 모두 unknown 처리

## 2. 원인 분석

### 가설 1 (진입점 메모리) — barometer 임계 0.3 hPa 너무 높음

- 서울 2호선 천층 10~25m, 임계 미달 가능성
- **하지만**: dump `subsurface=false (reason=readings, readings=30)` — 30 reading 누적인데 dP 미달

→ Trip 3는 사용자가 **이미 지하에 있는 상태**. barometer는 **진입 시점** 신호. 이미 지하인 사용자에게 barometer는 부적합.

→ **가설 1만으로는 해결 안 됨.**

### 가설 2 — undergroundSSotConsensus quorum 2-of-N 미달

**파일**: `src/features/nearest-station/utils/undergroundSSotConsensus.ts:47, 136`

```ts
const CONSENSUS_QUORUM = 2;  // L47
// L136
if (stationPairs.length + envVotes < CONSENSUS_QUORUM) return null;
```

trip 초기:
- arrival API 미응답 (Seoul API 5/5 error production confirmed)
- WiFi BG nil (사용자 5G/LTE 사용 — [[reference_ios_wifi_api_constraint]])
- barometer ineffective (이미 지하)
- cellular env vote: 별도 audit 필요

→ env vote 1표만 있으면 quorum 미달 → SSOT 채택 불가 → unknown.

### 가설 3 — environment counter observed=7s가 진짜 의미

dump observed=7s + transitions=0. 35분 trip인데 dump 시점 직전 7초만 측정?

→ environmentDistributionCounter 작동 메커니즘 audit 필요.

### 코드 위치

- `src/shared/constants/barometer.ts:21` `BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA = 0.3` (가설 1)
- `src/features/nearest-station/utils/undergroundSSotConsensus.ts:47, 136` quorum (가설 2)
- `src/features/nearest-station/utils/environmentDistributionCounter.ts` counter (가설 3)

## 3. 방안 옵션 (3개 이상)

### A. Quorum 완화 — station pair 단독 1개 + warmup 60s window (중간 fix)

```ts
const CONSENSUS_QUORUM_WARMUP = 1;  // 첫 60s
const CONSENSUS_QUORUM_STEADY = 2;  // 60s 이후 기존 정책
```

trip 시작 첫 60s는 station pair 단독 1개만으로 underground 채택. 60s 이후 기존 2-of-N.

- 효과: warmup 동안 분류 가능
- 위험: false underground 분류 (단 60s window 안)

### B. Cellular underground vote 단독 채택 (가설 audit 후 결정)

`cellularEnvironmentVote === 'underground'`이면 station pair 0개여도 environment=underground 결정.

- 효과: 5G/LTE 환경에서 cellular tech 분류만으로 underground 채택
- 위험: 일부 LTE 영역도 underground vote → false positive (cellularTech.ts audit 후 신뢰성 평가)

### C. Warmup label 추가 (현 quorum 유지, 가시화만)

`environmentDistributionCounter.ts`에 `unknown_warmup` (observed < 60s) 라벨 추가. 분류는 그대로지만 caller가 "warmup 중"과 "진짜 unknown" 구분.

- 효과: backend / boardingPrompt 게이트가 warmup grace 적용 가능 (잔여 #1 옵션 B와 결합)
- 위험: 0 (분류 미변경)

### D. Barometer 임계 완화 (진입점 메모리 가설 1, 단독 효과 제한)

`BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA` 0.3 → 0.15 hPa.

- 효과: 천층 진입 시점 감지 ↑
- 한계: 이미 지하인 사용자에게 효과 0 (dump evidence는 이 케이스)
- 위험: 엘리베이터/계단 false positive ↑ (현 0.3 hPa 근거는 "2.5m/30s 하강 = 일반 보행 미달")

### E. 가설 audit 우선 (코드 변경 전)

evidence 더 수집 후 결정. 옵션 A/B/D 각각 production 효과 다름.

- audit 1: cellularTech.ts vote 정확도 (5G/LTE 환경)
- audit 2: environmentDistributionCounter observed window 의미 (7s 정확히 무엇인지)
- audit 3: 마장→용마산 trip의 station pair / env vote 분포 (어떤 신호가 왜 부족했나)

## 4. 트레이드오프

| 옵션 | 사용자 가치 회복 | False positive | 변경 범위 | 회귀 위험 | audit 필요 |
|---|---|---|---|---|---|
| A (quorum warmup) | 높음 | 낮음 (60s window) | 1 파일 + tests | 낮음 | 적음 |
| B (cellular 단독) | 중간 (LTE 환경 의존) | 중간 | 1 파일 + tests | 중간 | 많음 (cellularTech 신뢰성) |
| C (warmup label) | 낮음 (단독으론 효과 0, 잔여 #1과 결합 시 효과) | 0 | 1 파일 | 0 | 적음 |
| D (barometer) | 낮음 (진입 시점만) | 중간 (엘리베이터) | 1 파일 | 낮음 | 적음 |
| E (audit 우선) | — | — | 0 LOC | 0 | — |

### A + C 결합 (추천)

- A로 분류 회복 + C로 잔여 #1과 결합 + backend 게이트가 warmup grace 적용
- B/D는 별도 PR로 audit 후

## 5. 결정

**선택: A + C 결합 — quorum warmup 완화 + warmup label**

이유:
1. evidence가 가장 명확히 cover (warmup 동안 station pair 단독 1개라도 분류 회복)
2. False positive 위험 60s window로 제한
3. 잔여 회귀 #1 fix (옵션 A — GPS-bypass 환경 motion=unknown 허용)와 시너지
4. B (cellular 단독)와 D (barometer)는 audit 필요 → 별도 follow-up
5. C 단독 label은 caller가 warmup 구분 가능하게 — backend 게이트 grace 적용 길

### Acceptance

- `undergroundSSotConsensus.test.ts` 추가:
  - 첫 60s + station pair 1개 → underground 채택 (warmup quorum=1)
  - 60s 이후 + station pair 1개 → null (steady quorum=2)
  - 첫 60s + env vote 1개만 → null (station pair ≥ 1 여전히 필수)
- `environmentDistributionCounter.test.ts`:
  - observed < 60s → label `unknown_warmup`
  - observed ≥ 60s → 기존 라벨
- production 1주 측정: environment 분류 transitions > 0 회복, unknown_warmup vs unknown 분포 확인

### Out of scope (follow-up audit)

- 옵션 B (cellular 단독): `cellularTech.ts` 5G/LTE 신뢰성 audit
- 옵션 D (barometer): 천층 진입 시점 효과 측정
- 옵션 E의 audit 2, 3: BG agent가 evidence 추가 시 별도 메모리

## 6. Wire-completion 5단 self-check

1. Orphan 없음 — quorum 상수 + warmup label 모두 기존 함수에 추가
2. V/X dashboard — DebugModal Environment Distribution 라벨 (`unknown_warmup` 추가)
3. 의존 PR — 잔여 회귀 #1 fix와 시너지지만 독립 머지 가능
4. 측정 plan — production 1주, environment transitions > 0 회복 + boarding-prompt blocked 차단 ↓
5. Device verify — 실기기 지하 trip 1건 필수 (단순 unit test로 검증 어려움 — backend cron 의존)

## 관련 메모리

- [[reference_ios_wifi_api_constraint]] iOS WiFi 사용자 연결된 SSID만, 5G/LTE BG nil
- [[lesson_motion_activity_intermittent_signal]] motion 5~10분 lag — 잔여 #1과 결합
- [[feedback_device_self_contained_fusion]] backend / WiFi 모두 죽어도 device 자체 분류
- [[project_2026_06_25_day2_pr1819_confirmed]] Day 2 진입점
- [[feedback_decision_no_false_binary]] 옵션 3개+ — D 가설 단독 채택 X 정정

## BG agent 위임 지시

- worktree: 격리 필수 (parent 이동 금지)
- 작업:
  1. 옵션 A 구현 (quorum warmup + steady 분기)
  2. 옵션 C 구현 (environmentDistributionCounter warmup label)
  3. acceptance 테스트 추가
  4. DebugModal Environment Distribution 라벨 추가 (`unknown_warmup` 표시)
- 추가 audit (별도 메모리로 보고): cellularTech.ts 5G/LTE 신뢰성, environmentDistributionCounter observed window 정확한 의미
- 머지 후 worktree 즉시 cleanup
