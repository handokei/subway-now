/**
 * 서울 열린데이터 API `realtimeStationArrival` arvlCd 응답값.
 * 스펙: scripts/서울시+지하철+실시간+도착정보.xls
 */
export const ARRIVAL_CODE = {
  ENTERING: 0, // 진입 — 사용자 ≈ 해당 역 (수 초 내)
  ARRIVED: 1, // 도착 — 사용자 = 해당 역에 있음 (확정)
  DEPARTED: 2, // 출발
  PREV_DEPARTED: 3, // 전역 출발
  PREV_ENTERING: 4, // 전역 진입
  PREV_ARRIVED: 5, // 전역 도착
  RUNNING: 99, // 운행중
} as const;

/**
 * fusion 판정 우선순위 (높을수록 강한 신호).
 * 1(도착) > 0(진입) > 5(전역도착) > 4(전역진입) > 그외 0.
 * 그외(2 출발, 3 전역출발, 99 운행중)는 "현재 위치" 신호로 부적합 → 0.
 */
const PRIORITY_BY_CODE: Record<number, number> = {
  [ARRIVAL_CODE.ARRIVED]: 100,
  [ARRIVAL_CODE.ENTERING]: 80,
  [ARRIVAL_CODE.PREV_ARRIVED]: 50,
  [ARRIVAL_CODE.PREV_ENTERING]: 40,
};

export function getArrivalPriority(code: number | undefined): number {
  return PRIORITY_BY_CODE[code ?? -1] ?? 0;
}
