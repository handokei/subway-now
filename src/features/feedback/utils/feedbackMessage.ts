interface BuildFeedbackMessageInput {
  /** 사용자가 쓴 자유 메모(미trim). */
  readonly memo: string;
  /** 선택한 유형 칩의 현지화된 라벨. */
  readonly categoryLabel?: string;
  /** 선택한 역 이름. */
  readonly stationName?: string;
}

/**
 * #3366 — 서버 계약(빈 message → 400)을 유지하므로, 칩만 고른 경우 `"[<유형 라벨>] <역명>"`으로 채워 보낸다.
 * 구 서버(PR-1 미배포)는 새 필드를 버려도 message에 요약이 남는다. 메모·유형 둘 다 없으면 빈 문자열.
 */
export function buildFeedbackMessage({ memo, categoryLabel, stationName }: BuildFeedbackMessageInput): string {
  const trimmed = memo.trim();
  if (trimmed.length > 0) return trimmed;
  if (categoryLabel === undefined) return '';
  return stationName === undefined ? `[${categoryLabel}]` : `[${categoryLabel}] ${stationName}`;
}
