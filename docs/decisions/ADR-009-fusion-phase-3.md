# ADR-009: Phase 3 Fusion — Kalman + Acceleration + Phase + Drift

## 상태

제안됨 (2026-06-04)

관련 Epic: #818 (Phase 3 Fusion roadmap, closed)
관련 sub-issue: #823 (E1 가속도), #824 (E2 Kalman), #825 (E3 phase), #826 (E4 drift reset), #827 (E5 측정 인프라)
관련 PR (머지): #831/#823, #832/#824, #835/#825, #836/#826, #830/#827
참조 ADR: ADR-006 (silent push telemetry), ADR-008 (boarding progress estimator)

## 배경 — 왜 GPS-only로는 부족했나

Phase 1 (좌표 series + fused speed)과 Phase 2 (map matching)까지 합쳐 클라이언트가 1차 GPS 노이즈를 흡수할 수 있게 됐다. 그러나 실기기 회귀 큐 (메모: `project_2026_06_03_field_regression_queue.md`) 항목 6에서 다음 마지노선이 GPS-only만으로는 깨졌다:

| 마지노선 | GPS-only 한계 |
|---|---|
| 정거장 단위 정확도 | 터널 진입/dead zone에서 좌표 dropout → 1~2역 drift |
| 운행 phase 정확도 | "도착인지/정차인지/출발인지" 판정 불가능 → 잘못된 시점 imminent push |
| 임박 알림 ≤ 30s SLA | client.speed `-1` 회귀(#812) + dead zone 누적으로 fired 시각이 ARRIVED 후로 밀림 |
| Drift 회복 | 한 번 어긋난 추정이 다음 fix까지 자가 보정 없음 |

핵심 통찰: **GPS만의 weighted average로는 위 4개를 동시에 못 잡는다.** 노이즈 모델(Kalman), 운동 신호(가속도), 운행 의미(phase 분류), ground truth 재앵커(arvlCd) — 4축을 직교로 결합해야 한다. Phase 3은 이를 backend cron(60s) cycle에 5개 sub-issue로 분해해 직렬 머지했다.

## 결정 — 5개 sub-decision (E1~E5)

각 결정은 backend `alarm-worker/src/`에 모듈로 격리되어 있고, `scheduled.ts > runFusionStep`이 통합 진입점이다. 임계값은 모두 한 파일에 SSOT로 export — 매직넘버 금지(글로벌 규칙 3).

### E1 — 가속도 1초 window summary (#823, PR #831)

**파일**: `accelSeries.ts`, `src/tasks/backgroundLocationTask.ts`

100Hz CMMotionManager raw → 1Hz `AccelSummary` (`magnitudeMean`, `magnitudeStd`, `magnitudePeak`)로 압축해 backend `/position`으로 업로드. KV ring buffer + 60s 윈도우 evaluate.

| 결정 | 값 | 근거 |
|---|---|---|
| Window | `ACCEL_WINDOW_MS = 60_000` | `positionSeries` 60s와 정합 — 같은 cron cycle 평가 |
| Max samples | `MAX_SERIES_SAMPLES = 90` | 60s window + 50% margin |
| KV TTL | 1h | `positionSeries` SERIES_TTL과 정렬 |
| 클라 freshness | `ACCEL_SUMMARY_MAX_AGE_MS = 5_000` | 5s 이상 stale 샘플은 정확도 신뢰 못함 — E1 결정적 정책 |
| Direction | unsigned magnitude만 | 가/감속 부호는 E3 velocity trend로 위임 — 단순화 |

**왜 1Hz로 다운샘플**: 100Hz 그대로면 KV PUT 빈도/저장량 폭발. magnitude std가 가/감속 phase 신호로 충분.

### E2 — 1D Kalman filter (#824, PR #832)

**파일**: `kalmanFilter.ts`, `fusedSpeed.ts`

좌표 series `gpsAvgKmh` (관측) + E1 `magnitudeStd` (process noise driver) → Kalman smoothed velocity `state.v`. 결과는 `fusedSpeed`에 `KALMAN_WEIGHT` 가중치로 합류.

| 결정 | 값 | 근거 |
|---|---|---|
| State | scalar `v` (km/h), `P` 분산, `ts` | 1D — 위치 추정은 map matching이 처리 |
| Predict | `v_pred = v_prev`, `P_pred = P_prev + Q · Δt` | constant velocity random walk — 정거장 정차/cruise 모두 0 drift |
| Direct accel driver 채택 안 함 | — | `magnitudeMean`은 unsigned positive — 정차 phase에서도 위로 drift |
| 관측 R (km/h)² | `<20m → 4`, `<50m → 25`, `<100m → 100`, `≥100m → 400` | accuracy 단계 함수, ~±2/±5/±10/±20 km/h 신뢰 |
| 프로세스 Q (km/h)²/s | `<0.5 m/s² → 1`, `<2.0 → 9`, `≥2.0 → 36` | accel stddev 클수록 predict 분산 ↑ → GPS update 강하게 보정 |
| 초기 P₀ | `R(accuracy)` | 첫 관측의 분산이 prior 부재 시 가장 정확한 사전 |
| State 만료 | `STATE_STALE_THRESHOLD_MS = 5min` | 이 이상 Δt면 observation으로 직접 초기화 |
| `KALMAN_WEIGHT` | `0.6` | Kalman은 GPS observation에 부분 의존 — 독립 신호 대비 보수적 시작. E5 측정 후 ↑ 조정 |
| KV TTL | 1h | series TTL과 정렬 |

**왜 Q를 stddev로 인코딩**: signed velocity가 없는 unsigned magnitude를 안전하게 활용. 가속도 흔들림이 크면 prediction 불확실성 ↑ → GPS가 자동으로 더 강하게 이긴다.

### E3 — 4-class phase 분류 + 2-cycle hysteresis (#825, PR #835)

**파일**: `stationPhase.ts`, `scheduled.ts:runStationPhaseStep`

`APPROACHING` / `DWELLING` / `DEPARTING` / `CRUISING` 4-class. Rule-based feature score matrix + argmax + confidence. 2-cycle hysteresis로 flicker 방지. **lockless imminent gate**에 wire되어 "high-confidence non-APPROACHING"이면 push 차단.

| 결정 | 값 | 근거 |
|---|---|---|
| 정거장 근접 임계 | `STATION_NEAR_RADIUS_M = 200` | APPROACHING/DWELLING/DEPARTING 모두 의미 있는 거리 |
| 정차 임계 | `STATION_DWELL_RADIUS_M = 50` | DWELLING은 더 좁은 반경 |
| 정지 속도 | `STATIONARY_KMH = 5` | DWELLING 후보 |
| 순항 속도 | `CRUISE_KMH = 20` | CRUISING 후보 |
| Accel 임계 | `MOTION_ACCEL_THRESHOLD = 0.5 m/s²` | 출발/감속 phase 활성화 |
| 속도 변화 | `VELOCITY_DELTA_KMH = 3` | cron 60s × 가속 ~1 m/s² (3.6 km/h/s) — 노이즈 ↓ 실 가/감속만 |
| Hysteresis boost | `SAME_PHASE_BOOST = 0.2` | 같은 phase 유지 시 confidence ↑ |
| 전환 cycle | `SWITCH_CYCLES = 2` | 후보가 2 cycle 연속이어야 전환 |
| Imminent gate phase | `IMMINENT_FIRING_PHASES = ['APPROACHING']` | 그 외 confidence ≥ 0.7는 차단 |
| Imminent gate confidence | `IMMINENT_FIRING_CONFIDENCE = 0.7` | 낮은 신뢰는 기존 arvlCd/ETA 신호에 위임 |

**왜 ML 모델 보류**: score matrix는 데이터 주도이며 임계값만 E5 측정으로 조정 가능. ML은 라벨 확보/배포 비용이 ROI를 못 넘긴다 (Phase 4에서 재평가).

**왜 lockless gate만 wire**: BoardingLock 활성 trip은 ADR-008의 progress estimator가 책임. lockless flow는 phase 신호가 false positive 1차 차단의 가장 큰 효용. **신호 부재(`null`)/낮은 신뢰는 허용** — 회귀 방지 우선, 차단은 보수적.

### E4 — arvlCd=ARRIVED hard reset + drift telemetry (#826, PR #836)

**파일**: `kalmanFilter.ts:resetKalmanForArrival/detectKalmanDrift`, `scheduled.ts`

정거장 도착(`arvlCd=1` 또는 `ENTERING/ARRIVED` fires)은 가장 강한 ground truth — 실제 정차 상태. Kalman state를 `v=0`, `P=R_LOW`, `ts=now`로 직접 재초기화해 drift 누적을 차단. 동시에 정상 cycle의 `|gpsAvgKmh - state.v|`를 측정해 `DRIFT_WARNING_THRESHOLD_KMH = 15` 초과를 `stats.kalmanDriftWarning`에 누적.

| 결정 | 값 | 근거 |
|---|---|---|
| Reset trigger | `arvlCd=1` (ARRIVED) + lockless `ENTERING/ARRIVED` fires | 가장 강한 신호 — phase 가드 무관 hard reset |
| Reset state | `v=0`, `P=R_LOW(=4)`, `ts=now` | 거의 0 노이즈 신호 — 가장 좋은 GPS와 동일 신뢰 |
| Drift 임계 | `DRIFT_WARNING_THRESHOLD_KMH = 15` | 역 사이 평균 ~30~40 km/h의 절반 — 의미있는 편차. 보수적 시작, E5 측정 후 ↓ 조정 |
| Drift 측정 시점 | prior 존재 + observation valid | 첫 cycle은 v=gpsAvg 초기화라 delta=0 — 의미 없음 |

**왜 hard reset (soft update 아님)**: arvlCd는 거의 noise-free한 ground truth. Bayesian update로 흡수하기보다 prior를 통째로 갈아끼우는 게 drift recovery latency를 최소화.

### E5 — 측정 인프라 (#827, PR #830)

**파일**: `backend/alarm-worker/src/metrics.catalog.json`, `metrics.ts`, `scripts/perf-report.js`

Phase 3 fusion baseline 지표를 카탈로그 JSON 1개로 SSOT 통합. backend metrics 모듈과 perf-report 스크립트가 동일 카탈로그를 import — 추가 지표는 JSON에 행 추가만으로 가능 (글로벌 규칙 3 적용).

| 지표 key | format | gate |
|---|---|---|
| `boardingFalsePositiveRate` | rate | `> 0.05` → falsePositive trigger |
| `imminentSlaErrorMs` | histogram (p95) | `> 30000ms` → imminentSla trigger |
| `stationPassedAccuracy` | rate | — (관측) |
| `phaseClassificationAccuracy` | rate | — (E3 precision/recall) |
| `driftRecoveryMeters` | histogram | — (E4 회복 시점 오차) |
| `kalmanResidual` | histogram | — (E2 predict vs observe) |

| 상수 | 값 | 의미 |
|---|---|---|
| `SLA_LATE_THRESHOLD_MS` | 30000 | 임박 알림 SLA 마지노선 |
| `FALSE_POSITIVE_RATIO_THRESHOLD` | 0.05 | 9단 게이트 통과 후 미탑승 dismiss 상한 |
| `MIN_SAMPLE_FOR_DECISION` | 30 | 임계 조정 의사결정 최소 표본 |
| `SLA_PERCENTILE` | 0.95 | p95 percentile 기준 |
| `METRIC_LABEL_PREFIX` | `phase3` | Cloudflare metric 네임스페이스 |

**왜 catalog JSON SSOT**: E2 임계 조정/E3 confidence 컷오프/E4 drift 임계 모두 측정 후 데이터로 결정해야 한다. 두 호출자(backend/스크립트)가 같은 정의를 안 본 채 분기하면 의사결정이 disagree.

## 이유 / 확장성

1. **직교 결합 (ADR-006 ↔ ADR-008 ↔ ADR-009)**: ADR-008은 BoardingLock 활성 trip의 hop progress, ADR-009는 모든 trip의 속도 추정/phase 신호. 두 ADR은 같은 신호(`realtimePosition`, `arvlCd`, ETA)에 다른 가중치를 둬 충돌하지 않는다. ADR-006의 telemetry는 E5 catalog로 확장됐다.
2. **데이터 주도 (글로벌 규칙 3)**: phase score matrix, 노이즈 R/Q 단계 함수, 측정 카탈로그 모두 데이터/객체. if-else 분기 추가 없이 행/임계 조정만으로 진화 가능.
3. **보수적 회귀 방지**: E2/E3는 `null`/낮은 신뢰/observation invalid 시 기존 동작 그대로. wire 단계(#834 client distance stamp)가 완료되기 전까지 phase 신호 부재 시 graceful degradation.
4. **SSOT 임계값**: 모든 상수가 `kalmanFilter.ts`/`stationPhase.ts`/`fusedSpeed.ts`에 `export const`로 단일 정의. 테스트/perf report/문서가 한 곳을 참조.

## 트레이드오프

| 장점 | 단점 |
|---|---|
| GPS dropout/터널/정거장 정차에 robust한 속도 | 4개 모듈 추가 (accel/kalman/phase/drift) — 인지 부담 |
| arvlCd ground truth로 drift 누적 차단 | KV PUT 빈도 ↑ (accel series + kalman state) — 비용/지연 |
| Phase 신호로 lockless imminent false positive 1차 차단 | 임계값 6개 신규 — E5 측정 후 조정 cycle 필요 |
| 데이터 주도 catalog로 측정/SLA gate 통합 | client.distance stamp(#834) wire 전까지 phase 효용 부분적 |
| 직교 ADR 설계로 #818 epic을 5 PR로 직렬 머지 | Particle filter(Phase 4)로의 마이그레이션 비용 미평가 |

## 대안 검토

### A. Particle filter / multi-hypothesis tracking (보류)

도심 다중 노선/환승 노이즈에 robust할 수 있지만 (a) state/메모리 비용, (b) 평가 cycle 시간, (c) 디버깅 난이도가 60s cron 한계 안에서 ROI 없음. Phase 4 후보로 명시 보류 — E5에서 `kalmanResidual`/`driftRecoveryMeters`로 1D Kalman의 한계가 측정으로 드러나면 재검토.

### B. 클라 측 Kalman (보류)

Backend 통합 결정 근거: (a) KV state는 device crash/reinstall 사이 복원 가능, (b) silent push 발사 가드와 같은 cron cycle에서 평가, (c) iOS background CPU/배터리 부하 회피. 클라 측 단점은 짧은 freshness — backend가 이미 60s cycle이라 같은 latency.

### C. ML 기반 phase 분류 (Phase 4 후보)

Rule-based score matrix가 E5 측정으로 임계 조정 가능한 동안 우선. 라벨 확보(arvlCd ground truth + 사용자 dismiss) 인프라가 자연 누적되므로 Phase 4 진입 시 데이터 부족 문제 없음.

## 구현 단계 (실제 진행 순서)

1. E5 측정 인프라 먼저(#827/PR #830) — 후속 의사결정 인프라 선행
2. E1 가속도 수집(#823/PR #831) — 클라 capture + backend KV 적재
3. E2 Kalman filter(#824/PR #832) — `fusedSpeed`에 합류
4. E3 phase 분류(#825/PR #835) — lockless imminent gate wire
5. E4 arvlCd reset + drift telemetry(#826/PR #836) — ground truth 통합

## 결과 (관측 예정)

- `imminentSlaErrorMs` p95 ≤ 30s 마지노선 달성률 측정
- `kalmanDriftWarning` 누적 추이 → R/Q 단계 임계 조정 근거
- `phaseClassificationAccuracy` precision/recall → score matrix 행/contribution 조정 근거
- `boardingFalsePositiveRate` → E3 lockless gate가 1차 차단에 효용 있는지 검증

## 후속 (Follow-ups)

| 항목 | 이슈 / PR | 상태 |
|---|---|---|
| P2-1 phase gate 회귀 검증 | #837 / PR #840 | 머지됨 (2026-06-04) |
| P2-2 R/Q 임계 측정 후 재조정 | (E5 데이터 누적 대기) | 보류 |
| P2-3 drift 임계 ↓ 조정 | (E5 데이터 누적 대기) | 보류 |
| P2-4 phase score matrix 튜닝 | (E5 데이터 누적 대기) | 보류 |
| Client distance stamp wire | #834 / PR #839 | 머지됨 (2026-06-04) |

## 참고 (References)

### 코드 (backend/alarm-worker/src/)

- `accelSeries.ts` — E1 가속도 ring buffer + window
- `kalmanFilter.ts` — E2 1D Kalman + E4 reset/drift
- `fusedSpeed.ts` — KALMAN_WEIGHT 합류 지점
- `stationPhase.ts` — E3 score matrix + hysteresis + imminent gate
- `scheduled.ts` — `runFusionStep` / `runStationPhaseStep` 통합 진입점
- `metrics.catalog.json` — E5 SSOT

### 메모 SSOT 통합

이후 메모는 ADR-009를 인용한다 (Phase 3 결정 단일 출처).

- `project_phase3_fusion_queue.md` → ADR-009로 결정 이관 완료
- `project_phase3_roadmap.md` → 사전 단계 (Stage 1~3) 별도 유지

### 관련 ADR

- **ADR-006** (silent push telemetry) — E5 catalog가 ADR-006 텔레메트리 인프라를 확장
- **ADR-008** (boarding progress estimator) — BoardingLock 활성 trip의 hop progress는 ADR-008, fusion 속도/phase 신호는 ADR-009. 두 신호는 직교
