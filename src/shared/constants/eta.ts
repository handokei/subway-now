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

// #2699 (리뷰 지적, PR #2789 리뷰 3라운드 — 항목 2) — backend `scheduled.ts`의 폴링 윈도우
// 게이트(`trip.alarmAtEpochMs - now > POLLING_WINDOW_MS`)와 정합되는 값(초). #2699가 register
// dedup hash에서 시간종속 `alarmBucket`을 제거하면서, "ETA>5분에 첫 register → alarmAtEpochMs가
// 미래 5분+로 동결 → 이후 ETA가 실제로 줄어도(예: 8분→2분) 재등록 트리거가 없어(nextStationEtaSeconds
// 자체는 #703로 deps 제외) 폴링 게이트가 실제 ETA보다 늦게 열림" 회귀가 드러났다(리뷰 재지적) —
// 구 `alarmBucket`이 ≤60s마다 우연히 hash를 갈아치우던 부수효과에 암묵적으로 의존하고 있었다.
//
// 고친 값: `nextStationEtaSeconds`를 그대로 deps/hash에 넣지 않는다(30s GPS/arrival 폴링마다
// jitter — #703이 막으려던 churn이 그대로 재발한다). 대신 "ETA가 이 폴링 윈도우 **경계를
// 넘었는가**"라는 한 번만 바뀌는 거친 boolean(`useApnsTripRegistration`의
// `etaWithinPollingWindow`)만 deps/hash에 반영한다 — 초 단위 지터는 무시하고, 게이트가 실제로
// 열려야 할 시점과 정확히 같은 순간에만 재등록을 트리거한다.
export const ETA_POLLING_WINDOW_SEC = 5 * 60;
