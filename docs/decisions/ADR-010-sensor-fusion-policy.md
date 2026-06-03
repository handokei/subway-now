# ADR-010: Sensor Fusion Policy & D-direction Boarding Prompt

## 상태

Accepted (2026-06-03)

관련 이슈: #816 (D 방향 epic), #817 (Phase 2 map matching), #819 (B 슬라이스 — 탑승 푸시)
관련 PR (머지): #820/#816(C 슬라이스), #821/#817(Phase 2), #822/#819(B 슬라이스)
참조 ADR: ADR-006 (silent push telemetry), ADR-008 (boarding progress estimator), ADR-009 (Phase 3 fusion 기술 SSOT)
참조 메모: `project_item6_d_direction_design` (본 ADR이 SSOT 통합 대상)

## 배경 — 알림 정확도는 브랜드 신뢰

본 앱의 핵심 가치는 **"지하철 안에서 정확한 시점에 정확한 역 알림"**이다. 잘못된 시점에 울리면(false positive) 사용자는 즉시 신뢰를 잃고, 울려야 할 때 안 울리면(miss) 다음 사용을 안 한다. 두 실패 모드는 비대칭이 아니라 동급 — 어느 한쪽으로의 단순 보수화가 답이 아니다.

GPS-only로는 정확도 마지노선이 두 가지 면에서 깨졌다:

