/**
 * Cloudflare Worker daily request quota tracker (#1022).
 *
 * 무료 플랜 한도 100K req/day 대비 현재 사용량을 KV에 적재하고,
 * 80% 도달 시 경고 hook(콘솔 + 선택적 webhook)을 발사한다.
 *
 * - KV key: `quota:YYYY-MM-DD` (UTC 날짜 단위, TTL 48h)
 * - GET /admin/quota — 오늘 사용량/한도/비율/경고 여부 반환
 * - incrementDailyRequestCount() — Worker fetch 핸들러 초입에서 1회 호출
 *
 * Privacy: IP/path/token 등 개인정보는 절대 저장하지 않는다. 단순 카운터만.
 */

/** 무료 플랜 일일 요청 한도 */
export const DAILY_REQUEST_LIMIT = 100_000;

/** 경고 hook 발사 임계 비율 (0~1). 0.8 = 80% */
export const QUOTA_WARN_THRESHOLD = 0.8;

/** KV TTL: 48시간 (일 단위 키가 만료되어도 당일+익일 유지) */
const KV_TTL_SECONDS = 48 * 60 * 60;

/** UTC 날짜 문자열 (YYYY-MM-DD) */
export function isoDateUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** 오늘 날짜 기반 KV 키 */
export function quotaKey(dateStr: string): string {
  return `quota:${dateStr}`;
}

/**
 * KV에서 오늘 요청 카운트를 읽는다. 키가 없으면 0.
 */
export async function readDailyCount(kv: KVNamespace, dateStr: string): Promise<number> {
  const raw = await kv.get(quotaKey(dateStr));
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 오늘 요청 카운트를 +1 증가시켜 KV에 적재한다.
 * 80% 임계 최초 도달 시 콘솔 경고 + 선택적 webhook 발사.
 *
 * @returns 증가 후 카운트
 */
export async function incrementDailyRequestCount(
  kv: KVNamespace,
  now: number,
  webhookUrl?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const dateStr = isoDateUtc(now);
  const prev = await readDailyCount(kv, dateStr);
  const next = prev + 1;
  await kv.put(quotaKey(dateStr), String(next), { expirationTtl: KV_TTL_SECONDS });

  const prevRatio = prev / DAILY_REQUEST_LIMIT;
  const nextRatio = next / DAILY_REQUEST_LIMIT;
  const crossedWarn =
    nextRatio >= QUOTA_WARN_THRESHOLD && prevRatio < QUOTA_WARN_THRESHOLD;

  if (crossedWarn) {
    const pct = Math.round(nextRatio * 100);
    console.warn(`[quota] daily request count reached ${pct}% of limit (${next}/${DAILY_REQUEST_LIMIT})`);
    if (webhookUrl) {
      await fireQuotaWebhook(webhookUrl, next, pct, dateStr, fetchImpl).catch(() => {
        // webhook 실패는 트래픽에 영향을 주지 않아야 하므로 swallow
      });
    }
  }

  return next;
}

/** Slack incoming webhook 호환 payload 발사 */
async function fireQuotaWebhook(
  webhookUrl: string,
  count: number,
  pct: number,
  dateStr: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: `⚠️ [subway-now] Worker quota ${pct}% on ${dateStr}: ${count}/${DAILY_REQUEST_LIMIT} req/day`,
    }),
  });
}

/**
 * 오늘 quota 상태 요약.
 */
export interface QuotaStatus {
  date: string;
  count: number;
  limit: number;
  /** 0~1 사용 비율 */
  ratio: number;
  /** ratio >= QUOTA_WARN_THRESHOLD */
  warning: boolean;
}

/**
 * 오늘 quota 상태를 반환한다.
 */
export async function getQuotaStatus(kv: KVNamespace, now: number): Promise<QuotaStatus> {
  const dateStr = isoDateUtc(now);
  const count = await readDailyCount(kv, dateStr);
  const ratio = count / DAILY_REQUEST_LIMIT;
  return {
    date: dateStr,
    count,
    limit: DAILY_REQUEST_LIMIT,
    ratio,
    warning: ratio >= QUOTA_WARN_THRESHOLD,
  };
}
