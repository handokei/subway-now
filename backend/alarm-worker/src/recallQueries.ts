/**
 * Recall KPI 집계 query (#919, Epic #912 A4 후속).
 *
 * `recordRecallUpload`가 Analytics Engine(dataset `silent_push_telemetry`)에 적재한
 * data point들을 대시보드/운영 alert에서 조회하기 위한 **SQL 문자열 SSOT**.
 *
 * Why string SSOT (코드로 실행하지 않음)
 *   현재 `wrangler.toml`은 Workers Paid 대기로 `[[analytics_engine_datasets]]` 블록이
 *   주석 처리되어 있어 워커 런타임에는 AE binding이 없다. 또한 Workers AE binding은 *write* 전용
 *   (`writeDataPoint`)이며, *read*는 Cloudflare SQL HTTP API
 *   (`POST https://api.cloudflare.com/client/v4/accounts/<id>/analytics_engine/sql`)
 *   로만 가능하다. 따라서 본 모듈은 query 문자열을 SSOT로 export하고,
 *   `GET /metrics/recall/summary` 엔드포인트가 이를 그대로 노출 — 외부 대시보드
 *   (Grafana / Notion 운영 페이지)가 동일 문자열로 SQL API를 호출한다.
 *
 * Schema 가정 (recallTelemetry.ts:recordRecallUpload와 동기)
 *   blob1  = `phase3:<metricKey>:<field>` — perStationAlarmRecall의 경우 field='hit'|'total',
 *             gateSuppressionDistribution의 경우 field='reason:<reasonKey>'
 *   blob2  = token prefix(8자)
 *   double1 = value (rate=정수 count, gate=정수 count)
 *   index1  = token prefix
 *
 * 새 query 추가 = 본 파일에 `export const ...Query = ...` 추가 + `RECALL_QUERIES` 배열에 등록.
 * 새 metric 추가 = `metrics.catalog.json` + `recallTelemetry.ts` 양쪽이 우선, 본 파일은 catalog SSOT
 * 그대로 import해서 hardcoded key 없이 query를 조립한다.
 *
 * Privacy: query는 token prefix(8자)만 다룬다 — 개별 사용자 식별 불가.
 */

import {
  METRIC_KIND,
  MIN_RECALL_RATIO_THRESHOLD,
  RECALL_THRESHOLD_CRITICAL,
} from './metrics';
import { RECALL_DISTRIBUTION_LABEL_PREFIX } from './recallTelemetry';

/**
 * AE dataset name. wrangler.toml의 `dataset = "silent_push_telemetry"`와 동일 (#498 / #506 주석 참조).
 * binding이 활성화되어도 dataset name은 바뀌지 않는다 — read query에서 FROM 절에 그대로 사용.
 */
export const RECALL_DATASET = 'silent_push_telemetry';

/**
 * 운영 대시보드 Notion 페이지 URL (#981 / PR #961 후속).
 *
 * Notion 페이지가 endpoint 응답에 포함된 SQL 카탈로그를 그대로 사용한다.
 * `GET /metrics/recall/summary` 응답에 함께 노출 — 외부에서 endpoint만 보고도
 * 운영 페이지 위치를 알 수 있게 SSOT 일원화.
 *
 * 페이지 컨텐츠 source: `docs/ops/recall-dashboard.md`.
 */
export const RECALL_OPS_PAGE_URL =
  'https://app.notion.com/p/37730c0194b6817e8953dacb9e533039';

/**
 * 본 모듈이 사용하는 metric 식별자 — catalog SSOT(`metrics.catalog.json`)에서 동적으로 끌어와
 * hardcoded 식별자 없음. catalog에서 key가 바뀌면 query도 자동 갱신.
 */
const RECALL_RATE_KIND = METRIC_KIND.PER_STATION_ALARM_RECALL;

/** rate metric의 field 분해 — `writeMetricDataPoints` 내부 schema와 일치. */
const RATE_HIT_LABEL = `phase3:${RECALL_RATE_KIND}:hit`;
const RATE_TOTAL_LABEL = `phase3:${RECALL_RATE_KIND}:total`;

/** gate suppression distribution은 `phase3:gateSuppressionDistribution:reason:<reason>` prefix. */
const GATE_LABEL_PREFIX = `phase3:${RECALL_DISTRIBUTION_LABEL_PREFIX}:`;

/**
 * **Q1. Daily recall rate.**
 *
 * 일자별 perStationAlarmRecall rate = SUM(hit) / SUM(total).
 * 분자/분모 두 data point를 동시에 누적하고 비율 계산.
 *
 * 사용처
 *   - Grafana time-series: 일별 매역 알림 도달률 추세.
 *   - Notion 운영 대시보드 KPI 카드.
 */
export const dailyRecallRateQuery = `
SELECT
  day,
  fired_stops,
  expected_stops,
  if(expected_stops > 0, fired_stops / expected_stops, 0) AS recall_rate
FROM (
  SELECT
    toStartOfDay(timestamp) AS day,
    SUM(CASE WHEN blob1 = '${RATE_HIT_LABEL}' THEN double1 ELSE 0 END) AS fired_stops,
    SUM(CASE WHEN blob1 = '${RATE_TOTAL_LABEL}' THEN double1 ELSE 0 END) AS expected_stops
  FROM ${RECALL_DATASET}
  WHERE timestamp > NOW() - INTERVAL '14' DAY
    AND blob1 IN ('${RATE_HIT_LABEL}', '${RATE_TOTAL_LABEL}')
  GROUP BY day
)
ORDER BY day DESC
`.trim();

