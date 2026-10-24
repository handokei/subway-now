import type { StationArrival } from '../../../shared/types/arrival';

/**
 * 홈 ETA 입력 — 양 방향 첫 행(API 순서) 중 가장 빠른 열차까지 남은 분. 모르면 Infinity.
 *
 * #3132 — 첫 행이 시간 모름(arrivalSeconds=null, 코레일 barvlDt=0)이면 그 방향은 Infinity.
 * 서울교통공사 동작을 바꾸지 않으려고 `trains[0]` 규칙을 유지한다(후속 실값 행을 뒤져 찾지 않음).
 * 둘 다 Infinity면 호출부가 etaMinutes=null("ETA 없음")로 처리한다 — 예전 0분("지금 도착") 오표기 제거.
 */
export function pickNextTrainMinutes(arrival: StationArrival): number {
  const minutes = [arrival.up, arrival.down].map((trains) => {
    const [first] = trains;
    return first?.arrivalSeconds != null ? Math.floor(first.arrivalSeconds / 60) : Infinity;
  });
  return Math.min(...minutes);
}
