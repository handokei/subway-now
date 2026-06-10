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
