/**
 * 도착 시각 anchor — Epic #896 Seam A (#897).
 *
 * BoardingTrainList(현재역 도착 list)와 ArrivalRow(EditorialArrivalRow가 useCountdown로 매초 재계산)
 * 사이의 표시 시각이 어긋나는 회귀가 있었다. 원인:
 *
 *   - useArrivalCountdown은 매초 `arrivalSeconds`만 1씩 차감한다 (receivedAtMs는 고정).
 *   - 호출처가 `receivedAtMs + arrivalSeconds * 1000`로 절대 도착 시각을 계산하면, tick마다
 *     시각이 1초씩 과거로 흐른다 → 30s 폴링 사이에 최대 30초 차.
 *   - useCountdown(arrivalAtMs)은 절대 시각을 받아 `Date.now()`와 비교하므로 fetch 시점에 한 번
 *     계산되어야 안정적이다.
 *
 * 해결: 도착 시각은 항상 "지금 시각 + 남은 초"로 계산한다. useArrivalCountdown이 tick으로 줄이는
 * `arrivalSeconds`와 자연스럽게 동기화되어 두 표시 위치가 같은 anchor를 갖는다.
 *
 * 호출처가 직접 `Date.now() + arrivalSeconds * 1000`을 쓰는 대신 이 함수를 거쳐 의미를 명시한다.
 */
export function arrivalAt(item: { arrivalSeconds: number }): number {
  return Date.now() + item.arrivalSeconds * 1000;
}
