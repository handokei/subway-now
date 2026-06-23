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
