/**
 * Phase 3 fusion·시각화에서 동시에 처리하는 활성 호선/후보 역의 최대 개수.
 * Rules of Hooks 제약으로 useArrivalInfo / useTrainPositions 호출을 동적 개수로 풀 수 없어
 * 슬롯이 고정된다. 한 곳에서만 변경하도록 단일 출처로 관리.
 */
export const MAX_ACTIVE_LINES = 3;

// #444/#445 fusion 거리 게이트 — non-gps source(positionTrain/fused/route) 공통 적용.
// 인접역 평균 800m+ 대비 보수치. fusion이 잡은 역과 user GPS가 이보다 멀면
// 사용자가 그 역에 가까이 있지 않다고 판단해 다음 우선순위로 강등한다.
export const MAX_FUSION_DISTANCE_KM = 0.6;
// fusion 역과 GPS-nearest 역 거리 차이 margin. GPS 노이즈 흡수용.
// `fusionDist > gpsNearestDist + DELTA`이면 GPS-nearest 쪽이 더 신뢰 가능.
export const MAX_FUSION_DELTA_KM = 0.2;
// #445 positionTrain trainProgress 신선도. 7호선 역간 평균 100~120s의 절반.
// 이 시간 이상 갱신 없으면 sticky 락(lastConfirmedTrainNo) 자체를 해제한다.
export const POSITION_TRAIN_TTL_MS = 60_000;
// #1568 (T8b, Epic ADR-017 #1553) — backend SSoT mirror staleness 게이트.
// silent push payload.ssot.lastAdvanceAt 기준 본 ms 초과 시 cascade 채택 거부.
//
// #1573 (T10) — 60s → 180s 상향.
// 60s는 backend cycle(~30s) 2 cycle만 허용해 한 cycle 손실(BG silent push 지연/dropped)에
// cascade가 즉시 GPS-only로 떨어졌다. 12:32:14 trip evidence: 60s 만료 → fallback
// `position-train` → stale GPS(acc=4200m) → 용마산 false fire. 180s로 늘려 6 cycle margin을
// 확보하고, 그 이후의 staleness는 단계적으로 알람/알림을 차단한다(아래 두 상수).
export const BACKEND_SSOT_MIRROR_MAX_AGE_MS = 180_000;

/**
 * #1573 (T10) — Trip lifecycle 단계적 backstop 임계.
 *
 * trip이 명시 종료(도착 / 사용자 종료 / backend trip-ended) 없이 본 시간 이상 잔존하면
 * `feedback_6h_backstop_staged_handling` 룰에 따라 단계 처리:
 *  - 6h (silence): alarm/notification 차단만 (UI는 trip 유지). KTX/장거리 trip noise 방지.
 *  - 9h (force-end): 강제 종료 (runTripBoundCleanups + tripEndedSentinel). lockless 9h+ 잔존 #1346 차단.
 *
 * 즉시 강제 종료는 KTX 장거리 사용자에게 false positive — 단계 처리로 사용자 가치 보호.
 * 12h opt-in extend 토글은 후속 sub-task에서 별도 상수와 함께 도입(현 PR 범위 외).
 *
 * stale 5분+ 알람 차단 / 30분+ 알림 차단 임계는 T9 (#1572) / T12에서 wire될 때 함께 도입한다
 * — 본 PR에 orphan 상수로 남기지 않는다 (Wire-completion 5단 룰).
 */
export const TRIP_LIFECYCLE_SILENCE_MS = 6 * 60 * 60_000;
export const TRIP_LIFECYCLE_FORCE_END_MS = 9 * 60 * 60_000;
// #1016 hole (c): BoardingLock 활성 시 positionTrain 후보가 유효한 arc 구간 window.
// 탑승역 인덱스 + LOCK_NEXT_HOP_WINDOW 범위 내 역만 허용. 지하 dead zone에서 훨씬 앞의
// 역을 채택하는 false positive를 차단한다. 인접역 간 평균 주행 시간(90s) × TTL(60s) 기준으로
// 한 사이클에 1~2 hop이 최대 — 여유 margin 포함 3 hops.
export const LOCK_NEXT_HOP_WINDOW = 3;

