/**
 * `trip_metrics` 회귀 자동 감시 — 옵션 A(backend cron 자기점검, #2795).
 *
 * 배경: 2026-09-23 매역 알림 전멸 회귀(#2794)가 부품 테스트·커버리지 100%·코드리뷰를 전부
 * 통과하고도 프로덕션에서 통짜로 안 됐다. 사후 발견 신호는 D1 `trip_metrics`뿐이었다 — lock
 * trip의 `fired_count`가 평소 2~4였다가 어느 날 갑자기 0으로 떨어졌다. 이 모듈은 그 "결과
 * 기반 신호"를 매일 자동 스캔해 24시간 내 경보한다.
 *
 * ## 공통 회귀 신호 (SSoT — `tripMetricsRegressionQuery.ts`가 소유. 옵션 B(런북 스크립트,
 * `checkTripMetricsRegression.ts`)와 WHERE 술어를 공유한다 — 코드리뷰 PR #2797 F3, 각자
 * 복붙하다 조건이 갈라지는 회귀를 막는다.)
 *
 * ## cron 자기참조 회피
 * 스캔 자체가 발사 로직에 영향을 주면 안 된다 — `maybeRunTripMetricsRegressionScan` 전체를
 * try/catch로 감싸 실패를 삼킨다(throw하지 않음). 실패는 `console.warn` + Sentry
 * `captureBackendException`으로 승격해 가시성을 확보한다(코드리뷰 F4 — 이전엔 console.warn
 * 뿐이라 조용히 묻혔다). `index.ts`도 이 함수를 별도 branch로 호출해 발사 경로와 코드
 * 경로 자체가 겹치지 않는다.
 *
 * ## 중복 경보 억제
 * `maybeRunDailyFeedbackStats`(feedbackAdmin.ts)와 동일 패턴 — 매분 cron에서 특정 UTC
 * 시:분 윈도우(00:10) 1분간만 스캔을 실행하고, KV에 그날 날짜 키가 이미 있으면 skip한다.
 * 마커 claim(KV put)은 read-check 통과 직후, D1 스캔 이전에 즉시 실행한다(코드리뷰 F6) —
 * 스캔/경보 이후로 미루면 같은 분에 중복 cron invocation이 둘 다 existing=null을 읽고
 * 둘 다 경보할 수 있다. claim 이후 스캔이 크래시하면 그날 마커만 남고 재시도는 못 하지만
 * (그날 하루 유실), try/catch + 일 1회 정책상 다음날 자동 회복되므로 수용 가능하다.
 * 같은 trip이 다음 날 다시 경보되지 않는 이유는 이중 방어: (1) idempotent 날짜 키가 같은
 * UTC 날짜의 재실행을 막고, (2) `ended_at > now - 1day` 윈도우 자체가 다음 스캔 시점엔
 * 이미 24h를 넘긴 과거 trip을 자연히 걸러낸다.
 *
 * ## Sentry 폭주 방지 (코드리뷰 F2)
 * #2794 같은 광범위 회귀(수십 트립 fired=0)에서 트립마다 `captureXEvent`를 부르면 수십
 * Sentry event가 한꺼번에 터져 quota 소진/rate-limit/노이즈로 이어진다 — 정작 경보가
 * 건강해야 할 순간에. 트립별이 아니라 **집계 1건**(`count` + `windowStartMs` + 상위 N건
 * `sampleJson`)으로 emit한다. `console.error`도 트립별이 아니라 요약 1줄.
 */

import { buildRegressionSql } from './tripMetricsRegressionQuery';
import { captureBackendException, captureXEvent } from './sentry';
import type { Env } from './types';

/** cron 매분 호출 중 스캔을 실행하는 UTC 시/분 — `FEEDBACK_STATS_CRON_*`(00:05)와 겹치지 않게 00:10. */
export const REGRESSION_SCAN_HOUR_UTC = 0;
export const REGRESSION_SCAN_MINUTE_UTC = 10;

/** 회귀 판정 window — 최근 1일. */
export const REGRESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Sentry 집계 event에 함께 싣는 sample 상위 건수 상한(폭주 방지, F2). */
export const REGRESSION_SAMPLE_LIMIT = 5;

const REGRESSION_SCAN_KV_PREFIX = 'trip-metrics-regression-scan:';
/** idempotency 마커 보관 기간 — 3일(재조사 여유 + 다음 스캔이 자연히 덮어씀). */
const REGRESSION_SCAN_MARKER_TTL_SEC = 3 * 24 * 60 * 60;

