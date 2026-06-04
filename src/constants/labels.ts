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

/**
 * #856 — DebugModal Silent Push 섹션 라벨.
 *
 * `lastReceivedAt`만 보고 "왜 안 울리지?" 묻는 사용자 의문 해결을 위해 received/fired
 * 카운트와 lockless toggle 상태를 한 라인씩 노출. 측정 인프라가 아니라 UX 표기 보조.
 *
 * 텍스트는 JSX 하드코딩 금지(글로벌 룰 3) 정책 + 추후 i18n 일괄 전환 대비 위치만 분리.
 * (DebugModal은 dev/internal 영역이라 i18n 미적용은 의도된 stand-still — i18n 전환 시 일괄.)
 */
export const SILENT_PUSH_LABELS = {
  /** received row 라벨. 카운트와 last time을 결합한다. */
  receivedKey: 'received',
  /** fired row 라벨. 카운트와 last time을 결합한다. */
  firedKey: 'fired',
  /** lockless station-passed toggle row 라벨. */
  toggleKey: 'toggle',
  /** toggle ON 표기 — 활성. */
  toggleOn: 'on',
  /** toggle OFF 표기 — lockless 비활성, 설정에서 켜기 안내. */
  toggleOff: 'off — lockless station-passed 비활성 (설정에서 켜기)',
} as const;

/**
 * received/fired row의 value 문자열을 만든다.
 *
 * 예:
 *   buildSilentPushCountValue(15, '01:23:45')  → '15 (last 01:23:45)'
 *   buildSilentPushCountValue(0, '(never)')    → '0 (last (never))'
 *   buildSilentPushCountValue(3, null)         → '3'
 *
 * `lastFormatted`는 이미 포맷된 문자열(formatAt 결과 등). null이면 last 라벨 생략.
 * 카운트와 시각을 한 줄로 합쳐 KeyValue row 1개로 표시.
 */
export function buildSilentPushCountValue(
  count: number,
  lastFormatted: string | null,
): string {
  if (lastFormatted == null) return String(count);
  return `${count} (last ${lastFormatted})`;
}