/**
 * #1398 — WiFi SSID 매칭 결과 거리 게이트.
 *
 * SPOF 분리(barometer subsurface 의존 제거) 후 false positive 방어 두 번째 layer.
 * WiFi 매칭이 GPS 좌표와 이 거리 이상 떨어지면 거부한다 — 지상에서 카페/지하상가 WiFi가
 * 인접 역 WiFi로 매칭되는 사고 차단.
 *
 * 인접 역 평균 800m + 환승 통로 길이 + GPS 정확도 ~150m 여유 → 1.5km. fusion 본 거리 게이트
 * (MAX_FUSION_DISTANCE_KM 0.6)보다 넉넉 — WiFi는 SSID 매칭 자체가 강한 신호(정규식 + 지하철
 * SSID 패턴)라 거리만으로 거부할 때는 명백한 mismatch만 차단한다.
 *
 * GPS userLocation 자체가 없는 케이스(지하 GPS dead zone)는 거리 검증을 자동 면제 — WiFi가
 * 유일한 신호이므로 통과시킨다.
 */
export const WIFI_SSID_MAX_DISTANCE_KM = 1.5;

/**
 * #1513 (ADR-015 §3) — 다중 신호 합의 verdict가 fused candidate를 채택할 때의 근접 게이트.
 *
 * 본 게이트는 `fusedPasses`(`MAX_FUSION_DISTANCE_KM=0.6km`)가 GPS 부정확으로 거부한 fused 후보를
 * verdict 합의(≥2 신호: barometer-stop / motion-stationary / arvlcd-arrived)가 있을 때 복구하기
 * 위한 cascade slot — positionTrain > arrival-confirmed(fused passes) > **multi-signal verdict** >
 * routeProgress > GPS 순서의 4번째 우선순위.
 *
 * false positive 방어:
 *   1. ≥2 신호 합의 — 단일 신호 오발 차단 (이미 fuseStationDetectionSignals AGREEMENT_THRESHOLD).
 *   2. 거리 500m — 인접역 평균 800m의 절반 미만으로 "현재역" 의미 보존. fused 후보가 user GPS와
 *      이보다 멀면 verdict가 detected여도 다른 역의 정차 신호일 가능성 (ADR-010 두 실패 모드 동급).
 *   3. GPS userLocation 자체가 없는 완전 dead 케이스는 candidates=[]가 되어 fused=null →
 *      본 슬롯 자연 비활성. station identity는 wifi/positionTrain/lock cascade가 담당.
 *
 * 2026-06-19 trip 실측 evidence (issue #1513): 어린이대공원역 station-passed fire 0건. 지하 GPS
 * drop(acc 1400~2593m) 구간에서 fusedPasses=false → cascade가 routeResult/gps fallback으로 떨어져
 * verdict가 dormant. 본 게이트가 cascade에 결합. accuracy가 나빠도 좌표 자체는 보고되므로
 * fused 후보는 산출된다(거리만 fusedPasses 임계 0.6km를 넘김).
 */
export const DETECTION_FUSED_MAX_DISTANCE_KM = 0.5;

/**
 * #1657 — GPS-derived advance fast-path (지상 lock 활성).
 *
 * GPS 신선도 게이트:
 *   - accuracy ≤ GPS_DERIVED_ACCURACY_MAX_M: 지상 open-sky GPS fix. 50m는 기존
 *     passesFusionDistanceGate strict 기준(50m)과 동일 — 불일관 차단.
 *   - fix age ≤ GPS_DERIVED_FIX_MAX_AGE_MS: 30s 초과는 GPS가 stale해 cascade advance의
 *     SSOT로 쓸 수 없다.
 *
 * 노선 정합 게이트:
 *   - candidates[0].distanceKm ≤ GPS_DERIVED_ROUTE_MATCH_MAX_KM(100m): GPS 좌표가
 *     boardingLine 위 역 100m 이내 — 옆 노선 station drift 차단.
 */
export const GPS_DERIVED_ACCURACY_MAX_M = 50;
export const GPS_DERIVED_FIX_MAX_AGE_MS = 30_000;
export const GPS_DERIVED_ROUTE_MATCH_MAX_KM = 0.1;

