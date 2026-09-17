// 도보 평균 속도(m/s). 공공데이터포털 환승 소요시간(15044419)이 사용하는 1.2 m/s와 동일 기준.
// calculateStaticETA의 출발/도착 walking 시간 합산에 사용.
export const WALKING_SPEED_M_PER_S = 1.2;

// arrival API freshness TTL(ms). 60s 이상 지난 도착 정보는 stale로 간주하고
// DEFAULT_WAIT_MINUTES fallback을 사용한다. silentPushTask의 POSITION_TRAIN_TTL_MS와 정렬 — Strategy
// ①(LivePosition) 신선도와 같은 임계를 사용해 사용자에 노출되는 ETA 채택 경계가 자연스럽게 흐른다.
export const ARRIVAL_FRESHNESS_MS = 60_000;

// #2689 — "전열차"(usePrevTrainCandidate) 후보의 안전 상한(backstop, ms). 1차 만료 기준은 더 이상
// 고정 시간이 아니라 "다음 열차의 출발"(currentArrivals에서 다음 trainCode가 사라지는 전이) 관측이다
// — 배차가 2분이든 15분이든 그 즉시 후보가 교체돼 자동으로 맞는다. 이 상수는 그 전이 관측 자체가
// 오래 끊긴 경우(앱이 장시간 백그라운드에 있다가 복귀하는 등)에만 개입하는 최후 backstop이다.
// `src/data/lineHeadways.json` 전체에서 실측 최댓값은 1320초(gyeongui, 토요일 심야, 22분) — 정상
// 배차 상황이라면 이 상한에 도달하기 훨씬 전에 다음 열차 출발 전이가 관측돼 후보가 갱신/무효화된다.
// 그 최댓값(22분)에 폴링 지연 버퍼를 더해 30분으로 잡아, 정상 최장 배차에서는 절대 조기 소멸시키지
// 않으면서도 전이 감지가 끊긴 극단 상황에서는 결국 낡은 후보를 내린다.
export const PREV_TRAIN_CANDIDATE_BACKSTOP_MS = 30 * 60_000;
