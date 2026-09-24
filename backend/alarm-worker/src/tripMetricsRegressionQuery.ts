/**
 * `trip_metrics` 회귀 감지 공유 SQL 술어 — SSoT (#2795, 코드리뷰 PR #2797 F3).
 *
 * 옵션 A(`tripMetricsRegressionScan.ts`, bind 파라미터로 `wrangler`/D1 API 경유)와 옵션 B
 * (`checkTripMetricsRegression.ts`, `wrangler d1 execute --command`는 bind를 지원하지 않아
 * 리터럴 SQL)가 각자 WHERE 절 문자열을 복붙해 갖고 있었다 — "SSoT" 주석과 달리 실제로는
 * 갈라져 있었고, window 비교 컬럼을 고치는 F1 수정이 한쪽에만 반영될 뻔했다. 이제 두
 * caller가 이 모듈 하나(`buildRegressionSql`)만 호출한다 — 조건을 바꾸려면 여기 한 곳만
 * 고치면 A/B 둘 다 반영된다.
 *
 * 회귀 정의: 최근 1일 내 **완료**(ended_at)된 명시 의향(lock 또는 boardingPrompt 응답) trip이
 * fired_count=0. window 비교는 `started_at`이 아니라 `ended_at` 기준이다 — 어제 시작해
 * 오늘 fired_count=0으로 끝난 장기 trip(진짜 실패 증상)을 `started_at` 기준으로는 놓친다.
 */

/** 공유 SELECT 컬럼 목록. */
export const REGRESSION_SELECT_COLUMNS =
  'trip_token_hash, started_at, ended_at, origin_station, destination_station, ' +
  'lock_attached, boarding_prompt_responded, fired_count, end_reason';

/** window 비교를 제외한 공유 WHERE 조건(SSoT) — "완료 + 명시 의향 + 미발사". */
export const REGRESSION_WHERE_BASE = `ended_at IS NOT NULL
  AND (lock_attached = 1 OR boarding_prompt_responded = 1)
  AND fired_count = 0`;

/**
 * 회귀 후보 SELECT SQL을 조립한다.
 *
 * @param windowExprSql — `ended_at >` 뒤에 그대로 삽입되는 SQL 조각. bind 파라미터를 쓰는
 *   caller(옵션 A)는 `'?'`를 넘기고 실제 값은 `.bind(windowStart)`로 전달한다. bind를
 *   지원하지 않는 `wrangler d1 execute --command`(옵션 B)는 `String(windowStartMs)` 리터럴을
 *   넘긴다 — 두 caller 모두 사용자 입력이 아니라 자신이 계산한 epoch ms 숫자이므로 injection
 *   위험이 없다.
 */
export function buildRegressionSql(windowExprSql: string): string {
  return `SELECT ${REGRESSION_SELECT_COLUMNS}
FROM trip_metrics
WHERE ${REGRESSION_WHERE_BASE}
  AND ended_at > ${windowExprSql}
ORDER BY started_at DESC;`;
}
