/**
 * #1575 (T12, ADR-017 V8 (b)) — `/trips` POST per-token rate limit.
 *
 * Acceptance V8 (b): same token으로 10분 윈도우 안에 10회 초과 등록 시도는 reject.
 *
 * 회귀 컨텍스트: device 측 register loop / cold restart 반복 / FG↔BG 빠른 전환 race로 같은
 * trip token이 분당 5~10회 POST되는 사례가 있었다. backend는 isSameSession dedup으로 본체는
 * 보호하지만 매 요청마다 KV read/write + waypoints validate + boardingLock check가 발생해
 * Cloudflare Worker 일일 quota(100K)를 소진한다. Token 단위 fixed-window 카운터로 차단.
 *
 * Fixed-window 방식 (feedback rate limit과 동일 패턴):
 *   - window = 10분, 시작 시각으로 정렬(`nowMs - nowMs % WINDOW_MS`).
 *   - KV key: `trip-rate:<tokenPrefix>:<windowStart>` (PII 회피용 prefix 16자).
 *   - max 10 → 11번째 요청부터 429 응답 + Retry-After 헤더.
 *
 * KV는 atomic increment가 없어 동시 요청 race로 일부 count가 underflow될 수 있으나, 정상
 * 사용자(< 10 req/10min)는 영향 없고 폭주 시도(분당 100건+)는 cap 근처에서 차단된다.
 */

export const TRIP_REGISTER_WINDOW_MS = 10 * 60 * 1000;
export const TRIP_REGISTER_MAX_PER_WINDOW = 10;

export interface TripRegisterRateLimitResult {
  allowed: boolean;
  /** 윈도우 종료까지 남은 초. 429 응답 Retry-After 헤더에 사용. */
  retryAfterSeconds: number;
  /** 현재 윈도우의 사용량 (allowed = false 시 cap 이상). */
  count: number;
}

/**
 * 윈도우 시작 epoch ms. nowMs - (nowMs % WINDOW_MS).
 */
export function tripRegisterWindowStart(nowMs: number): number {
  return Math.floor(nowMs / TRIP_REGISTER_WINDOW_MS) * TRIP_REGISTER_WINDOW_MS;
}

/**
 * KV key — token 전체 대신 prefix 16자만 사용. 같은 device의 token rotation 윈도우 안에서는
 * 충돌하지만 device 식별엔 충분(APNs token은 첫 16자가 device 고유 신호 강함). 완전한 PII
 * 회피가 목적이며 false positive는 사용자 본인 device 한정이라 영향 미미.
 */
export function tripRegisterRateLimitKey(
  tokenPrefix: string,
  windowStart: number,
): string {
  return `trip-rate:${tokenPrefix}:${windowStart}`;
}

/**
 * token prefix — 첫 16자. KV key에 사용. 빈 문자열 / 짧은 입력은 그대로 사용 (graceful).
 */
export function makeTokenPrefix(token: string): string {
  return token.slice(0, 16);
}

/**
 * 본 윈도우의 카운트를 read → +1 write. count > MAX이면 거부.
 *
 * KV TTL은 윈도우 길이 + 60초 (만료 race buffer). 다음 윈도우는 자연 reset.
 */
export async function checkTripRegisterRateLimit(
  kv: KVNamespace,
  token: string,
  nowMs: number,
): Promise<TripRegisterRateLimitResult> {
  const prefix = makeTokenPrefix(token);
  const windowStart = tripRegisterWindowStart(nowMs);
  const key = tripRegisterRateLimitKey(prefix, windowStart);
  const raw = await kv.get(key);
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  const current = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  const windowEnd = windowStart + TRIP_REGISTER_WINDOW_MS;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd - nowMs) / 1000));

  if (current >= TRIP_REGISTER_MAX_PER_WINDOW) {
    return { allowed: false, retryAfterSeconds, count: current };
  }
  await kv.put(key, String(current + 1), {
    expirationTtl: Math.ceil(TRIP_REGISTER_WINDOW_MS / 1000) + 60,
  });
  return { allowed: true, retryAfterSeconds, count: current + 1 };
}
