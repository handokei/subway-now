/**
 * #1578 — Phase 0 P0-2: tripToken hash + context sanitizer (device + backend 공용).
 *
 * Sentry SDK 종속 없는 순수 함수만 export — device(`@sentry/react-native`)와
 * backend(`@sentry/cloudflare`) 양쪽이 동일 import.
 *
 * `hashTripToken`: FNV-1a 32bit non-cryptographic hash. 목적이 PII 노출 차단
 * (역추적 불가)이지 무결성 검증이 아니므로 충분. 같은 분석 window에서 동일 hash
 * 반복 = 같은 trip 추적 가능 수준.
 *
 * `sanitizeContext`: `tripToken` 필드를 `tripTokenHash`로 변환 + undefined 필드 제외.
 */

export type SanitizableContext = Record<
  string,
  string | number | boolean | null | undefined
>;

export function hashTripToken(token: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.codePointAt(i)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function sanitizeContext(
  context: SanitizableContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    if (key === 'tripToken' && typeof value === 'string') {
      out.tripTokenHash = hashTripToken(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}
