/**
 * Low-recall trip ratio webhook 알림 (#972, PR #961 follow-up of Epic #912 A4).
 *
 * Cron tick마다 `lowRecallTripRatioQuery`를 Cloudflare Analytics Engine SQL HTTP API로
 * 실행해 비율이 0보다 크면(즉, `MIN_RECALL_RATIO_THRESHOLD` 미달 trip이 존재) 운영
 * webhook(Slack incoming webhook 또는 호환 receiver)에 POST한다.
 *
 * Why 별도 모듈:
 *   - `recallQueries.ts`는 SQL 문자열 SSOT 전용 (read-side는 외부 dashboard 책임)
 *   - 본 모듈은 worker가 직접 read+evaluate+notify 하는 유일한 경로 — query 보유와 alert
 *     dispatch 책임을 분리해 dashboard와 alert가 동일 SSOT를 공유한다
 *
 * Graceful no-op 조건 (회귀 위험 차단):
 *   - `TELEMETRY` binding 부재 — write가 안 되므로 read도 의미 없음 (현재 Free plan)
 *   - `RECALL_ALERT_WEBHOOK_URL` secret 미설정 — 의도적 비활성
 *   - `CF_ACCOUNT_ID` 또는 `CF_API_TOKEN` secret 미설정 — SQL HTTP API 호출 불가
 *
 * Dedup: 마지막 webhook 발사 시각을 `TRIPS` KV에 stamp(`recallAlert:lastFiredAt`)하고
 * `ALERT_DEDUP_WINDOW_MS`(1시간) 내 재발사 차단. cron이 1분 주기라 dedup 없으면
 * 임계 위반 상태가 지속될 때 60건/h spam 발생.
 *
 * Privacy: webhook payload는 비율/표본 수만 포함 — token prefix·user ID 미노출.
 */

import { MIN_RECALL_RATIO_THRESHOLD } from './metrics';
import {
  gateSuppressionDistribution7dQuery,
  lowRecallTripRatioQuery,
} from './recallQueries';
import type { Env } from './types';

/** 같은 임계 위반 alert이 연속 발사되지 않도록 차단하는 최소 윈도우 (1시간). */
export const ALERT_DEDUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Alert payload `timeWindow`/`gateBreakdown`이 참조하는 집계 윈도우.
 * `lowRecallTripRatioQuery` SQL 본문의 `INTERVAL '7' DAY`와 동일 — 한 쪽이 바뀌면 같이 갱신.
 * alert의 의미적 시간 범위는 **임계를 결정하는 ratio query**의 7d를 기준으로 통일.
 */
export const ALERT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Alert payload에 임베드할 gate breakdown 항목 수 상한 (root cause 단서, 본문 폭주 차단). */
export const ALERT_GATE_BREAKDOWN_TOP_N = 5;

/** KV key — 마지막 webhook 발사 시각 epoch ms 저장. */
export const ALERT_DEDUP_KEY = 'recallAlert:lastFiredAt';

/**
 * Cloudflare AE SQL HTTP API endpoint template.
 * accountId는 secret(`CF_ACCOUNT_ID`)에서 주입 — 빌드 환경에 hardcode 금지.
 */
export const SQL_API_URL_TEMPLATE = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

/**
 * Gate suppression breakdown 1 항목. root cause 단서로 alert 본문에 임베드.
 * `KNOWN_GATE_REASONS` SSOT의 reason key.
 */
export interface RecallAlertGateEntry {
  reason: string;
  count: number;
}

/** webhook POST payload 모양 — Slack incoming webhook은 `text` field만 보면 무시한다(호환). */
export interface RecallAlertPayload {
  /** alert kind discriminator — 향후 다른 KPI alert가 같은 webhook 재사용할 수 있게 분리. */
  kind: 'low-recall';
  /** observed ratio (0~1). MIN_RECALL_RATIO_THRESHOLD 미달 trip / total trip. */
  ratio: number;
  /** SSOT threshold (currently 0.95). */
  threshold: number;
  /** 7d window 내 평가된 token prefix 수 — ratio의 신뢰도 입력. */
  sampleSize: number;
  /** epoch ms — alert 평가 시각. */
  observedAt: number;
  /**
   * 집계 윈도우 epoch ms — `lowRecallTripRatioQuery`의 7d 윈도우 반영.
   * receiver가 `from`/`to` 범위로 dashboard deep-link를 만들 수 있게 explicit 노출.
   */
  timeWindow: { from: number; to: number };
  /**
   * 미달 trip의 주요 차단 사유 top N (count desc). gate breakdown query 실패 시 빈 배열.
   * Alert 받는 운영자가 어떤 gate를 먼저 봐야 할지 즉시 단서 제공.
   */
  gateBreakdown: RecallAlertGateEntry[];
  /** Slack incoming webhook이 그대로 표시할 텍스트(payload kind와 무관한 호환 필드). */
  text: string;
}