export interface RegressionTripSummary {
  tripTokenHash: string;
  startedAt: number;
  originStation: string | null;
  destinationStation: string | null;
  lockAttached: boolean;
  boardingPromptResponded: boolean;
}

interface RegressionRow {
  trip_token_hash: string;
  started_at: number;
  origin_station: string | null;
  destination_station: string | null;
  lock_attached: number;
  boarding_prompt_responded: number;
}

/**
 * `now` 시점 기준 최근 1일 window(ended_at 기준, F1)에서 회귀 후보 trip을 조회한다.
 * D1 조회 실패는 throw — 호출자(`maybeRunTripMetricsRegressionScan`)가 swallow 책임을 진다.
 */
export async function findTripMetricsRegressions(
  db: D1Database,
  now: number,
): Promise<RegressionTripSummary[]> {
  const windowStart = now - REGRESSION_WINDOW_MS;
  const result = await db.prepare(buildRegressionSql('?')).bind(windowStart).all<RegressionRow>();
  const rows = result.results ?? [];
  return rows.map((row) => ({
    tripTokenHash: row.trip_token_hash,
    startedAt: row.started_at,
    originStation: row.origin_station,
    destinationStation: row.destination_station,
    lockAttached: row.lock_attached === 1,
    boardingPromptResponded: row.boarding_prompt_responded === 1,
  }));
}

function regressionScanKey(date: string): string {
  return `${REGRESSION_SCAN_KV_PREFIX}${date}`;
}

function isoDateUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 회귀 트립 목록을 Sentry 집계 event(F2) + console.error 요약 1줄로 경보한다.
 * `regressions`가 빈 배열이면 아무 것도 하지 않는다(caller가 length 체크 후 호출).
 */
function emitRegressionAlert(regressions: RegressionTripSummary[], windowStartMs: number): void {
  const sample = regressions.slice(0, REGRESSION_SAMPLE_LIMIT);
  const sampleJson = JSON.stringify(sample);

  console.error(
    JSON.stringify({
      msg: 'trip_metrics regression detected — intent trips fired 0 times',
      count: regressions.length,
      windowStartMs,
      sample,
    }),
  );
  // captureXEvent의 context는 flat(Record<string, primitive>)만 받는다 — sample 배열은
  // JSON 문자열로 직렬화해 싣는다.
  captureXEvent('X12-trip-metrics-fired-zero', {
    count: regressions.length,
    windowStartMs,
    sampleJson,
  });
}

/**
 * cron `scheduled()` 매분 호출에서 00:10 UTC 1분 윈도우에만 스캔을 실행한다.
 *
 * 발사 로직과 완전히 독립된 branch — 이 함수 자체가 throw하지 않는다(swallow). 실패는
 * `captureBackendException`으로 Sentry + D1 `backend_errors`에 승격한다(F4).
 */
export async function maybeRunTripMetricsRegressionScan(
  env: Env,
  now: number,
): Promise<{ ran: boolean; date?: string; regressions?: RegressionTripSummary[] }> {
  try {
    const d = new Date(now);
    if (d.getUTCHours() !== REGRESSION_SCAN_HOUR_UTC) return { ran: false };
    if (d.getUTCMinutes() !== REGRESSION_SCAN_MINUTE_UTC) return { ran: false };
    if (!env.DB) return { ran: false };

    const date = isoDateUtc(now);
    const key = regressionScanKey(date);
    const existing = await env.TRIPS.get(key);
    if (existing !== null) return { ran: false, date };

    // F6 — read-check 통과 직후 즉시 claim한다(스캔/경보보다 먼저). 같은 분에 중복
    // cron invocation이 겹쳐도 두 번째 호출은 이 시점 이후의 get()에서 existing!==null을
    // 보게 돼 재경보하지 않는다.
    await env.TRIPS.put(key, JSON.stringify({ claimedAt: now }), {
      expirationTtl: REGRESSION_SCAN_MARKER_TTL_SEC,
    });

    const windowStart = now - REGRESSION_WINDOW_MS;
    const regressions = await findTripMetricsRegressions(env.DB, now);

    if (regressions.length > 0) {
      emitRegressionAlert(regressions, windowStart);
    }

    return { ran: true, date, regressions };
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'tripMetricsRegressionScan failed', err: String(err) }));
    void captureBackendException(env, err, { path: 'tripMetricsRegressionScan' });
    return { ran: false };
  }
}