/**
 * #1668 — arvlCd=1(ARRIVED) + lock.trainCode 매칭 즉시 SSoT 채택 신선도 게이트.
 *
 * Seoul realtimeStationArrival API의 ARRIVED 신호는 열차 정차 구간(~30s)에서만 발생.
 * receivedAtMs 기준 본 ms 초과 시 stale로 간주해 cascade 채택 거부.
 * Seoul API 폴링 주기(30s) + 처리 latency (~5s) 여유 → 35s.
 * stale 신호를 채택하면 이전 정차 역을 현재역으로 오인하는 false positive 위험.
 */
export const ARVL_CD_ARRIVED_MAX_AGE_MS = 35_000;

/**
 * #1723 — GPS fallback stale 게이트.
 *
 * 사용자 6/23 evidence: 13:56 trip 종료 후 새로고침 시 을지로3가 stuck (실제 위치 다름, stale GPS
 * lastFix 6분 전). useFusedNearestStation cascade의 최종 fallback인 `gps.liveResult`가 GPS lastFix
 * 6분 전 좌표를 들고 있어 현재역으로 표시. 5분+ stale은 사용자가 BG 동안 이동했거나 지하 dead zone
 * 진입한 가능성이 높아 사용자 실제 위치와 무관.
 *
 * 5분 임계의 근거:
 *   - 일반 도시 trip 평균 한 정차 ~1-2분 → 5분이면 3+ stop 통과 가능 (정확도 게이트로 부적합).
 *   - iOS BG 위치 보고가 정상이면 lastFixAtMs는 3-5분 안에 갱신 (silent push wake / FG 복귀).
 *   - 60s/30s 임계는 cascade의 다른 tier(positionTrain / GPS-derived / ARRIVED)가 이미 처리 —
 *     본 게이트는 모든 device tier 실패 후 최종 fallback에만 적용해 false null 위험 최소화.
 *
 * 채택 시 동작: 5분+ stale GPS는 cascade 최종 fallback에서 채택 거부 → result=null 노출. 호출자는
 * "위치 확인 중" UX(useNearestStation.locationUncertain와 동일 의미)로 표시.
 *
 * lockless / lock 활성 모두 동일 게이트 — backend SSoT / wifi / positionTrain 등 다른 tier가
 * 살아있으면 자연 채택되므로 본 게이트 미진입.
 */
export const GPS_FALLBACK_STALE_MAX_AGE_MS = 5 * 60_000;

/**
 * #1747 — cascade picker stuck: 같은 station이 이 시간을 초과해 연속 채택되면
 * boardingLock 없을 때 강제 invalidate, boardingLock 활성 시 lock.boardingStation 우선.
 *
 * 종합운동장 8분 stuck evidence (2026-06-24 PM trip) 기반. 5분이면 3+ stop 통과 가능 —
 * 실제 이동 중에도 cascade가 고착되는 문제를 차단한다.
 */
export const PICKER_STUCK_MAX_AGE_MS = 5 * 60_000;

/**
 * #1748 — candidate-reject 연속 카운트 임계.
 * 같은 노선에서 이 횟수 이상 연속 reject 시 anchor 탐색 window를 2배(±3 → ±6)로 확장한다.
 * 종합운동장 stuck 8분: fusion log 200줄 중 150줄이 reject — 5+ cycle 확장 트리거 적합.
 */
export const CANDIDATE_REJECT_ANCHOR_EXPAND_THRESHOLD = 5;
export const CANDIDATE_ANCHOR_WINDOW_DEFAULT = 3;
export const CANDIDATE_ANCHOR_WINDOW_EXPANDED = 6;

/**
 * #1749 — station hop > 5 detect: 1 cycle 안에 이 hop 이상 점프 시 anomaly로 간주해
 * silent skip (이전 result 유지). 정상 환승 hop (최대 2~3)은 통과한다.
 *
 * 종합운동장 → 역삼 10 station skip evidence (2026-06-24 14:02:00).
 * 같은 노선이어야 hop 계산 대상 — 다른 노선 전환(환승)은 skip 계산 X.
 */
export const PICKER_HOP_ANOMALY_THRESHOLD = 5;