/**
 * **Q2. Gate suppression breakdown.**
 *
 * 최근 14일 reason별 차단 count — `recordRecallUpload`가 `reason:<id>` 접미사로 분해
 * 적재하므로 SQL `substring`으로 reason key 추출. reason 카탈로그가 늘어도 query 수정 불필요.
 *
 * 사용처
 *   - Stacked bar / pie: 어느 게이트가 가장 많이 차단하는지.
 *   - A1~A3(완화/임계/silence) 효과 측정의 기준 분포.
 */
export const gateSuppressionDistributionQuery = `
SELECT
  substring(blob1, ${GATE_LABEL_PREFIX.length + 1}) AS reason,
  SUM(double1) AS suppressed_count
FROM ${RECALL_DATASET}
WHERE timestamp > NOW() - INTERVAL '14' DAY
  AND blob1 LIKE '${GATE_LABEL_PREFIX}%'
GROUP BY reason
ORDER BY suppressed_count DESC
`.trim();

/**
 * **Q3. Low-recall trip ratio (alert 임계, 두 등급).**
 *
 * token prefix 단위로 hit/total 합산 → 두 임계 미만 prefix 수를 동시에 산출:
 *   - `low_recall_tokens` : recall < `MIN_RECALL_RATIO_THRESHOLD` (warning)
 *   - `critical_recall_tokens` : recall < `RECALL_THRESHOLD_CRITICAL` (critical, more strict)
 *
 * 두 카운트가 같은 outer SELECT에서 나오므로 evaluator는 SQL 1회 호출로 두 severity를
 * 모두 결정. critical ⊂ low_recall 관계는 SQL이 보장.
 *
 * Threshold SSOT: `metrics.catalog.json:{MIN_RECALL_RATIO_THRESHOLD, RECALL_THRESHOLD_CRITICAL}`.
 *
 * 사용처
 *   - "95% / 90% 미달 trip 비율" KPI 카드.
 *   - 임계 초과 시 운영 alert webhook trigger 입력값 (severity 분기).
 */
export const lowRecallTripRatioQuery = `
SELECT
  total_tokens,
  low_recall_tokens,
  critical_recall_tokens,
  if(total_tokens > 0, low_recall_tokens / total_tokens, 0) AS low_recall_ratio,
  if(total_tokens > 0, critical_recall_tokens / total_tokens, 0) AS critical_recall_ratio
FROM (
  SELECT
    COUNT(*) AS total_tokens,
    SUM(CASE WHEN total > 0 AND (hit / total) < ${MIN_RECALL_RATIO_THRESHOLD} THEN 1 ELSE 0 END) AS low_recall_tokens,
    SUM(CASE WHEN total > 0 AND (hit / total) < ${RECALL_THRESHOLD_CRITICAL} THEN 1 ELSE 0 END) AS critical_recall_tokens
  FROM (
    SELECT
      blob2 AS token_prefix,
      SUM(CASE WHEN blob1 = '${RATE_HIT_LABEL}' THEN double1 ELSE 0 END) AS hit,
      SUM(CASE WHEN blob1 = '${RATE_TOTAL_LABEL}' THEN double1 ELSE 0 END) AS total
    FROM ${RECALL_DATASET}
    WHERE timestamp > NOW() - INTERVAL '7' DAY
      AND blob1 IN ('${RATE_HIT_LABEL}', '${RATE_TOTAL_LABEL}')
    GROUP BY token_prefix
  )
  WHERE total > 0
)
`.trim();

/**
 * **Q4. Gate suppression breakdown — 7d window (alert payload 전용).**
 *
 * `gateSuppressionDistributionQuery`는 dashboard의 14d 안정 윈도우 SSOT라 변경 부담이 크다.
 * Alert payload는 `lowRecallTripRatioQuery`의 7d 임계 윈도우와 의미가 일치해야 receiver가
 * `timeWindow.from`/`to`를 그대로 dashboard deep-link에 쓸 수 있다. 따라서 동일 분포 query를
 * 7d 윈도우로 별도 노출 — SQL 본문 외엔 동일.
 *
 * 사용처
 *   - `recallAlerts.ts:fetchGateBreakdown` — alert payload `gateBreakdown` 임베드.
 */
export const gateSuppressionDistribution7dQuery = `
SELECT
  substring(blob1, ${GATE_LABEL_PREFIX.length + 1}) AS reason,
  SUM(double1) AS suppressed_count
FROM ${RECALL_DATASET}
WHERE timestamp > NOW() - INTERVAL '7' DAY
  AND blob1 LIKE '${GATE_LABEL_PREFIX}%'
GROUP BY reason
ORDER BY suppressed_count DESC
`.trim();

/**
 * Query 목록 — 카탈로그 형태로 노출해 endpoint가 순회. 새 query 추가 시 본 배열에 등록만.
 */
export interface RecallQueryEntry {
  /** 안정 식별자. dashboard URL slug로 사용. */
  id: string;
  /** 사람이 읽는 한 줄 설명 — 운영 페이지 카드 제목으로 사용. */
  description: string;
  /** Cloudflare AE SQL. */
  sql: string;
}

export const RECALL_QUERIES: readonly RecallQueryEntry[] = Object.freeze([
  {
    id: 'daily-recall-rate',
    description: '일별 매역 알림 recall rate (분자=fired stops, 분모=expected stops, 14일 윈도우)',
    sql: dailyRecallRateQuery,
  },
  {
    id: 'gate-suppression-distribution',
    description: '게이트별 차단 분포 — 14일 윈도우 reason별 count',
    sql: gateSuppressionDistributionQuery,
  },
  {
    id: 'low-recall-trip-ratio',
    description: `recall < ${MIN_RECALL_RATIO_THRESHOLD} (warning) / < ${RECALL_THRESHOLD_CRITICAL} (critical) token 비율 (운영 alert 임계 입력, 7일 윈도우)`,
    sql: lowRecallTripRatioQuery,
  },
]);
