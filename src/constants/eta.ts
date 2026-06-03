// 도보 평균 속도(m/s). 공공데이터포털 환승 소요시간(15044419)이 사용하는 1.2 m/s와 동일 기준.
// calculateStaticETA의 출발/도착 walking 시간 합산에 사용.
export const WALKING_SPEED_M_PER_S = 1.2;

// arrival API freshness TTL(ms). 60s 이상 지난 도착 정보는 stale로 간주하고
// DEFAULT_WAIT_MINUTES fallback을 사용한다. silentPushTask의 POSITION_TRAIN_TTL_MS와 정렬 — Strategy
// ①(LivePosition) 신선도와 같은 임계를 사용해 사용자에 노출되는 ETA 채택 경계가 자연스럽게 흐른다.
export const ARRIVAL_FRESHNESS_MS = 60_000;