/**
 * #1896 (RC-8) — boarding-lock GPS displacement gate.
 *
 * `positionTrainBoardingLockMatch` 또는 `arvlCdArrivedMatch` 분기에서 lock 활성 + lockMatch라도
 * GPS와 lock 결과 station의 거리가 이 임계를 초과하면 lock 1순위 승격을 포기하고
 * cascade fallback(backendSsotAccepts → wifi → positionTrain …)으로 넘긴다.
 *
 * 1000m 임계의 근거:
 *   - Evidence: T2 trip 12:19 GPS=신당(979m), lock=동대문역사문화공원(78m) → 약 900m 이상 차이.
 *   - 인접역 평균 거리 800m. 1km 초과 시 lock과 실제 GPS 위치가 서로 다른 역 권역임이 명백.
 *   - 지하 GPS 정확도 불확실성(~300m)을 반영해 500m(issue 본문 초안)보다 여유 있는 1km.
 *   - "GPS 결정 권한 X" 룰: 본 gate는 lock 무효화 판단만 — station 선택은 cascade에 위임.
 *
 * 지하/지상 동일 임계:
 *   - 지하 GPS는 정확도가 낮으나 1km 이상 drift는 명백한 위치 불일치. 지상은 GPS 정확도 높아
 *     더 작은 임계도 가능하나 단일 상수로 단순화 — 지상은 gpsDerivedFastPath가 우선 처리.
 */
export const LOCK_GPS_DRIFT_THRESHOLD_M = 1000;

/**
 * #1896 (RC-8) — estimator stuck timeout.
 *
 * `estimateStationProgress`가 lock.boardedAt 기준 이 시간 이상 경과해도 탑승역(boardingIdx)에서
 * 벗어나지 못하면 stuck으로 간주하고 null을 반환한다. 호출자(useFusedNearestStation)가 다른
 * cascade tier로 fallback하도록 유도.
 *
 * 5분 임계:
 *   - 지하철 인접역 평균 hop time ~90s. 5분이면 3+ stop 통과 가능 — 이 이상 boarding station
 *     반복은 estimator dead zone 신호.
 *   - PICKER_STUCK_MAX_AGE_MS(5분)와 동일 기준으로 전역 일관성 유지.
 *   - tryLivePosition/ArrivalEta가 살아있으면 이 분기 미도달 — tryDefaultHop(dead zone)에서만 적용.
 */
export const ESTIMATOR_STUCK_TIMEOUT_MS = 5 * 60_000;

/**
 * #1922 (M2) — lockless route-hop / re-anchored time-integration "stuck" 가드.
 *
 * `tryLocklessRouteHop`은 실측 신호(lastObserved) 없이 `tripStartedAt`만으로 시간 적분을 진행한다.
 * 환승 leg 진입 직후 estimator가 시간 적분으로 fall-through되면 candidate idx가 더 진행해도
 * `effectiveHopIndex`가 stuck하여 station-passed gate(`isStationWithinHopWindow`)가 매역 reject
 * 한다 (#1922 dump line 169~244: 61회 suppress evidence).
 *
 * 본 임계 이상 실측 신호 부재가 지속되면 시간 적분 자체를 null 반환 → useFusedNearestStation
 * cascade가 fusion fallback(실측 idx)을 forward하도록 유도. estimator stale 값이 silent하게
 * forward되는 회귀를 차단한다.
 *
 * 90s 임계 (인접역 평균 hop time ~90s):
 *   - 한 hop 통과 시간 동안 실측 신호(SSoT mirror / lastObserved / arrivalCode arrived) 없으면
 *     "estimator가 stuck하기에 충분히 stale"이라 판단.
 *   - 90s 초과 시 시간 적분 자체를 null 반환 → 다음 tier가 결정 권한 회수.
 *   - lastObserved.observedAtMs가 부재하면 tripStartedAt 기준 90s 경과 시 null (lockless trip 초기
 *     "아직 첫 실측 신호 전" 구간만 시간 적분 허용).
 *   - reanchored-hop / default-hop은 lock 기반이므로 본 게이트는 lockless 전략에만 적용.
 */
export const LOCKLESS_TIME_INTEGRATION_STUCK_TIMEOUT_MS = 90_000;
