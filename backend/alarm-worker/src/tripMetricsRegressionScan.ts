/**
 * `trip_metrics` 회귀 자동 감시 — 옵션 A(backend cron 자기점검, #2795).
 *
 * 배경: 2026-09-23 매역 알림 전멸 회귀(#2794)가 부품 테스트·커버리지 100%·코드리뷰를 전부
 * 통과하고도 프로덕션에서 통짜로 안 됐다. 사후 발견 신호는 D1 `trip_metrics`뿐이었다 — lock
 * trip의 `fired_count`가 평소 2~4였다가 어느 날 갑자기 0으로 떨어졌다. 이 모듈은 그 "결과
 * 기반 신호"를 매일 자동 스캔해 24시간 내 경보한다.
 *
 * ## 공통 회귀 신호 (SSoT — 2026-09-24 결정 코멘트, 옵션 B(런북 스크립트)와 쿼리 텍스트 공유
 * 의도를 유지하되 각자 구현. `scripts/checkTripMetricsRegression.mjs`가 사람이 읽는 리포트로
 * 같은 조건을 재사용한다.)
 *
 *   ended_at IS NOT NULL                                 -- 완료 trip만(진행중 오탐 방지)
 *   AND (lock_attached = 1 OR boarding_prompt_responded = 1) -- 명시 의향 = lock 동급 보호
 *   AND fired_count = 0
 *   AND started_at > now - 1day                          -- 최근 1일 윈도우
 *
 * ## cron 자기참조 회피
 * 스캔 자체가 발사 로직에 영향을 주면 안 된다 — `maybeRunTripMetricsRegressionScan` 전체를
 * try/catch로 감싸 실패를 삼킨다(호출자 `index.ts`도 별도 독립 분기로 배선, 발사 경로와
 * 코드 경로 자체가 겹치지 않는다).
 *
 * ## 중복 경보 억제
 * `maybeRunDailyFeedbackStats`(feedbackAdmin.ts)와 동일 패턴 — 매분 cron에서 특정 UTC
 * 시:분 윈도우(00:10) 1분간만 스캔을 실행하고, KV에 그날 날짜 키가 이미 있으면 skip한다.
 * 같은 trip이 다음 날 다시 경보되지 않는 이유는 이중 방어: (1) idempotent 날짜 키가 같은
 * UTC 날짜의 재실행을 막고, (2) `started_at > now - 1day` 윈도우 자체가 다음 스캔 시점엔
 * 이미 24h를 넘긴 과거 trip을 자연히 걸러낸다.
 */

import { captureXEvent } from './sentry';
import type { Env } from './types';

/** cron 매분 호출 중 스캔을 실행하는 UTC 시/분 — `FEEDBACK_STATS_CRON_*`(00:05)와 겹치지 않게 00:10. */
export const REGRESSION_SCAN_HOUR_UTC = 0;
export const REGRESSION_SCAN_MINUTE_UTC = 10;

/** 회귀 판정 window — 최근 1일. */
export const REGRESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

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
 * 회귀 후보 SELECT. raw SQL(read-only) — `noRawSqlGuard.test.ts`는 `trip_metrics`
 * INSERT/UPDATE만 차단하므로 이 read 경로는 대상이 아니다. window 하한은 bind 파라미터로
 * 전달(문자열 삽입 없음).
 */
function buildRegressionQuery(): string {
  return `SELECT trip_token_hash, started_at, origin_station, destination_station,
       lock_attached, boarding_prompt_responded
FROM trip_metrics
WHERE ended_at IS NOT NULL
  AND (lock_attached = 1 OR boarding_prompt_responded = 1)
  AND fired_count = 0
  AND started_at > ?
ORDER BY started_at DESC`;
}

/**
 * `now` 시점 기준 최근 1일 window에서 회귀 후보 trip을 조회한다.
 * D1 조회 실패는 throw — 호출자(`maybeRunTripMetricsRegressionScan`)가 swallow 책임을 진다.
 */
export async function findTripMetricsRegressions(
  db: D1Database,
  now: number,
): Promise<RegressionTripSummary[]> {
  const windowStart = now - REGRESSION_WINDOW_MS;
  const result = await db.prepare(buildRegressionQuery()).bind(windowStart).all<RegressionRow>();
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
 * cron `scheduled()` 매분 호출에서 00:10 UTC 1분 윈도우에만 스캔을 실행한다.
 *
 * 발사 로직과 완전히 독립된 branch — 이 함수 자체가 throw하지 않는다(swallow). DSN 미설정
 * 등으로 `captureXEvent`가 no-op이어도 `console.error` 구조화 로그는 항상 남는다.
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
    const existing = await env.TRIPS.get(regressionScanKey(date));
    if (existing !== null) return { ran: false, date };

    const regressions = await findTripMetricsRegressions(env.DB, now);

    for (const trip of regressions) {
      console.error(
        JSON.stringify({
          msg: 'trip_metrics regression detected — intent trip fired 0 times',
          tripTokenHash: trip.tripTokenHash,
          startedAt: trip.startedAt,
          originStation: trip.originStation,
          destinationStation: trip.destinationStation,
          lockAttached: trip.lockAttached,
          boardingPromptResponded: trip.boardingPromptResponded,
        }),
      );
      captureXEvent('X12-trip-metrics-fired-zero', {
        tripTokenHash: trip.tripTokenHash,
        startedAt: trip.startedAt,
        originStation: trip.originStation,
        destinationStation: trip.destinationStation,
        lockAttached: trip.lockAttached,
        boardingPromptResponded: trip.boardingPromptResponded,
      });
    }

    await env.TRIPS.put(regressionScanKey(date), JSON.stringify({ count: regressions.length }), {
      expirationTtl: REGRESSION_SCAN_MARKER_TTL_SEC,
    });

    return { ran: true, date, regressions };
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'tripMetricsRegressionScan failed', err: String(err) }));
    return { ran: false };
  }
}
