// 경로 밖 1.5km 이상 떨어진 GPS는 off-route로 간주해 진행도 보정에 사용하지 않는다.
// 표시용 accuracy 게이트(MAX_ACCURACY_M_DISPLAY)와 동일. 큰 변경 시 location.ts와 함께 조정.
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