/**
 * AE SQL HTTP API 응답 — 우리는 첫 row만 사용. data 형식은 `data[].low_recall_ratio` 등.
 * shape를 좁게 잡아 다른 query는 본 모듈에서 거부.
 */
interface SqlApiRow {
  total_tokens?: number;
  low_recall_tokens?: number;
  low_recall_ratio?: number;
}

interface SqlApiResponse {
  data?: SqlApiRow[];
}

/** Gate suppression query 응답 row — `gateSuppressionDistributionQuery` 출력 shape와 1:1. */
interface GateSqlRow {
  reason?: string;
  suppressed_count?: number;
}

interface GateSqlResponse {
  data?: GateSqlRow[];
}

/**
 * Evaluator 진입점. cron 핸들러에서 매 tick 호출.
 *
 * 흐름:
 *   1. 4가지 graceful no-op 조건 검사 (binding/url/account/token 부재)
 *   2. dedup KV stamp 확인 — 1시간 윈도우 내면 즉시 종료
 *   3. SQL API POST(`lowRecallTripRatioQuery`)
 *   4. 결과 row 없음 또는 ratio === 0 → no breach, 종료
 *   5. ratio > 0 → webhook POST + dedup stamp 갱신
 *
 * fetch 실패는 throw하지 않고 log로만 흘려 cron 본 흐름을 막지 않는다.
 */
export async function evaluateAndMaybeAlert(
  env: Env,
  deps: RecallAlertDeps,
): Promise<RecallAlertOutcome> {
  if (env.TELEMETRY === undefined) return { kind: 'noop', reason: 'binding-missing' };
  if (!env.RECALL_ALERT_WEBHOOK_URL) return { kind: 'noop', reason: 'webhook-missing' };
  if (!env.CF_ACCOUNT_ID) return { kind: 'noop', reason: 'account-missing' };
  if (!env.CF_API_TOKEN) return { kind: 'noop', reason: 'token-missing' };

  const now = deps.now();
  const lastFiredAt = await readDedupStamp(env.TRIPS);
  if (lastFiredAt !== null && now - lastFiredAt < ALERT_DEDUP_WINDOW_MS) {
    return { kind: 'noop', reason: 'dedup' };
  }

  const row = await fetchLowRecallRow(env, deps);
  if (row === null) return { kind: 'noop', reason: 'fetch-failed' };

  const ratio = row.low_recall_ratio ?? 0;
  const sampleSize = row.total_tokens ?? 0;
  if (ratio <= 0 || sampleSize <= 0) {
    return { kind: 'noop', reason: 'no-breach' };
  }

  // Gate breakdown은 root cause 단서로만 사용 — fetch 실패해도 alert 본 흐름은 진행.
  const gateBreakdown = await fetchGateBreakdown(env, deps);
  const baseText =
    `subway-now recall alert — ${(ratio * 100).toFixed(1)}% of trips fell below ` +
    `${MIN_RECALL_RATIO_THRESHOLD} recall (sample=${sampleSize})`;
  const text = gateBreakdown.length > 0
    ? `${baseText}\nTop gates: ${formatGateSummary(gateBreakdown)}`
    : baseText;
  const payload: RecallAlertPayload = {
    kind: 'low-recall',
    ratio,
    threshold: MIN_RECALL_RATIO_THRESHOLD,
    sampleSize,
    observedAt: now,
    timeWindow: { from: now - ALERT_WINDOW_MS, to: now },
    gateBreakdown,
    text,
  };
  const sent = await postWebhook(env.RECALL_ALERT_WEBHOOK_URL, payload, deps);
  if (!sent) return { kind: 'noop', reason: 'webhook-failed' };

  await writeDedupStamp(env.TRIPS, now);
  return { kind: 'fired', payload };
}

