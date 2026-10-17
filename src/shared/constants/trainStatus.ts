/**
 * 서울 열린데이터 API `realtimePosition.trainSttus` 응답값.
 * 스펙: scripts/서울시+지하철+실시간+열차+위치정보.xls
 * 도착정보 API의 arvlCd와 의미는 비슷하지만 코드 체계가 더 단순(99 운행중 없음).
 */
export const TRAIN_STATUS = {
  ENTERING: 0, // 진입
  ARRIVED: 1, // 도착 — 사용자 = 해당 역에 있음 (확정)
  DEPARTED: 2, // 출발
  PREV_DEPARTED: 3, // 전역 출발
} as const;

/**
 * fusion 우선순위 (높을수록 강한 신호) — arrivalCodes.ts와 같은 형태.
 * trainSttus=1(도착)을 arvlCd=1과 동일 점수로 격상 — pickFusedStation에서 신호원 통합.
 */
const PRIORITY_BY_STATUS: Record<number, number> = {
  [TRAIN_STATUS.ARRIVED]: 100,
  [TRAIN_STATUS.ENTERING]: 80,
};

export function getTrainStatusPriority(status: number | undefined): number {
  return PRIORITY_BY_STATUS[status ?? -1] ?? 0;
}
