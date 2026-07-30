// 경로 밖 1.5km 이상 떨어진 GPS는 off-route로 간주해 진행도 보정에 사용하지 않는다.
// MAX_ACCURACY_M_DISPLAY와는 별개 개념(이쪽은 사영 perpendicular 거리, 저쪽은 단일 fix accuracy).
export const MAX_PERP_M = 1500;

// 지하철 운행 가능 최대 속도 + 여유. 200 km/h = 55.6 m/s.
// 마지막 채택 관측 기준 implied speed가 이 값 초과면 GPS 점프로 판정해 그 관측을 거부한다.
export const MAX_PLAUSIBLE_MPS = 55;

// accuracyToWeight 시그모이드 스케일. acc=값 m에서 가중치 0.5.
// 작게 잡을수록 GPS 신뢰가 빨리 떨어진다.
export const ACCURACY_WEIGHT_SCALE_M = 300;

// expo-location이 accuracy를 못 준 경우 대체 가중치(보수적).
export const DEFAULT_ACCURACY_WEIGHT = 0.3;

// 두 인접 역 사이 직선거리가 이 값을 넘으면 경로(arc) 자체를 invalid 처리.
// 노선 정렬 데이터 오류(stationRoute의 id-string 정렬이 1D 인접성을 깨는 케이스)
// defense-in-depth 가드. 실제 수도권 역간 최대 거리는 수인분당선 달월→사리 ~14km 정도이므로
// 그 이상(예: 데이터 손상으로 다른 도시 좌표가 섞이는 경우)만 거른다.
export const MAX_INTER_STATION_M = 20_000;

// #2093 (item C) — arc 시간적분(dead-reckoning) 오버슛 gate 배수.
// lesson_arc_time_integration_overshoot: 지하 등 무신호 구간에서 정지 상태여도 시간 적분(speed × dt)만
// 계속 누적되어 실제 hop 거리를 훨씬 초과(evidence: 3,981→4,877m, 걷는 중)하는 회귀.
// 마지막 신뢰 관측(lastTrustedProgressM) 대비 예측치가 "현재 hop 거리 × 이 배수"를 넘으면 무효화하고
// trusted anchor로 되돌려 재적분한다.
export const ARC_OVERSHOOT_HOP_MULTIPLIER = 2;

// #2093 (item D) — route-progress 원점 stuck 해소용 re-seed 조건.
// estimator가 장기 무신호(마지막 신뢰 관측 이후 이 시간 이상 경과) 후 재기동될 때, GPS가 이 정확도보다
// 정밀하고(accuracy < 값) 경로 위에서 합의(perp ≤ MAX_PERP_M)되면 dead-reckoning/jump-reject를 우회해
// 그 지점으로 즉시 re-seed한다. 저품질(지하) 좌표로는 re-seed하지 않기 위한 정확도 게이트
// (feedback_no_gps_for_decision 원칙 — GPS는 지상 고품질 fix일 때만 결정 권한).
export const ROUTE_PROGRESS_RESEED_STALE_MS = 60_000;
export const ROUTE_PROGRESS_RESEED_ACCURACY_M = 100;
