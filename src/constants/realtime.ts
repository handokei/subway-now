/**
 * Phase 3 fusion·시각화에서 동시에 처리하는 활성 호선/후보 역의 최대 개수.
 * Rules of Hooks 제약으로 useArrivalInfo / useTrainPositions 호출을 동적 개수로 풀 수 없어
 * 슬롯이 고정된다. 한 곳에서만 변경하도록 단일 출처로 관리.
 */
export const MAX_ACTIVE_LINES = 3;
