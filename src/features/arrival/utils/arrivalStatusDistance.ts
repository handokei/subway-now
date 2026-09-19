/**
 * Seoul 열린데이터 API `arvlMsg2`(=`ArrivalInfo.statusMessage`)에서 BoardingTrainList에 노출할
 * 거리 표기를 추출한다.
 *
 * 입력 예 → 출력:
 *   "[4]번째 전역 (문정)"  → "4번째 전"   (괄호 패턴 매칭)
 *   "[1]번째 전역 (홍대입구)" → "1번째 전"
 *   "전역 출발"           → "전역 출발"  (매칭 안 됨, 원본 유지)
 *   "당역 도착"           → "당역 도착"
 *   ""                  → ""         (정보 없음, 호출자가 fallback 결정)
 *
 * #790 회귀 — 기존 코드는 배열 인덱스 +1을 "N번째 전"으로 표시했고 사용자는 이를 실제 역 거리로
 * 해석했다. 진짜 거리는 API 응답에 위 패턴으로 들어 있어 이 함수로 정규화한다.
 *
 * 정책: `[0]번째 전역`도 통과시켜 "0번째 전"으로 표기. Seoul API 명세상 0은 발생하지 않는다고
 * 보지만, 만약 향후 "당역 도착" 대체로 들어오기 시작하면 UX 재검토 필요.
 */
const BRACKET_DISTANCE_RE = /\[(\d+)\]번째 전역/;

export function parseArrivalDistance(statusMessage: string): string {
  const match = BRACKET_DISTANCE_RE.exec(statusMessage);
  if (match) return `${match[1]}번째 전`;
  return statusMessage;
}
