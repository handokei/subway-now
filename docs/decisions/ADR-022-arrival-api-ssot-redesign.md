# ADR-022: Arrival API SSOT 아키텍처 재설계

## 상태

초안 (Draft) — 이슈 #1980, 2026-07-01.

사용자 확정 후 Feature Flag 인프라 + Staged PR 시퀀스로 실행.

## 배경

### 매일 반복되는 회귀

2026-06-17 ~ 2026-07-01, 15일 연속으로 실기기 회귀가 매일 재발. 매 trip마다 layer 5~7개씩 서로 다른 곳이 깨진다. 대표적인 회귀 유형:

- lockless trip origin에 `stationProgressEstimator` `live-position`이 stuck → 매역 알림 miss
- 잘못된 하차 알림 (destination stale, `boardingLock` 재사용 미차단)
- 좀비 알림 (scheduled queue cancel 누락)
- 잘못된 fire (fusion → motion → speed → Kalman 게이트 중 어느 하나가 stale 상태로 통과)
- 지하 트립에서 GPS 저품질 → fusion cascade가 origin 근처 역으로 sticky

관련 evidence: 2026-06-30 오전/오후 trip, 2026-07-01 오전 trip. `tasks/trip-1-guui-gyodae-backend-raw-2026-06-17.md`, `tasks/trip-2-gyodae-yongmasan-backend-raw-2026-06-17.md`, 이후 매일 축적된 device dump + backend tail.

### Root Cause: 복잡한 신호 조합 아키텍처

현재 알림 정확도는 다음 신호를 결합해 판정한다:

- device: GPS(`useNearestStation`), fusion cascade(`useFusedNearestStation` 8-tier), motion(`accelMotion`), speed(`fusedSpeed`), WiFi SSID(`wifiSsidLookup`), 기압계(`useBarometer` + `barometerSubsurface`), sticky station cache(`useStickyStation`)
- backend: Kalman filter(`kalmanFilter.ts`), position series(`positionSeries.ts`), boardingPrompt 9단 게이트(`evaluateBoardingPromptGates`), consensus gate(`consensusGate.ts`), fused speed(`fusedSpeed.ts`)
- estimator: `stationProgressEstimator.ts` (Phase A pull + Phase B push, `live-position` 모드 포함)

이 신호들이 서로 sync가 어긋나면 매번 다른 layer에서 깨진다. 지금까지 각 layer마다 별도의 방어 로직(sticky cascade, hydration seam, dedup key, 정적 misfire guard, 5-layer regression fix)을 추가했지만, 새 layer가 늘어날수록 sync 실패 표면적도 함께 늘어 회귀가 종결되지 않는다.

### 근본적 재구성 필요성

- Seoul TOPIS `realtimeStationArrival` API의 `arvlCd` (0=진입, 1=도착, 2=출발, 3=전역출발, 4=전역진입, 5=전역도착)는 서울 지하철 사업자가 직접 관리하는 SSOT다.
- 사용자가 최근 Seoul TOPIS rate limit 한도를 해제하면서, 알림 로직 전체를 `arvlCd` 기반 단일 SSOT로 재구성할 여지가 열렸다.
- ADR-010이 정한 "false positive / miss는 비대칭이 아니라 동급" 원칙을 만족시키려면, 복잡한 파생 신호를 유지하는 것보다 신뢰 가능한 단일 SSOT에 의존하는 편이 훨씬 안전하다.

## 결정

**아키텍처 SSOT를 Seoul TOPIS `realtimeStationArrival` API (`arvlCd`)로 단일화한다**. fusion / motion / 기압계 / WiFi / Kalman / accel 등 파생 신호를 대량 삭제하고, 알림 판정은 backend가 폴링한 `arvlCd` 이벤트로만 트리거한다. GPS는 최초 현재역 estimate와 UI "가까운 역" 표시에만 사용하며 알림 로직에는 개입시키지 않는다.

### 결정표 (A: 아키텍처 방향 / B: 세부 정책)