1. **iOS `client.speed = -1` 회귀(#812)** — cold start / dead zone 직후 raw speed 신호 무효화. 이게 D 방향 설계의 직접적 출발점.
2. **lock 없는 trip의 사각지대** — BoardingLock이 있어야 동작하는 station-passed 알림이 *사용자가 미처 탭하지 못한 일상 시나리오*에서 0건 발사. 노이즈를 견딘다는 정책(이전 ADR-006/008)이 미스로 직접 이어진다.

이 두 사각지대를 "어떻게 더 보수화하나"가 아니라 **"어떻게 신호를 한 축 더 추가해 직교 결합하나"**로 푼다. 본 ADR이 그 정책/UX 흐름의 SSOT이며, 통계적 기법(Kalman/가속도 처리)은 ADR-009에 위임한다.

## 결정 — D 방향 = B + C 동시 도입

2026-06-03 사용자 결정: B(자동 prompt)와 C(opt-in lockless) 둘을 동시에 도입한다. 단일 대안은 트레이드오프가 비대칭이라 모두 거부 — "Alternatives Considered" 참조.

### B 흐름 — "탑승했냐?" 푸시 + 자동 lock 생성

| 단계 | 동작 | 위치 |
|---|---|---|
| 1 | backend cron이 GPS series · 가속도 · Kalman 평가 (60s 주기) | `backend/alarm-worker/src/scheduled.ts` |
| 2 | 9단 AND 게이트 통과 시 BOARDING_PROMPT alert push 발사 | `backend/alarm-worker/src/boardingPrompt.ts` `evaluateBoardingPromptGates` |
| 3 | 사용자가 [탑승] 탭 | iOS `UNNotificationCategory` |
| 4 | 클라이언트가 arvlCd 우선순위로 trainCode 자동 선택 → `BoardingLock` 생성 → ADR-008 estimator SLA로 진입 | `backend/alarm-worker/src/apns.ts` `sendBoardingPromptPush` + 클라 응답 핸들러 |

핵심 — 사용자에게 **"몇 호선 탔어?"가 아니라 "탔어?" 하나만 묻는다.** trainCode 선택은 arvlCd 신호로 백엔드가 결정.

### C 흐름 — Lockless station-passed (opt-in 토글)

| 결정 | 값 | 근거 |
|---|---|---|
| 기본 상태 | OFF | #640 회귀(잘못된 알림) 차단 — 사용자 동의 영역 |
| 활성 조건 | `locklessStationPassed=true` AND trip route 존재 | trip route 없으면 zero — zero trip = zero push |
| 저장소 | AsyncStorage `LOCKLESS_STATION_PASSED_KEY` | `src/constants/storageKeys.ts:58` |
| 백엔드 동기화 | trip register payload에 `locklessStationPassed` 필드 | `backend/alarm-worker/src/types.ts` `Trip.locklessStationPassed` |
| 발사 게이트 | scheduled.ts lockless 분기 | `backend/alarm-worker/src/scheduled.ts` |

### False positive 9단 AND 게이트 (B 흐름의 핵심)

ADR-006 silent push와 달리 본 게이트는 **사용자에게 직접 visible alert**를 띄운다 → false positive 비용이 silent보다 한 자릿수 크다. 따라서 **AND 결합 + 각 게이트 단독 차단 가능**으로 설계.

| # | 게이트 | 임계값 / 조건 | 위치 / 상수 |
|---|---|---|---|
| 1 | trip 활성 | caller가 `listTrips`로 보장 | `scheduled.ts` 호출자 |
| 2 | BoardingLock 없음 | caller가 lockMissing trip 분기에서만 호출 | `scheduled.ts` 호출자 |
| 3 | 평균 GPS accuracy < 50m | `ACCURACY_CUTOFF_M` (`positionSeries.ts`) | `boardingPrompt.ts:124-127` |
| 4 | 출발역 100m 이내 (마지막 sample haversine) | `ORIGIN_RADIUS_KM = 0.1` | `boardingPrompt.ts:34, 130-138` |
| 5 | 방향 cosine ≥ 0.7 (출발역→다음역 vector vs 이동 vector) | `DIRECTION_COSINE_THRESHOLD = 0.7` | `boardingPrompt.ts:36, 140-153` |
| 6 | 60s 윈도우 sample N ≥ 3 | `MIN_WINDOW_SAMPLES = 3` | `boardingPrompt.ts:38, 111-117` |
| 7 | fused speed ≥ 5 km/h AND `confidence ≠ 'low'` | `MIN_FUSED_SPEED_KMH = 5` | `boardingPrompt.ts:40, 160-172` |
| 8 | motion ∈ {walking, automotive} | CMMotionActivity | `boardingPrompt.ts:155-158` |
| 9 | trip당 1회 + dismiss 5분 silence | `DISMISS_SILENCE_MS = 5min` | `boardingPrompt.ts:42, 98-109` |

게이트 #1/#2는 호출자(`scheduled.ts`)가 보장 — `evaluateBoardingPromptGates`는 #3~#9만 평가. 한 게이트라도 실패 시 즉시 `GateSkipReason`과 함께 차단(short-circuit).

### arvlCd 우선순위 — 사용자에게 trainCode 선택 부담 0

[탑승] 응답 시 BoardingLock이 가리킬 trainCode를 Seoul API `arvlCd`로 자동 결정. `boardingPrompt.ts:209-234` `pickAutoTrainCode`.

| 순위 | arvlCd | 의미 | 직관 |
|---|---|---|---|
| 1 | `2` 출발 | 사용자가 방금 그 차를 타고 출발 | 가장 강한 신호 |
| 2 | `1` ARRIVED | 막 탑승 | 도착 직후 |
| 3 | `0` ENTERING | 다음 차 대기 | 진입 중 |
| 4 | 그 외 | receivedAt 가까운 + 방향 매칭 first | fallback |

같은 우선순위 후보가 둘 이상이면 (ambiguity) → `null` 반환 → 자동 안 함 → 클라 manual fallback. **모호하면 추측보다 사용자 선택을 신뢰**.

### Sensor Fusion Phase 1~4

D 방향이 동작하려면 fused speed가 신뢰성 있게 산출돼야 한다. Phase별 신호를 직교로 추가해 정확도를 끌어올린다. 각 Phase는 fusion 가중치 0(미적용)으로 자연 무시 가능 → 회귀 없이 점진 도입.

| Phase | 추가 신호 | 정확도 효과 | 비용 | 도입 시점 | 해소 회귀 | 위치 |
|---|---|---|---|---|---|---|
| 1 | 좌표 series 60s 평균 + motion clamp | client.speed `-1` 대체 | KV PUT 60s | #819 (머지 #822) | #812 cold start | `fusedSpeed.ts` `gpsAvgKmh + motion` |
| 2 | 노선 polyline map matching `mapMatchedKmh` | 환승역 disambiguate + segment 누적 정확 | snap 계산 in-mem | #817 (머지 #821) | #662/#796/#798 | `linePolyline.ts` + `withMapMatched` (`positionUpload.ts:116`) |
| 3 | Kalman smoothed velocity (가속도 driven Q) | dead zone 1~2역 drift 회복 + 운행 phase 분류 | backend cron in-mem | Epic #818 (E1~E5 머지) | dead zone drift / phase 오판 | ADR-009 SSOT (`kalmanFilter.ts`, `accelSeries.ts`, `stationPhase.ts`) |
| 4 | Particle filter | multi-hypothesis (분기 환승) | CPU 100ms급 | 보류 — Phase 3 정확도 부족 측정 후 | (미정) | (미정) |

**가중치 (Phase 1+2+3 모두 합산 시 `fusedSpeed.ts:53-83`)**:
- GPS: accuracy <20m→0.7, <50m→0.5, <100m→0.2, 그 외 0
- Map matching: 0.5 (`mapMatchedKmh != null`)
- Kalman: `KALMAN_WEIGHT = 0.6` (`fusedSpeed.ts:16`)
- 가중치 합 ≥1.0=high, ≥0.5=medium, <0.5=low (low면 게이트 #7 차단)

Phase 2 snap 가드: `MAX_SNAP_DISTANCE_M = 50` (`linePolyline.ts:31`) — 도로/실내 GPS 거부.

### 환승역 자동화 — A/B/C/D 옵션 표

B 흐름이 안정화되면 환승 시 next-leg에도 같은 prompt를 자동 띄울지 고민. 현재는 미도입 — false positive 카운터 + 탭률 측정 후 결정.

| 옵션 | 동작 | 장점 | 단점 |
|---|---|---|---|
| A | 환승역 hop에서 자동 prompt (이전 leg lock 자동 해제 + B 게이트 재평가) | 사용자 부담 0 | 환승 hop 자체가 false positive 풍부(도보/대기) |
| B | 환승역 phase 검출 시 [환승 완료?] alert만 표시 | A보다 보수 | UX 노이즈 |
| C | 사용자가 next leg를 미리 trip route에 등록만 — prompt 없음 | false positive 0 | 사용자 사전 입력 필요 |
| D | 안 함 — 환승 leg는 기존 lockless(C 흐름) 토글로 커버 | 추가 코드 0 | route 없으면 zero |

**권장**: A+C 하이브리드 — route 등록된 leg는 C, 미등록 hop만 A 게이트. **단, 측정 우선**: 현재 B 흐름의 false positive율 + 탭률 데이터 축적 후 도입.

## 트레이드오프

| 장점 | 단점 |
|---|---|
| lock 없는 trip 사각지대 해소(C) + 사용자 동의 영역(opt-in)으로 회귀 차단 | 토글이 OFF면 lock 없는 trip은 여전히 침묵 — 사용자 발견 비용 |
| 9단 AND로 false positive 비용 차단 | 게이트 9개 모두 통과 필요 → miss 증가 가능 → 측정 후 임계 튜닝 필요 |
| arvlCd 자동 trainCode로 사용자 한 번만 탭 | ambiguity 시 manual fallback — 일부 시나리오 UX 분기 |
| Phase 1~3 직교 결합으로 dead zone / 환승 / phase 모두 한 cron cycle에 평가 | Phase 추가마다 가중치 SSOT 유지 부담 (ADR-009 + 본 ADR cross-ref) |

## Alternatives Considered

| 대안 | 거부 이유 |
|---|---|
| A 단독(자동 prompt만) | lock 없는 trip이 게이트 미통과 시 침묵 → miss. 또 자동 push 의존도 100%면 false positive 한 번에 신뢰 붕괴 |
| C 단독(opt-in 토글만) | 사용자가 매번 토글 켜야 함 — 부담 + 토글 OFF 사용자는 사각지대 그대로 |
| D 안 함(현 상태 유지) | iOS `client.speed=-1` 회귀(#812) 그대로 두면 모든 cold start trip이 miss |
| B+C **채택** | B는 자동 진입로, C는 사용자 명시 opt-in. 두 진입로가 직교 — 한쪽 실패해도 다른쪽이 cover |

## Relation to other ADRs

| ADR | 본 ADR과의 경계 |
|---|---|
| ADR-006 (silent push telemetry) | false-positive 카운터, [탑승] 탭률은 ADR-006 인프라(KV stats)에 위임. 본 ADR은 게이트 정의만 |
| ADR-008 (boarding progress estimator) | 신호 우선순위 표 정렬 — 본 ADR-010은 lock 생성 이전 단계(prompt/게이트/arvlCd), ADR-008은 lock 생성 이후 hop 누적/현재역 추정 |
| ADR-009 (Phase 3 fusion 기술) | Kalman R/Q 표, 가속도 window summary, station phase 분류, drift hard reset은 ADR-009 SSOT. 본 ADR은 정책/UX 흐름만 |

## Follow-ups

1. **B false positive율 + [탑승] 탭률 측정** — ADR-006 silent push KV stats 패턴 차용. 7일 이상 축적 후 임계값 (cosine/speed) 재조정.
2. **A 옵션 환승 자동 prompt 도입 여부** — 위 측정 결과로 결정. false positive ≤ 5% AND 탭률 ≥ 70%면 A+C 권장.
3. **Phase 4 Particle filter** — Phase 3 dead zone drift 측정 후 정확도 부족 시만. 현시점 보류.
4. **`project_item6_d_direction_design` 메모 SSOT 통합** — 본 ADR이 SSOT 정착 후 메모는 "ADR-010 참조"로 슬림화.

## References

**코드 (worktree `dev` 기준)**:
- `backend/alarm-worker/src/boardingPrompt.ts` — 9단 게이트 + arvlCd 우선순위
- `backend/alarm-worker/src/fusedSpeed.ts` — Phase 1/2/3 가중 평균
- `backend/alarm-worker/src/scheduled.ts` — `runFusionStep` + arvlCd ground truth + best signal
- `backend/alarm-worker/src/seoul.ts` — `arvlCd` 파싱
- `backend/alarm-worker/src/apns.ts` — `sendBoardingPromptPush`
- `backend/alarm-worker/src/types.ts` `Trip.locklessStationPassed` — backend 토글 수신
- `src/store/useAppStore.ts` — `locklessStationPassed` 토글 setter/loader
- `src/constants/storageKeys.ts` — `LOCKLESS_STATION_PASSED_KEY`
- `src/hooks/useApnsTripRegistration.ts` — `locklessStationPassed` payload 전파
- `src/tasks/silentPushTask.ts` — 토글 ON + lock null 분기
- `src/utils/linePolyline.ts` — Phase 2 `MAX_SNAP_DISTANCE_M=50` 가드
- `src/api/positionUpload.ts` — `withMapMatched` wiring

**머지 PR**:
- #820 (C 슬라이스 — lockless 토글)
- #821 (Phase 2 — 노선 polyline map matching)
- #822 (B 슬라이스 — Phase 1 fusion + 9단 게이트 + arvlCd 자동 lock)

**메모**: `project_item6_d_direction_design`(SSOT 통합 대상), `project_phase3_fusion_queue`(Phase 3 큐), `project_2026_06_03_field_regression_queue`(항목 6 출처)
