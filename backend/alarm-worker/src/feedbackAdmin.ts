/**
 * 운영자용 feedback 조회 / CSV export / 일일 통계 (#1034 follow-up, PR #1042/#1080 후속).
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
 *
 * 보존 정책 (#1080 follow-up):
 *   - feedback entry: TTL 30일 (feedback.ts). 운영자는 30일 윈도우 안에 admin endpoint로 수거.
 *   - 일일 통계: 매일 00:00 UTC 직후 cron이 어제 entry를 집계해 `stats:YYYY-MM-DD` KV 키로
 *     365일 보관. 원문 30일 만료 후에도 카운트/분포는 1년 유지 → KPI 추세 추적.
 *   - 원문 archive(R2/D1) 미도입 — 1년 카운트 통계로 충분하고, 원문 보존은 PII 표면을 늘림.
 */

import type { FeedbackContext, FeedbackRecord } from './feedback';

export const FEEDBACK_LIST_DEFAULT_LIMIT = 50;
export const FEEDBACK_LIST_MAX_LIMIT = 500;

/**
 * KV list cursor 페이지네이션 안전 상한 (#1080 follow-up).
 *
 * KV `list`는 첫 페이지가 최대 1000개 — 그 이상이면 cursor로 잇는다. 운영팀이 30일 안에
 * 수거하는 정상 가정에서 키가 수천 단위로 폭주할 일은 거의 없지만, 30일 TTL + 트래픽 폭증으로
 * 1만+가 될 수도 있다. listFeedback은 desc 정렬을 위해 전체 키를 메모리에 모으므로 cap이 필요.
 *
 * 50_000 키 = 페이지 50회 — Worker CPU 한도(50ms free / 30s paid)를 보수적으로 지키는 값.
 * cap 도달 시 가장 최근 50_000 키 정도가 잡히고 그 이전은 잘림 (desc 첫 페이지는 정확).
 */
export const FEEDBACK_LIST_MAX_KEYS_SCAN = 50_000;

/**
 * 일일 통계 키 prefix + TTL (#1080 follow-up).
 * 운영 KPI 추세를 1년 보관. 원문 30일 만료 후에도 카운트는 365일까지 유지.
 */
export const FEEDBACK_STATS_KEY_PREFIX = 'stats:';
export const FEEDBACK_STATS_TTL_SECONDS = 365 * 24 * 60 * 60;

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
 *   1) `list({ prefix: 'feedback:' })`를 cursor로 반복 호출해 모든 키 enumerate (#1080 follow-up)
 *      - KV first page는 1000개 cap이라 cursor를 잇지 않으면 1000+ 환경에서 최신이 누락된다.
 *      - 안전상한 FEEDBACK_LIST_MAX_KEYS_SCAN(=50_000)에서 중단.
 *   2) before 필터 + receivedAt desc 정렬 (전체 키 대상)
 *   3) limit + 1개를 fetch해 nextBefore 산출(다음 페이지 존재 여부)
 *   4) 각 키의 value를 get → JSON parse. parse 실패는 skip(상한 보호).
 */