| # | 결정 |
|---|---|
| A1 | 지원 노선 = 13개 유지. 경강/경춘/우이신설/서해/GTX-A/중앙 등 확장은 별도 chore 이슈로 분리 |
| A2 | Fallback 사전예약 = 기본 없음으로 시작. `boardingLockScheduler` dormant, B2 조건부로만 재활성 |
| A3 | GPS 정확도 = `Location.Accuracy.Balanced` → `Accuracy.High`로 통일 (`src/features/nearest-station/hooks/useNearestStation.ts:66`, `src/features/alarm/utils/silentPushLocationGate.ts:156`) |
| A4 | `boardingStationId` 불변 — route 등록 시 확정, 이후 auto-swap / reanchored 금지 |
| A5 | 현재역 탭 역이름 textSize 축소는 별도 chore로 분리 |
| A6 | fusion / WiFi SSID / 기압계 / accel motion / Kalman filter / `stationProgressEstimator` `live-position` 등 파생 신호 **대량 삭제** (Feature Flag 단계별) |
| A7 | GPS = 초기 현재역 estimate + UI "가까운 역" 표시만. 알림 로직 개입 X |
| B1 | Seoul TOPIS rate limit 한도 해제 완료 (사용자) |
| B2 | Backend cron 폴링 60s 유지 + **역간 이동시간 ≤60초 구간은 사전예약 fallback** (`src/data/stationTravelTimes.json` 활용, `boardingLockScheduler` 조건부 재활성) |
| B3 | arvlCd 놓침 방지 = `0`(진입) + `1`(도착) + `2`(출발) + `5`(전역도착) 조합 판정 (단순 `arvlCd=1`만 아님) |
| B4 | Backend trip token 재사용 방지 — 새 route 등록 시 새 token 강제 (`backend/alarm-worker/src/trips.ts`) |
| B5 | UI 변경 = 현재역 탭 textSize만 (A5와 동일, 별도 chore) |
| B6 | 안내시작 = 취침모드 강제 회귀 삭제. 취침모드 ON일 때만 진동 / 환승 억제 활성 |
| B7 | 첫차/막차 = 기존 `src/data/firstLastTrainTimes.json` + `src/shared/constants/lastTrainAlarm.ts` 재사용 |
| B8 | `boardingPrompt` 발사 = `arvlCd=1` 도착 시 즉시. motion / speed 게이트 없음 |

### 이유

- **SSOT 단일화**: 파생 신호를 유지하는 한, sync 실패 표면적이 sub-linear로 줄지 않는다. `arvlCd` 기반 단일 SSOT는 사업자가 관리하는 데이터를 그대로 신뢰한다.
- **정확성 게이트 = arvlCd 조합 판정 (B3)**: `arvlCd=1`만 쓰면 60s 폴링 사이 놓치는 경우 발생. `0/1/2/5` 조합으로 최소 recall 99% 확보.
- **사전예약 fallback (B2)**: 60s 폴링은 역간 이동시간이 60s 이하인 구간(예: 2호선 시청↔서울역 등)에서 원천적으로 하나 이상의 이벤트를 놓친다. 이 구간만 `stationTravelTimes.json` 기반 사전예약으로 보강.
- **`boardingStationId` 불변 (A4)**: 자동 swap이 있으면 backend token, dedup key, notification state 모두 sync 대상이 됨. 불변으로 두면 sync 실패 표면 자체가 사라진다.
- **`Accuracy.High` 통일 (A3)**: GPS estimate 정확도가 낮으면 초기 현재역이 틀리고, 그 위에 얹힌 UI/UX가 모두 오염된다. 배터리 비용은 알림 정확도와 트레이드오프.

## 결과

### 삭제 / dormant 대상 (Feature Flag 단계별)

| 파일/모듈 | 처리 | 이유 |
|---|---|---|
| `src/features/nearest-station/utils/movementGate.ts` | 삭제 | 움직임 판정 불필요 |
| `src/features/nearest-station/utils/accelMotion.ts` | 삭제 | motion 판정 불필요 |
| `src/features/nearest-station/utils/pickFusedStation.ts` | 삭제 or 최소화 | fusion 불필요 |
| `src/features/nearest-station/utils/fusionDistanceGate.ts` | 삭제 | fusion 게이트 불필요 |
| `src/features/nearest-station/utils/stationDetectionFusion.ts` | 삭제 | fusion 불필요 |
| `src/features/nearest-station/utils/wifiSsidLookup.ts` (+ 관련) | 삭제 | 지하 대체 신호를 arrival API로 대체 |
| `src/data/subwayWifiSsidMap.json` (+ bssid / stationIndex) | 삭제 | 위와 동일 |
| `src/shared/hooks/useBarometer.ts` (+ 관련) | 삭제 | 기압계 subsurface 불필요 |
| `src/shared/utils/barometerSubsurface.ts` | 삭제 | 위 |
| `src/data/stationAbsolutePressure.json` | 삭제 | 위 |
| `backend/alarm-worker/src/kalmanFilter.ts` | 삭제 | Kalman 불필요 |
| `backend/alarm-worker/src/positionSeries.ts` | 삭제 | GPS series 폴링 불필요 |
| `backend/alarm-worker/src/boardingPrompt.ts` `evaluateBoardingPromptGates` 9단 게이트 | 삭제 | `arvlCd=1`로 대체 |
| `src/features/route/utils/stationProgressEstimator.ts` `live-position` 모드 | 삭제 or 최소화 | backend arrival API가 SSOT |
| `src/features/nearest-station/hooks/useFusedNearestStation.ts` cascade 8-tier | 대량 축소 | fusion 불필요 |

