/**
 * Phase 3 fusion·시각화에서 동시에 처리하는 활성 호선/후보 역의 최대 개수.
 * Rules of Hooks 제약으로 useArrivalInfo / useTrainPositions 호출을 동적 개수로 풀 수 없어
 * 슬롯이 고정된다. 한 곳에서만 변경하도록 단일 출처로 관리.
 */
export const MAX_ACTIVE_LINES = 3;

// #445 positionTrainResult sticky gate.
// 인접역 평균 800m+ 대비 보수치. positionTrain이 잡은 역과 user GPS가 이보다 멀면
// 사용자가 그 역에 가까이 있지 않다고 판단해 fusion을 다음 우선순위로 강등한다.
export const MAX_POSITION_TRAIN_DISTANCE_KM = 0.6;
// positionTrain 역과 GPS-nearest 역 거리 차이 margin. GPS 노이즈 흡수용.
// `positionTrainDist > gpsNearestDist + DELTA`이면 GPS-nearest 쪽이 더 신뢰 가능.
export const MAX_POSITION_TRAIN_DELTA_KM = 0.2;
// trainProgress 신선도. 7호선 역간 평균 100~120s의 절반.
// 이 시간 이상 갱신 없으면 sticky 락(lastConfirmedTrainNo) 자체를 해제한다.
export const POSITION_TRAIN_TTL_MS = 60_000;
