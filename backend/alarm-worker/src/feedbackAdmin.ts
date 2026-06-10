/**
 * 운영자용 feedback 조회 / CSV export (#1034 follow-up, PR #1042 후속).
 *
 * `POST /feedback`이 KV `FEEDBACK`에 적재한 사용자 신고를 운영자가 wrangler CLI 없이
 * HTTP로 직접 수거할 수 있게 하는 admin endpoint들의 비-HTTP 계층 (pure / KV).
 *
 * 인증: caller(`index.ts`)가 `Authorization: Bearer <ADMIN_TOKEN>` 검증 후 호출 — 본 모듈은
 * 인증 미통과 케이스를 다루지 않는다.
 *
 * 정렬: 최신 → 오래된 순(receivedAt desc). 운영자가 "최근 N건"을 보는 사용 패턴에 맞춤.
 * KV native cursor는 lex ascending(=오래된 순)이라 후속 페이지 호출에서 의미가 어긋나
 * 의도적으로 사용하지 않는다 — 대신 `before` cursor(epoch ms)로 "그 시각보다 더 오래된 N건".
 */

import type { FeedbackContext, FeedbackRecord } from './feedback';

export const FEEDBACK_LIST_DEFAULT_LIMIT = 50;
export const FEEDBACK_LIST_MAX_LIMIT = 500;

export interface FeedbackListEntry {
  key: string;
  receivedAt: number;
  message: string;
  context?: FeedbackContext;
}

export interface FeedbackListResult {
  entries: FeedbackListEntry[];
  /** 다음 페이지 호출 시 `?before=<nextBefore>`로 전달. 더 없으면 null. */
  nextBefore: number | null;
}

export interface ListOptions {
  limit?: number;
  /** epoch ms — 이 시각 미만(strict)인 entry만 반환. desc 페이지네이션 cursor. */
  before?: number;
}

/**
 * limit 정규화 — 1..MAX 범위로 clamp. 비-number/NaN/0/음수는 default로 fallback.
 */
export function normalizeLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return FEEDBACK_LIST_DEFAULT_LIMIT;
  }
  const floored = Math.floor(raw);
  if (floored > FEEDBACK_LIST_MAX_LIMIT) return FEEDBACK_LIST_MAX_LIMIT;
  return floored;
}

/**
 * KV 키에서 receivedAt 추출 — `feedback:${epochMs}:${id}` 포맷.
 * 포맷이 어긋난 키는 NaN을 반환해 호출부가 skip하게 만든다 (graceful).
 */
export function parseReceivedAtFromKey(key: string): number {
  const parts = key.split(':');
  if (parts.length < 3) return Number.NaN;
  const ts = Number(parts[1]);
  return Number.isFinite(ts) ? ts : Number.NaN;
}

/**
 * FEEDBACK KV에서 entry를 desc(최신순) 정렬해 반환.
 *
 * 구현:
 *   1) `list({ prefix: 'feedback:' })`로 모든 키 조회 (KV는 lex asc=오래된순으로 줌)
 *   2) before 필터 + receivedAt desc 정렬
 *   3) limit + 1개를 fetch해 nextBefore 산출(다음 페이지 존재 여부)
 *   4) 각 키의 value를 get → JSON parse. parse 실패는 skip(상한 보호).
 *
 * 30일 TTL + 운영팀이 주기적으로 수거하는 패턴이라 키 수가 수만 단위로 폭발하지 않는다는 가정.
 * 폭발 시 KV list가 1000개 단위 페이지를 cursor로 잇는데, 본 함수는 first page만 사용 —
 * 운영자가 정말 그 이상을 한 번에 보고 싶다면 별도 pagination 설계 필요(현재 요구 범위 밖).
 */
export async function listFeedback(
  kv: KVNamespace,
  options: ListOptions = {},
): Promise<FeedbackListResult> {
  const limit = normalizeLimit(options.limit);
  const before = options.before;

  const { keys } = await kv.list({ prefix: 'feedback:' });
  const filtered = keys
    .map((k) => ({ key: k.name, receivedAt: parseReceivedAtFromKey(k.name) }))
    .filter((k) => Number.isFinite(k.receivedAt))
    .filter((k) => (before === undefined ? true : k.receivedAt < before))
    .sort((a, b) => b.receivedAt - a.receivedAt);

  // limit + 1을 시도 — nextBefore 산출용. 실제 entries는 limit개로 자른다.
  const sliced = filtered.slice(0, limit + 1);
  const hasMore = sliced.length > limit;
  const pageKeys = hasMore ? sliced.slice(0, limit) : sliced;

  const entries: FeedbackListEntry[] = [];
  for (const { key, receivedAt } of pageKeys) {
    const raw = await kv.get(key);
    if (raw === null) continue;
    const parsed = safeParseRecord(raw);
    if (!parsed) continue;
    entries.push({
      key,
      receivedAt: parsed.receivedAt ?? receivedAt,
      message: parsed.message,
      ...(parsed.context ? { context: parsed.context } : {}),
    });
  }

  const nextBefore = hasMore && entries.length > 0
    ? entries[entries.length - 1].receivedAt
    : null;

  return { entries, nextBefore };
}

function safeParseRecord(raw: string): FeedbackRecord | null {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== 'object') return null;
    const r = obj as Record<string, unknown>;
    if (typeof r.message !== 'string') return null;
    if (typeof r.receivedAt !== 'number') return null;
    const record: FeedbackRecord = {
      message: r.message,
      receivedAt: r.receivedAt,
    };
    if (r.context && typeof r.context === 'object') {
      record.context = r.context as FeedbackContext;
    }
    return record;
  } catch {
    return null;
  }
}

/**
 * entries → CSV 직렬화. 운영자가 스프레드시트로 분기 트리아지하기 위한 형식.
 *
 * 컬럼: key, receivedAt(ISO8601 UTC), message, appVersion, platform, locale, deviceModel
 * - 모든 셀은 RFC 4180 규칙으로 quote (필드 안 `"` → `""`, 줄바꿈/콤마 안전).
 * - empty entry 배열도 header line은 항상 반환 — 다운스트림 파서 단순화.
 */
export function toCsv(entries: FeedbackListEntry[]): string {
  const header = [
    'key',
    'receivedAt',
    'message',
    'appVersion',
    'platform',
    'locale',
    'deviceModel',
  ];
  const lines: string[] = [header.map(csvCell).join(',')];
  for (const entry of entries) {
    lines.push(
      [
        entry.key,
        new Date(entry.receivedAt).toISOString(),
        entry.message,
        entry.context?.appVersion ?? '',
        entry.context?.platform ?? '',
        entry.context?.locale ?? '',
        entry.context?.deviceModel ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  // 마지막 줄에도 줄바꿈을 둬 Excel/Numbers 호환.
  return `${lines.join('\n')}\n`;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
