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
// backend는 cycle(~30s)마다 advance를 보내므로 2 cycle + 여유 margin.
export const BACKEND_SSOT_MIRROR_MAX_AGE_MS = 60_000;
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
