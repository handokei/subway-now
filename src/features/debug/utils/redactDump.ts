import { hashTripToken } from '../../../shared/infra/monitoring/tripTokenHash';

/** 이보다 짧은 문자열은 token으로 보지 않는다 — 값 기반 전수 치환이 일반 텍스트를 오염시키지 않도록. */
const MIN_REDACTABLE_TOKEN_LENGTH = 8;

/** #3366 — dump 안 token의 대체 마커. trip_events 키(hashTripToken)와 조인 가능한 값만 남긴다. */
export function tokenMarker(token: string): string {
  return `[token:${hashTripToken(token)}]`;
}

/**
 * #3366 — 알려진 token 값의 모든 등장(URL 경로·identifier·끝 8자 등 부분 포함은 호출부가 구조적으로 처리)을
 * 마커로 치환한다. 긴 token부터 치환해 다른 token의 부분 문자열인 경우에도 안전하다.
 */
export function redactTokenValues(text: string, tokens: readonly string[]): string {
  const candidates = [...new Set(tokens)]
    .filter((token) => token.length >= MIN_REDACTABLE_TOKEN_LENGTH)
    .sort((a, b) => b.length - a.length);
  return candidates.reduce((acc, token) => acc.split(token).join(tokenMarker(token)), text);
}