export async function listFeedback(
  kv: KVNamespace,
  options: ListOptions = {},
): Promise<FeedbackListResult> {
  const limit = normalizeLimit(options.limit);
  const before = options.before;

  const allKeys = await listAllFeedbackKeys(kv);
  const filtered = allKeys
    .map((name) => ({ key: name, receivedAt: parseReceivedAtFromKey(name) }))
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

/**
 * KV `list` cursor를 잇는 단순 enumerate (#1080 follow-up).
 *
 * 모든 key 이름을 메모리에 모은다 — value는 안 읽음(따로 listFeedback이 entries만 get).
 * KV first page는 1000개 cap이라 cursor를 잇지 않으면 1000+ 환경에서 desc 정렬 시 최신이
 * 잘리는 회귀가 발생한다(#1080 admin endpoint 한계).
 *
 * Safety cap: FEEDBACK_LIST_MAX_KEYS_SCAN(=50_000) 도달 시 중단. 첫 페이지부터 lex asc로
 * 받아 모은 키들에서 마지막에 desc 정렬하므로, cap 도달은 "가장 오래된 키 일부 누락" —
 * 운영 KPI 관점에서는 최신만 보면 되므로 무해. cap 자체는 Worker CPU 한도 보호용.
 */
export async function listAllFeedbackKeys(kv: KVNamespace): Promise<string[]> {
  const all: string[] = [];
  let cursor: string | undefined;
  // 무한 루프 방지: Worker 단일 invocation에서 50회면 50_000 키. 이론적 KV list 페이지 = 1000.
  for (let page = 0; page < 100; page++) {
    const result = await kv.list({ prefix: 'feedback:', cursor });
    for (const k of result.keys) {
      all.push(k.name);
      if (all.length >= FEEDBACK_LIST_MAX_KEYS_SCAN) return all;
    }
    if (result.list_complete) return all;
    if (!result.cursor) return all;
    cursor = result.cursor;
  }
  return all;
}

/**
 * 일일 통계 집계 결과 (#1080 follow-up).
 *
 * - date: ISO date `YYYY-MM-DD` (UTC). 집계 대상 일.
 * - total: 해당 날의 feedback entry 수.
 * - byPlatform: ios/android/unknown 카운트. context 미설정은 'unknown' 버킷.
 * - byAppVersion: appVersion → 카운트. 미설정은 'unknown' 버킷.
 * - byLocale: locale prefix(`ko`, `en`, `ja`, `zh`) → 카운트. 미설정은 'unknown'.
 *
 * Privacy: 카운트만 노출 — message 원문/deviceModel은 집계에 포함하지 않는다.
 *   deviceModel은 카디널리티가 높아 통계로서 가치가 낮고 fingerprint 위험.
 */
export interface FeedbackDailyStats {
  date: string;
  total: number;
  byPlatform: Record<string, number>;
  byAppVersion: Record<string, number>;
  byLocale: Record<string, number>;
}

/**
 * dayStartMs (UTC 00:00) 기준 24시간 윈도우의 feedback entry를 집계.
 *
 * 입력 (dayStartMs)은 cron이 직접 산출 — UTC 자정 정렬. 24h 윈도우 [dayStart, dayEnd)에
 * receivedAt이 속하는 entry만 카운트. 키 enumerate는 `listAllFeedbackKeys`로 cursor 페이지네이션.
 *
 * 정상 케이스: 어제 자정~오늘 자정. cron은 매일 00:00 UTC 직후 1회 실행.
 * Worker 호환: enumerate cap이 50_000이라 단일 invocation에서 처리 가능. 그 이상이면
 * 오래된 일부가 잘리지만, 같은 날 통계는 "최신부터 cap 안에 들어가는 한" 정확.
 */
export async function aggregateFeedbackStats(
  kv: KVNamespace,
  dayStartMs: number,
): Promise<FeedbackDailyStats> {
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  const date = isoDateUtc(dayStartMs);

  const keys = await listAllFeedbackKeys(kv);
  const inRange = keys.filter((name) => {
    const ts = parseReceivedAtFromKey(name);
    return Number.isFinite(ts) && ts >= dayStartMs && ts < dayEndMs;
  });

  const byPlatform: Record<string, number> = {};
  const byAppVersion: Record<string, number> = {};
  const byLocale: Record<string, number> = {};

  for (const key of inRange) {
    const raw = await kv.get(key);
    if (raw === null) continue;
    const record = safeParseRecord(raw);
    if (!record) continue;
    bump(byPlatform, record.context?.platform ?? 'unknown');
    bump(byAppVersion, record.context?.appVersion ?? 'unknown');
    bump(byLocale, localeBucket(record.context?.locale));
  }

  return {
    date,
    total: inRange.length,
    byPlatform,
    byAppVersion,
    byLocale,
  };
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * locale prefix bucket — `ko-KR` → `ko`, 빈/누락은 `unknown`.
 * 카디널리티 폭주 차단 (en-US/en-GB/en-CA … 분리되면 day stats가 비대해짐).
 */
function localeBucket(locale: string | undefined): string {
  if (!locale) return 'unknown';
  const dash = locale.indexOf('-');
  return dash > 0 ? locale.slice(0, dash) : locale;
}

/**
 * epoch ms → `YYYY-MM-DD` (UTC). Date.toISOString() prefix slice.
 */
export function isoDateUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` (UTC) → 그 날의 UTC 00:00 epoch ms.
 * 형식이 어긋나면 NaN 반환 — caller가 invalid date로 처리.
 */
export function dayStartFromIsoDate(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Number.NaN;
  const ts = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(ts) ? ts : Number.NaN;
}

export function feedbackStatsKey(date: string): string {
  return `${FEEDBACK_STATS_KEY_PREFIX}${date}`;
}

/**
 * 집계 결과를 KV에 저장. TTL 365일 — 원문 30일 만료 후에도 카운트 추세는 1년 유지.
 */
export async function storeFeedbackStats(
  kv: KVNamespace,
  stats: FeedbackDailyStats,
): Promise<void> {
  await kv.put(feedbackStatsKey(stats.date), JSON.stringify(stats), {
    expirationTtl: FEEDBACK_STATS_TTL_SECONDS,
  });
}

/**
 * 저장된 일일 통계 조회. 없으면 null — caller가 404 처리.
 */
export async function getFeedbackStats(
  kv: KVNamespace,
  date: string,
): Promise<FeedbackDailyStats | null> {
  const raw = await kv.get(feedbackStatsKey(date));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as FeedbackDailyStats;
  } catch {
    return null;
  }
}

/**
 * Cron 매분 호출에서 "오늘 00:05 UTC 윈도우" 1회만 어제 집계를 트리거한다 (#1080 follow-up).
 *
 * 매분 cron의 모든 invocation에서 풀집계를 돌리면 Worker CPU 낭비 + KV write 폭주.
 * - hourUtc===0 + minuteUtc===5 윈도우: 정확히 1분간 1회 — 자정 직후 race를 피해 5분 grace.
 * - 이미 KV `stats:YYYY-MM-DD` 키가 있으면 skip (idempotent — cron 중복 실행 / replay 안전).
 *
 * `now`는 Date.now()를 caller가 주입 — 테스트 시 결정적 시점 제어.
 */
export const FEEDBACK_STATS_CRON_HOUR_UTC = 0;
export const FEEDBACK_STATS_CRON_MINUTE_UTC = 5;

export async function maybeRunDailyFeedbackStats(
  kv: KVNamespace,
  now: number,
): Promise<{ ran: boolean; date?: string }> {
  const d = new Date(now);
  if (d.getUTCHours() !== FEEDBACK_STATS_CRON_HOUR_UTC) return { ran: false };
  if (d.getUTCMinutes() !== FEEDBACK_STATS_CRON_MINUTE_UTC) return { ran: false };

  // 어제(=오늘 자정 - 24h) 윈도우 집계.
  const yesterdayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 24 * 60 * 60 * 1000;
  const date = isoDateUtc(yesterdayStart);
  // Idempotent guard — 같은 날짜 키가 이미 있으면 재집계 안 함.
  const existing = await kv.get(feedbackStatsKey(date));
  if (existing !== null) return { ran: false, date };

  const stats = await aggregateFeedbackStats(kv, yesterdayStart);
  await storeFeedbackStats(kv, stats);
  return { ran: true, date };
}