### 재사용 (기존 static 데이터, 100% 확인 완료)

| 파일 | 용도 |
|---|---|
| `src/data/firstLastTrainTimes.json` | 첫차/막차 판정 |
| `src/data/stationTravelTimes.json` | 역간 이동시간 (초 단위). B2 사전예약 fallback 근거 |
| `src/data/lineHeadways.json` | 배차 간격 |
| `src/data/lineTerminals.json`, `lineTopology.json`, `transferTimes.json` | 노선 위상 / 환승 |
| `scripts/fetch-timetables.js` | timetable fetcher |
| `src/shared/utils/firstLastTrainLookup.ts` | 첫차/막차 lookup |
| `src/shared/constants/lastTrainAlarm.ts` | 막차 알람 정책 |

### Feature Flag + Staged PR 롤백 전략

Cloudflare Workers KV 와 client env 를 OR 조건으로 스위칭한다.

- Cloudflare Workers KV: `arch:simple-arrival-v1` (default OFF)
- Client env: `EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH=false`
- 판정: `(KV === 'on') || (env === 'true')` → 새 아키텍처 활성

**Staged Phase**:

| Phase | 내용 |
|---|---|
| 0 | Feature Flag 인프라 (KV 스위치 + client env + telemetry 마킹) |
| 1 | 새 아키텍처 코드 병존 (flag ON 시만 활성, OFF 시 기존 경로 유지) |
| 2 | 사용자 dogfood (flag ON) 1주 실기기 검증 |
| 3 | Default ON 전환 (전 사용자 대상) |
| 4 | 기존 코드 삭제 + Flag 제거 |

**Rollback**:

- Phase 1~3: KV OFF로 즉시 (배포 없음)
- Phase 4 이후: git revert

### Epic close 조건 (실기기 검증 필수, CLAUDE.md L2)

1. 매 waypoint `arvlCd=1` 시 알림 발사 recall ≥ 99%
2. 잘못된 알림 (destination stale, 좀비, 반복) 0건
3. `boardingPrompt` 발사율 ≥ 99% (`arvlCd=1` 조건)
4. 취침모드 OFF 시 진동 / 환승 억제 로직 동작 X
5. GPS accuracy 관련 회귀 0건 (`Accuracy.High` 통일)
6. 지하 트립 알림 정확도 지상과 동일 (arrival API SSOT)
7. 실기기 1주 재발 0건 OR 1주 production 측정 회귀 0건

## Lessons Learned

- **파생 신호를 방어 로직으로 감싸는 접근은 sync 실패 표면적을 sub-linear로 줄이지 못한다**. layer가 늘수록 sync 실패 조합이 exponential로 늘어난다.
- **사업자 SSOT가 있으면 그것을 그대로 신뢰하는 편이 낫다**. Seoul TOPIS는 사업자 자체 데이터이므로 device 측 fusion보다 신뢰도가 높다.
- **rate limit 같은 인프라 제약이 아키텍처를 왜곡시킬 수 있다**. B1(rate limit 해제)이 성사되기 전까지는 이 재설계가 불가능했다. 인프라 제약이 걷히는 시점에 아키텍처를 다시 평가해야 한다.
- **`boardingStationId` 불변 (A4) 같은 제약은 sync 대상을 원천적으로 줄인다**. "자동으로 잘 맞춰주는" 편의성은 sync 실패의 씨앗이 된다.

## refs

- 이전 관련 ADR:
  - `docs/decisions/ADR-010-sensor-fusion-policy.md` — false positive / miss 동급 원칙
  - `docs/decisions/ADR-014-decision-process-rules.md` — 결정 옵션 / Epic close / Acceptance 룰
- 이전 관련 epic:
  - #912 — 다운로드 가치 (100% 현재역)
  - #1008 — 위치 재정의
  - #1204 — Lockless 정확도 복구
  - #1362 — 2026-06-16 RCA
  - #1396 — 2026-06-17 RCA
- 실기기 evidence:
  - `tasks/trip-1-guui-gyodae-backend-raw-2026-06-17.md`
  - `tasks/trip-2-gyodae-yongmasan-backend-raw-2026-06-17.md`
  - `tasks/device-log-raw-2026-06-17.md`
  - 이후 매일 축적된 device dump + wrangler tail (2026-06-17 ~ 2026-07-01)
- 사용자 timeline + backend log + device dump 교차분석 (`memory/feedback_full_log_cross_analysis.md`)
