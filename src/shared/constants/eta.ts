// 도보 평균 속도(m/s). 공공데이터포털 환승 소요시간(15044419)이 사용하는 1.2 m/s와 동일 기준.
// calculateStaticETA의 출발/도착 walking 시간 합산에 사용.
export const WALKING_SPEED_M_PER_S = 1.2;

// arrival API freshness TTL(ms). 60s 이상 지난 도착 정보는 stale로 간주하고
// DEFAULT_WAIT_MINUTES fallback을 사용한다. silentPushTask의 POSITION_TRAIN_TTL_MS와 정렬 — Strategy
// ①(LivePosition) 신선도와 같은 임계를 사용해 사용자에 노출되는 ETA 채택 경계가 자연스럽게 흐른다.
export const ARRIVAL_FRESHNESS_MS = 60_000;

// #2179 — "전열차"(usePrevTrainCandidate) 후보 캐시 TTL(ms). 탑승한 열차가 다음 역마저 통과하면
// 도착정보 API 응답(현재역/다음역 모두)에서 완전히 사라져 후보 pool이 0으로 떨어진다. 이 캐시는
// 직전에 산출됐던 전열차 후보를 이 시간 동안 보존해 "탑승 직후 바로 못 눌렀다가 뒤늦게 누르는" 사용자
// 시나리오를 지원한다. 서울지하철 역간 평균 소요시간(약 2~3분)의 배수로, 최소 1~2개 역을 더 지나쳐도
// 유효하되 무한정 낡은 열차를 노출하지 않도록 5분으로 고정.
export const PREV_TRAIN_CANDIDATE_TTL_MS = 5 * 60_000;
