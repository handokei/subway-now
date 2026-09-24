/**
 * `trip_metrics` 회귀 런북 — 옵션 B(로컬/CI 런북 스크립트, #2795).
 *
 * D1 SQL 문자열 생성 + `wrangler d1 execute --json` 응답 파싱 + 사람이 읽는 리포트 포맷 —
 * 순수 함수만 둔다. wrangler CLI 실행(실제 네트워크 I/O)은
 * `scripts/checkTripMetricsRegression.mjs`(얇은 I/O 셸)가 담당한다 —
 * `fixtureFromTrip.ts`/`fixtureFromTrip.mjs`와 동일 분리 원칙.
 *
 * CI 게이트가 아니다(프로덕션 D1 데이터 조회) — 수동/주기 실행 런북.
 *
 * ## 공통 회귀 신호 (SSoT — `tripMetricsRegressionQuery.ts`가 소유. 옵션 A
 * (`tripMetricsRegressionScan.ts`)와 WHERE 술어를 공유한다 — 코드리뷰 PR #2797 F3, 각자
 * 복붙하다 조건이 갈라지는 회귀를 막는다.)
 *
 * `wrangler d1 execute --command`는 bind 파라미터를 지원하지 않아(단일 SQL 문자열 인자)
 * window 하한을 리터럴 정수로 직접 삽입한다 — 사용자 입력이 아니라 호출자가 계산한
 * epoch ms 숫자이므로 injection 위험이 없다(정수 검증은 caller의 `Number.isFinite` 책임).
 */

import { buildRegressionSql } from './tripMetricsRegressionQuery';

export interface RegressionCheckRow {
  trip_token_hash: string;
  started_at: number;
  origin_station: string | null;
  destination_station: string | null;
  lock_attached: number;
  boarding_prompt_responded: number;
  fired_count: number;
  end_reason: string | null;
}

/**
 * 회귀 후보 SELECT SQL을 생성한다. `windowStartMs` = `now - 1day`(계산은 caller 책임,
 * 스크립트 셸이 `Date.now() - 24*60*60*1000`을 넘긴다). window 비교는 `ended_at` 기준
 * (F1) — SSoT는 `tripMetricsRegressionQuery.buildRegressionSql`이 소유.
 */
export function buildRegressionCheckQuery(windowStartMs: number): string {
  return buildRegressionSql(String(windowStartMs));
}

/**
 * `wrangler d1 execute --json` stdout → RegressionCheckRow[]. 결과 0건(정상 상태)은 빈
 * 배열을 반환한다 — `fixtureFromTrip.ts`의 "empty=캡처 없음 에러"와 달리, 이 스크립트에서는
 * 0건이 곧 "회귀 없음"이라는 건강한 결과이므로 throw하지 않는다.
 *
 * F5(코드리뷰 PR #2797) — top-level bare `[]`(wrangler 버전에 따라 결과 배열 자체가
 * 비어있는 응답을 줄 수 있음)도 형식 오류가 아니라 "0건"으로 취급한다. 형식 오류는
 * top-level이 **배열조차 아닌** 경우(파싱은 됐지만 예상 shape이 아님)로 한정한다.
 */
export function parseRegressionCheckResponse(stdout: string): RegressionCheckRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`D1 조회 실패: 응답 JSON 파싱 실패 (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('D1 조회 실패: 예상 형식(결과 배열)이 아닙니다 — wrangler d1 execute 출력 확인 필요');
  }
  if (parsed.length === 0) return [];
  const first = parsed[0];
  if (!first || typeof first !== 'object' || !Array.isArray((first as Record<string, unknown>).results)) {
    throw new Error('D1 조회 실패: 응답에 results 배열이 없습니다');
  }
  return (first as { results: unknown[] }).results as RegressionCheckRow[];
}

/** 사람이 읽는 리포트 텍스트를 만든다. */
export function formatRegressionReport(rows: RegressionCheckRow[], now: number): string {
  const header = `trip_metrics 회귀 스캔 (${new Date(now).toISOString()}) — 명시 의향(lock/prompt) 있는데 fired_count=0인 완료 trip: ${rows.length}건`;
  if (rows.length === 0) {
    return `${header}\n회귀 없음 — 정상.`;
  }
  const lines = rows.map((row, i) => {
    const intent = row.lock_attached === 1 ? 'lock' : 'boardingPrompt';
    const started = new Date(row.started_at).toISOString();
    return (
      `  [${i + 1}] tripTokenHash=${row.trip_token_hash} started=${started} ` +
      `${row.origin_station ?? '?'} → ${row.destination_station ?? '?'} ` +
      `intent=${intent} endReason=${row.end_reason ?? '?'}`
    );
  });
  return [header, ...lines].join('\n');
}
