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
 *
 * #3366 — 진단 첨부 확장(하위호환): body에 `report`(category/stationId/tripKey/occurredAt)와
 * `diagnostics`(dump 문자열)를 선택적으로 받는다. diagnostics는 최대 512KB 앞부분 보존 truncate +
 * 좌표·token 서버 스크럽 후 **별도 KV 키** `feedback-diag:<entryKey>`에 저장하고, entry에는 메타만 둔다
 * (listFeedback·stats cron·export.csv가 대용량 value를 읽지 않게). 빈 message → 400 계약은 그대로.
 */

import {
  COORDINATE_REDACTION_PATTERNS,
  REDACTED_COORDINATE,
  REDACTED_TOKEN,
  TOKEN_HEX_PATTERN,
} from '../../../src/shared/constants/feedbackRedaction';
import { findStationById } from '../../../src/shared/utils/stationLookup';

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

/** 제보 유형 칩 enum (#3366). 무효 값은 drop. */
export const FEEDBACK_REPORT_CATEGORIES = [
  'alarm-missing',
  'alarm-late',
  'alarm-early',
  'wrong-station',
  'wrong-door',
  'boarding-not-detected',
  'other',
] as const;
export type FeedbackReportCategory = (typeof FEEDBACK_REPORT_CATEGORIES)[number];

/** diagnostics 상한(UTF-8 바이트). 실기기 덤프 최대 129KB의 ~4배. */
export const FEEDBACK_DIAGNOSTICS_MAX_BYTES = 512 * 1024;
export const FEEDBACK_DIAG_KEY_PREFIX = 'feedback-diag:';
/** `hashTripToken` 출력 형식(FNV-1a 32bit, 8자 hex). */
const TRIP_KEY_PATTERN = /^[0-9a-f]{8}$/;

export interface FeedbackReport {
  category?: FeedbackReportCategory;
  stationId?: string;
  tripKey?: string;
  occurredAt?: number;
}

export interface FeedbackDiagnosticsMeta {
  /** 저장된(스크럽·truncate 후) 본문 UTF-8 바이트 수. */
  bytes: number;
  truncated: boolean;
  redactedCoordinates: number;
  redactedTokens: number;
  /** diag KV 쓰기 성공 여부. false면 entry만 저장됨. */
  stored: boolean;
}

export interface FeedbackPayload {
  message: string;
  context?: FeedbackContext;
  report?: FeedbackReport;
  /** 원본 dump 문자열(저장 전 `processDiagnostics`로 스크럽·truncate). */
  diagnostics?: string;
}

export interface FeedbackRecord {
  message: string;
  context?: FeedbackContext;
  report?: FeedbackReport;
  diagnostics?: FeedbackDiagnosticsMeta;
  receivedAt: number;
}

export function feedbackDiagKey(entryKey: string): string {
  return `${FEEDBACK_DIAG_KEY_PREFIX}${entryKey}`;
}

export interface ScrubResult {
  text: string;
  redactedCoordinates: number;
  redactedTokens: number;
}

/** 저장 직전 방어 스크럽 — 좌표(문맥 조건) → `[redacted]`, 40자+ hex → `[token]`. */
export function scrubDiagnostics(input: string): ScrubResult {
  let text = input;
  let redactedCoordinates = 0;
  for (const pattern of COORDINATE_REDACTION_PATTERNS) {
    text = text.replace(pattern, () => {
      redactedCoordinates += 1;
      return REDACTED_COORDINATE;
    });
  }
  let redactedTokens = 0;
  text = text.replace(TOKEN_HEX_PATTERN, () => {
    redactedTokens += 1;
    return REDACTED_TOKEN;
  });
  return { text, redactedCoordinates, redactedTokens };
}

/** UTF-8 바이트 상한으로 앞부분 보존 truncate. 멀티바이트 경계에서 잘린 문자는 버린다. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const cut = new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/\uFFFD+$/, '');
  return { text: cut, truncated: true };
}

export interface ProcessedDiagnostics {
  /** 저장할 본문(스크럽·truncate 완료). */
  text: string;
  meta: Omit<FeedbackDiagnosticsMeta, 'stored'>;
}

export function processDiagnostics(raw: string): ProcessedDiagnostics {
  const { text: scrubbed, redactedCoordinates, redactedTokens } = scrubDiagnostics(raw);
  const { text, truncated } = truncateUtf8(scrubbed, FEEDBACK_DIAGNOSTICS_MAX_BYTES);
  return {
    text,
    meta: { bytes: new TextEncoder().encode(text).length, truncated, redactedCoordinates, redactedTokens },
  };
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
  const report = parseReport(obj.report);
  const diagnostics =
    typeof obj.diagnostics === 'string' && obj.diagnostics.length > 0 ? obj.diagnostics : undefined;
  return {
    message,
    ...(context ? { context } : {}),
    ...(report ? { report } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

/** report 필드별 검증 — 무효 필드는 drop(요청 자체는 유지). */
function parseReport(raw: unknown): FeedbackReport | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const report: FeedbackReport = {};
  const category = FEEDBACK_REPORT_CATEGORIES.find((c) => c === o.category);
  if (category) report.category = category;
  if (typeof o.stationId === 'string' && findStationById(o.stationId)) {
    report.stationId = o.stationId;
  }
  if (typeof o.tripKey === 'string' && TRIP_KEY_PATTERN.test(o.tripKey)) {
    report.tripKey = o.tripKey;
  }
  if (typeof o.occurredAt === 'number' && Number.isFinite(o.occurredAt) && o.occurredAt > 0) {
    report.occurredAt = o.occurredAt;
  }
  return Object.keys(report).length > 0 ? report : undefined;
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
  diagnostics?: FeedbackDiagnosticsMeta,
): Promise<string> {
  const key = feedbackKey(receivedAt, id);
  const record: FeedbackRecord = {
    message: payload.message,
    receivedAt,
    ...(payload.context ? { context: payload.context } : {}),
    ...(payload.report ? { report: payload.report } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
  await kv.put(key, JSON.stringify(record), { expirationTtl: FEEDBACK_TTL_SECONDS });
  return key;
}

/**
 * diagnostics 본문을 별도 KV 키에 적재(같은 TTL 30일). 실패는 삼키고 false — entry는 계속 저장된다.
 * 키 접두가 entry(`feedback:`)와 달라 listAllFeedbackKeys 대상이 아니다.
 */
export async function storeFeedbackDiagnostics(
  kv: KVNamespace,
  entryKey: string,
  text: string,
): Promise<boolean> {
  try {
    await kv.put(feedbackDiagKey(entryKey), text, { expirationTtl: FEEDBACK_TTL_SECONDS });
    return true;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'feedback diagnostics write failed', err: String(e) }));
    return false;
  }
}
