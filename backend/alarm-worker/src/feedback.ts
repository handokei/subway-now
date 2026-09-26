/**
 * 사용자 버그 신고 인프라 (#1034, docs/requirements/12-cross-cutting.md).
 *
 * 클라이언트가 SettingsScreen 진입점에서 자유 텍스트 + 디바이스 컨텍스트를 보낸다.
 * 운영자가 `wrangler kv key list --binding FEEDBACK` / `wrangler kv get`으로 수거 후 분기 트리아지.
 *
 * 보관 정책:
 *   - 키: `feedback:${epochMs}:${randomShortId}` — 시각 정렬 + 동시 충돌 회피
 *   - TTL 30일 — 운영팀이 주기적으로 수거, 장기 보관 안 함 (개인정보 최소화)
 *   - context는 옵션 — 미설정/잘못된 형식이면 무시하고 message만 저장
 */

export const FEEDBACK_TTL_SECONDS = 30 * 24 * 60 * 60;
export const FEEDBACK_MAX_MESSAGE_LENGTH = 2000;

/**
 * Rate limit (스팸 방지).
 *
 * 동일 IP가 1분 fixed window 안에서 5회까지 POST 가능. 6번째부터 429.
 * Fixed window를 택한 이유:
 *   - 코드/스토리지 단순. sliding window는 history 배열 유지 필요해 read-modify-write payload가 커진다.
 *   - 경계에서 burst 허용 (최악 10회/2분) 가능하지만 사용자 버그 신고 채널엔 수용 가능.
 *
 * Storage: 기존 FEEDBACK KV를 prefix `rl:feedback:`로 공유. namespace 추가 안 함.
 * Key: `rl:feedback:${ip}:${windowStartMs}` — 윈도우가 바뀌면 자연스럽게 새 키.
 * TTL: WINDOW_MS와 동일 (60s) — 윈도우 종료 후 KV가 자동 청소.
 * Race: KV는 eventually consistent이므로 burst 시 정확히 5건 cap 보장 안 됨 (~5건).
 *       buggy spammer 차단이 목적이므로 soft cap으로 충분.
 */
export const FEEDBACK_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const FEEDBACK_RATE_LIMIT_MAX = 5;

export function rateLimitKey(ip: string, windowStartMs: number): string {
  return `rl:feedback:${ip}:${windowStartMs}`;
}

export function rateLimitWindowStart(nowMs: number): number {
  return Math.floor(nowMs / FEEDBACK_RATE_LIMIT_WINDOW_MS) * FEEDBACK_RATE_LIMIT_WINDOW_MS;
}

export interface RateLimitResult {
  allowed: boolean;
  /** 윈도우 종료까지 남은 초. 429 응답의 Retry-After 헤더에 사용. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window 카운트 증가. count > MAX이면 거부.
 *
 * 정확한 atomic increment 대신 read→write의 best-effort 증가 — KV는 atomic op이 없다.
 * 동시 요청 충돌 시 일부 카운트가 누락될 수 있으나, 스팸 차단 임계값(분당 5회)이
 * 매우 낮아 실질 cap은 ~5건으로 유지된다.
 */
export async function checkRateLimit(
  kv: KVNamespace,
  ip: string,
  nowMs: number,
): Promise<RateLimitResult> {
  const windowStart = rateLimitWindowStart(nowMs);
  const key = rateLimitKey(ip, windowStart);
  const raw = await kv.get(key);
  const current = raw ? Number.parseInt(raw, 10) : 0;
  const count = Number.isFinite(current) && current >= 0 ? current : 0;
  const windowEnd = windowStart + FEEDBACK_RATE_LIMIT_WINDOW_MS;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd - nowMs) / 1000));

  if (count >= FEEDBACK_RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterSeconds };
  }
  await kv.put(key, String(count + 1), {
    expirationTtl: Math.ceil(FEEDBACK_RATE_LIMIT_WINDOW_MS / 1000),
  });
  return { allowed: true, retryAfterSeconds };
}

export interface FeedbackContext {
  appVersion?: string;
  platform?: 'ios' | 'android';
  locale?: string;
  deviceModel?: string;
}

export interface FeedbackPayload {
  message: string;
  context?: FeedbackContext;
}

export interface FeedbackRecord {
  message: string;
  context?: FeedbackContext;
  receivedAt: number;
}

/**
 * 본문 검증. 한 필드라도 잘못되면 null → 호출부가 400 반환.
 * context는 partial — 알려진 필드만 보존하고 나머지는 drop (forward compat).
 */
export function validateFeedback(input: unknown): FeedbackPayload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.message !== 'string') return null;
  const message = obj.message.trim();
  if (message.length === 0) return null;
  if (message.length > FEEDBACK_MAX_MESSAGE_LENGTH) return null;

  const context = parseContext(obj.context);
  return context ? { message, context } : { message };
}

function parseContext(raw: unknown): FeedbackContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const ctx: FeedbackContext = {};
  if (typeof o.appVersion === 'string' && o.appVersion.length > 0) {
    ctx.appVersion = o.appVersion.slice(0, 64);
  }
  if (o.platform === 'ios' || o.platform === 'android') {
    ctx.platform = o.platform;
  }
  if (typeof o.locale === 'string' && o.locale.length > 0) {
    ctx.locale = o.locale.slice(0, 16);
  }
  if (typeof o.deviceModel === 'string' && o.deviceModel.length > 0) {
    ctx.deviceModel = o.deviceModel.slice(0, 64);
  }
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

/** 충돌 회피용 짧은 랜덤 ID. crypto.getRandomValues로 8자 hex. */
export function generateFeedbackId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function feedbackKey(receivedAt: number, id: string): string {
  return `feedback:${receivedAt}:${id}`;
}

/**
 * KV에 적재. JSON 직렬화 + TTL 30일.
 */
export async function storeFeedback(
  kv: KVNamespace,
  payload: FeedbackPayload,
  receivedAt: number,
  id: string,
): Promise<string> {
  const key = feedbackKey(receivedAt, id);
  const record: FeedbackRecord = {
    message: payload.message,
    receivedAt,
    ...(payload.context ? { context: payload.context } : {}),
  };
  await kv.put(key, JSON.stringify(record), { expirationTtl: FEEDBACK_TTL_SECONDS });
  return key;
}
