/**
 * 사용자 노출 라벨 상수 모음.
 *
 * #855: BoardingTrainList가 statusMessage 빈 경우(mock/schedule fallback) 카운터를
 * "${index+1}번째 전"으로만 노출해, 사용자가 단위(역/분/m)를 인지하지 못함. fallback 의미를
 * 명확히 하기 위해 "약 N정거장 전" + 선택적 "(약 M분 후)" 결합 라벨을 사용한다.
 *
 * - 텍스트는 JSX 하드코딩 금지(글로벌 룰 3), 모든 사용자 노출 문구는 이 모듈을 거친다.
 * - 라벨은 sequence-row 단일 라인에 들어가므로 길이를 짧게 유지.
 * - BoardingTrainList 자체가 아직 i18n 미적용 컴포넌트라 일관성 위해 상수 분리만. i18n 전환은
 *   컴포넌트 단위 별도 작업에서 일괄 진행한다(범위 비대화 방지 — 글로벌 룰 4 surgical change).
 */

/**
 * BoardingTrainList sequence-row fallback 라벨.
 *
 * 입력:
 * - `index`: arrivals 배열의 0-based 인덱스 (ordinal 표기용; 배열 항목 접근 인덱스 아님)
 * - `arrivalSeconds`: 도착까지 남은 초. > 0이면 "약 M분 후" 보조 라벨을 결합.
 *
 * 출력 예:
 *   buildFallbackSequenceLabel(0, 180)   → "약 1정거장 전 (약 3분 후)"
 *   buildFallbackSequenceLabel(1, 600)   → "약 2정거장 전 (약 10분 후)"
 *   buildFallbackSequenceLabel(0)        → "약 1정거장 전"
 *   buildFallbackSequenceLabel(0, 0)     → "약 1정거장 전"           (≤ 0은 분 라벨 생략)
 *   buildFallbackSequenceLabel(0, 30)    → "약 1정거장 전 (약 1분 후)" (60초 미만은 1분으로 라운드)
 *
 * "약" 접두어: mock/schedule fallback은 추정치라 정확도 보장 안 됨을 시각적으로 전달.
 * Math.max(1, …)로 0분 표기를 막아 "0분 후" 같은 무의미 라벨 방지.
 */
export function buildFallbackSequenceLabel(index: number, arrivalSeconds?: number): string {
  const ordinal = index + 1;
  const base = `약 ${ordinal}정거장 전`;
  if (arrivalSeconds == null || arrivalSeconds <= 0) return base;
  const minutes = Math.max(1, Math.round(arrivalSeconds / 60));
  return `${base} (약 ${minutes}분 후)`;
}
