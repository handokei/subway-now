import {
  COORDINATE_REDACTION_PATTERNS,
  REDACTED_COORDINATE,
  REDACTED_TOKEN,
  TOKEN_HEX_PATTERN,
} from '../constants/feedbackRedaction';

/**
 * #3366 — 버그 신고 진단 텍스트 방어 스크럽. 서버(저장 직전)와 같은 공용 패턴을 쓴다.
 * 구조적 치환(좌표 필드·알려진 token 값)이 1차이고, 이 함수는 놓친 것을 잡는 2차 방어선이다.
 */
export function scrubDiagnostics(text: string): string {
  const coordinateScrubbed = COORDINATE_REDACTION_PATTERNS.reduce(
    // 모든 좌표 패턴의 capture group 1 = 보존할 앞부분(feedbackRedaction.ts 계약).
    (acc, pattern) => acc.replace(pattern, `$1${REDACTED_COORDINATE}`),
    text,
  );
  return coordinateScrubbed.replace(TOKEN_HEX_PATTERN, REDACTED_TOKEN);
}