/** 호출자(scheduled handler)가 주입 — fetch는 cf binding global이라 명시 주입으로 테스트 용이. */
export interface RecallAlertDeps {
  fetchImpl: typeof fetch;
  now: () => number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** 평가 결과 — fired 또는 noop(이유). 호출자가 stat/log 분기에 사용 가능. */
export type RecallAlertOutcome =
  | { kind: 'fired'; payload: RecallAlertPayload }
  | { kind: 'noop'; reason: RecallAlertNoopReason };

export type RecallAlertNoopReason =
  | 'binding-missing'
  | 'webhook-missing'
  | 'account-missing'
  | 'token-missing'
  | 'dedup'
  | 'fetch-failed'
  | 'no-breach'
  | 'webhook-failed';

/**
 * Dedup stamp read — 파싱 실패/부재는 모두 null로 정규화.
 * KV 값이 corrupt 되어도 alert 흐름 자체는 계속 동작해야 함 (corrupt = 1회 false positive 허용).
 */
async function readDedupStamp(kv: KVNamespace): Promise<number | null> {
  const raw = await kv.get(ALERT_DEDUP_KEY);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Dedup stamp write — TTL은 윈도우의 2배로 잡아 stale entry 자연 만료. */
async function writeDedupStamp(kv: KVNamespace, now: number): Promise<void> {
  const ttlSec = Math.ceil((ALERT_DEDUP_WINDOW_MS * 2) / 1000);
  await kv.put(ALERT_DEDUP_KEY, String(now), { expirationTtl: ttlSec });
}

/**
 * Cloudflare AE SQL HTTP API에 `lowRecallTripRatioQuery` POST.
 * 실패(network/HTTP 오류/JSON 파싱 실패/data 비어있음)는 모두 null 반환.
 * 본 모듈은 cron의 critical path가 아니므로 fail-soft가 정책.
 */
async function fetchLowRecallRow(
  env: Env,
  deps: RecallAlertDeps,
): Promise<SqlApiRow | null> {
  // graceful no-op 조건에서 이미 가드되어 doable. 타입 가드용 캐스팅.
  const accountId = env.CF_ACCOUNT_ID as string;
  const token = env.CF_API_TOKEN as string;
  const log = deps.log ?? (() => undefined);
  try {
    const res = await deps.fetchImpl(SQL_API_URL_TEMPLATE(accountId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      body: lowRecallTripRatioQuery,
    });
    if (!res.ok) {
      log('recall-alert: SQL API non-ok', { status: res.status });
      return null;
    }
    const body = (await res.json()) as SqlApiResponse;
    const row = body.data?.[0];
    return row ?? null;
  } catch (e) {
    log('recall-alert: SQL API fetch threw', { error: String(e) });
    return null;
  }
}

/**
 * Gate suppression breakdown fetch. payload root cause 단서 전용 — 실패는 빈 배열 반환,
 * alert 본 흐름(ratio breach 발사)은 차단하지 않는다. 그래서 별도 fail-soft 경로.
 *
 * 정렬: count desc로 SQL이 이미 정렬해 보내지만, 본 함수가 truncate 책임을 가지므로
 * 다시 정렬해 race-safe하게 top N만 보존한다.
 */
async function fetchGateBreakdown(
  env: Env,
  deps: RecallAlertDeps,
): Promise<RecallAlertGateEntry[]> {
  const accountId = env.CF_ACCOUNT_ID as string;
  const token = env.CF_API_TOKEN as string;
  const log = deps.log ?? (() => undefined);
  try {
    const res = await deps.fetchImpl(SQL_API_URL_TEMPLATE(accountId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      body: gateSuppressionDistribution7dQuery,
    });
    if (!res.ok) {
      log('recall-alert: gate SQL non-ok', { status: res.status });
      return [];
    }
    const body = (await res.json()) as GateSqlResponse;
    const rows = body.data ?? [];
    const entries: RecallAlertGateEntry[] = [];
    for (const r of rows) {
      if (typeof r.reason !== 'string' || r.reason.length === 0) continue;
      if (typeof r.suppressed_count !== 'number' || !Number.isFinite(r.suppressed_count)) continue;
      if (r.suppressed_count <= 0) continue;
      entries.push({ reason: r.reason, count: r.suppressed_count });
    }
    entries.sort((a, b) => b.count - a.count);
    return entries.slice(0, ALERT_GATE_BREAKDOWN_TOP_N);
  } catch (e) {
    log('recall-alert: gate SQL fetch threw', { error: String(e) });
    return [];
  }
}

/** "reason1=12, reason2=7" 형태 단일 줄 — Slack `text` 가독성 위해 top N만. */
function formatGateSummary(entries: RecallAlertGateEntry[]): string {
  return entries.map((e) => `${e.reason}=${e.count}`).join(', ');
}

/**
 * Webhook POST — 성공 시 true. 실패 시 false 반환하고 dedup stamp는 갱신하지 않음
 * (다음 cron tick에서 재시도 가능하게).
 */
async function postWebhook(
  url: string,
  payload: RecallAlertPayload,
  deps: RecallAlertDeps,
): Promise<boolean> {
  const log = deps.log ?? (() => undefined);
  try {
    const res = await deps.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log('recall-alert: webhook non-ok', { status: res.status });
      return false;
    }
    return true;
  } catch (e) {
    log('recall-alert: webhook fetch threw', { error: String(e) });
    return false;
  }
}
