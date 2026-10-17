import { describe, expect, it } from 'vitest';

/**
 * red — #2795 옵션 B(런북 스크립트) 로직. 이슈 본문 + 결정 코멘트의 SSoT 쿼리를 스펙만 보고
 * 작성한다. wrangler CLI 실행 자체(I/O)는 `scripts/checkTripMetricsRegression.mjs`(얇은 셸,
 * `fixtureFromTrip.mjs`와 동일 분리 원칙)가 담당 — 여기서는 쿼리 생성 + 응답 파싱 + 리포트
 * 포맷만 검증한다.
 */
import {
  buildRegressionCheckQuery,
  formatRegressionReport,
  parseRegressionCheckResponse,
} from '../checkTripMetricsRegression';
import { REGRESSION_WHERE_BASE } from '../tripMetricsRegressionQuery';

describe('buildRegressionCheckQuery (#2795)', () => {
  it('공통 SSoT 조건(ended_at/lock_attached/boarding_prompt_responded/fired_count/window)을 포함한다', () => {
    const sql = buildRegressionCheckQuery(1_700_000_000_000);
    expect(sql).toMatch(/ended_at IS NOT NULL/);
    expect(sql).toMatch(/lock_attached\s*=\s*1/);
    expect(sql).toMatch(/boarding_prompt_responded\s*=\s*1/);
    expect(sql).toMatch(/fired_count\s*=\s*0/);
    expect(sql).toMatch(/FROM trip_metrics/);
  });

  it('F1 — window 비교가 started_at이 아니라 ended_at 기준이다(어제 시작해 오늘 끝난 장기 trip도 포착)', () => {
    const sql = buildRegressionCheckQuery(1_700_000_000_000);
    expect(sql).toMatch(/ended_at\s*>\s*1700000000000/);
    expect(sql).not.toMatch(/started_at\s*>\s*1700000000000/);
  });

  it('F3 — 옵션 A(tripMetricsRegressionScan)와 동일한 공유 WHERE 술어(SSoT)를 사용한다', () => {
    const sql = buildRegressionCheckQuery(1_700_000_000_000);
    expect(sql).toContain(REGRESSION_WHERE_BASE);
  });
});

describe('parseRegressionCheckResponse (#2795)', () => {
  it('wrangler d1 execute --json 응답에서 results 배열을 파싱한다', () => {
    const stdout = JSON.stringify([
      {
        results: [
          {
            trip_token_hash: 'abc12345',
            started_at: 1_700_000_000_000,
            origin_station: '용마산',
            destination_station: '중곡',
            lock_attached: 1,
            boarding_prompt_responded: 0,
            fired_count: 0,
            end_reason: 'destination-arrived',
          },
        ],
        success: true,
      },
    ]);
    const rows = parseRegressionCheckResponse(stdout);
    expect(rows).toEqual([
      {
        trip_token_hash: 'abc12345',
        started_at: 1_700_000_000_000,
        origin_station: '용마산',
        destination_station: '중곡',
        lock_attached: 1,
        boarding_prompt_responded: 0,
        fired_count: 0,
        end_reason: 'destination-arrived',
      },
    ]);
  });

  it('결과 0건(정상 상태)은 빈 배열을 반환한다 — throw하지 않음(fixtureFromTrip과 다르게 empty=에러 아님)', () => {
    const stdout = JSON.stringify([{ results: [], success: true }]);
    expect(parseRegressionCheckResponse(stdout)).toEqual([]);
  });

  it('F5 — top-level bare 빈 배열([])도 형식 오류가 아니라 0건으로 취급한다', () => {
    expect(parseRegressionCheckResponse('[]')).toEqual([]);
  });

  it('F5 — top-level이 배열이 아니면(예: 객체) 형식 오류로 throw한다', () => {
    expect(() => parseRegressionCheckResponse(JSON.stringify({ oops: true }))).toThrow(
      /예상 형식/,
    );
  });

  it('JSON 파싱 실패 시 명확한 에러 메시지로 throw한다', () => {
    expect(() => parseRegressionCheckResponse('not json')).toThrow(/JSON 파싱 실패/);
  });

  it('results 배열이 없는 형식은 에러로 throw한다', () => {
    expect(() => parseRegressionCheckResponse(JSON.stringify([{ success: true }]))).toThrow(
      /results 배열/,
    );
  });
});

describe('formatRegressionReport (#2795)', () => {
  it('0건이면 정상 상태 메시지를 리포트한다', () => {
    const report = formatRegressionReport([], 1_700_000_000_000);
    expect(report).toMatch(/0건/);
    expect(report).not.toMatch(/tripTokenHash/);
  });

  it('9/23 회귀 형태(backfill) trip이 리포트에 요약된다', () => {
    const report = formatRegressionReport(
      [
        {
          trip_token_hash: 'ffeeddcc',
          started_at: 1_700_000_000_000,
          origin_station: '중곡',
          destination_station: '성수',
          lock_attached: 1,
          boarding_prompt_responded: 0,
          fired_count: 0,
          end_reason: 'destination-arrived',
        },
      ],
      1_700_100_000_000,
    );
    expect(report).toMatch(/1건/);
    expect(report).toMatch(/ffeeddcc/);
    expect(report).toMatch(/중곡/);
    expect(report).toMatch(/성수/);
    expect(report).toMatch(/lock/i);
  });

  it('여러 건이면 트립 수를 정확히 센다', () => {
    const row = {
      trip_token_hash: 'x',
      started_at: 1,
      origin_station: null,
      destination_station: null,
      lock_attached: 0,
      boarding_prompt_responded: 1,
      fired_count: 0,
      end_reason: null,
    };
    const report = formatRegressionReport([row, { ...row, trip_token_hash: 'y' }], 1_700_000_000_000);
    expect(report).toMatch(/2건/);
  });
});
