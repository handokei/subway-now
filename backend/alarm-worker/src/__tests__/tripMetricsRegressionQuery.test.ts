import { describe, expect, it } from 'vitest';

/**
 * red — #2795 코드리뷰(PR #2797) F3. 옵션 A(bind 파라미터)와 옵션 B(리터럴 SQL)가 각자
 * WHERE 술어를 복붙해 F1(started_at→ended_at) 수정 시 한쪽만 고쳐지는 drift가 실제로
 * 있었다 — 공유 술어를 단일 모듈로 추출해 조합만 다르게 한다.
 */
import { buildRegressionSql, REGRESSION_SELECT_COLUMNS, REGRESSION_WHERE_BASE } from '../tripMetricsRegressionQuery';

describe('tripMetricsRegressionQuery SSoT (#2795 F3)', () => {
  it('REGRESSION_WHERE_BASE는 ended_at/lock/prompt/fired 공통 조건을 포함하고 window 비교는 포함하지 않는다', () => {
    expect(REGRESSION_WHERE_BASE).toMatch(/ended_at IS NOT NULL/);
    expect(REGRESSION_WHERE_BASE).toMatch(/lock_attached\s*=\s*1/);
    expect(REGRESSION_WHERE_BASE).toMatch(/boarding_prompt_responded\s*=\s*1/);
    expect(REGRESSION_WHERE_BASE).toMatch(/fired_count\s*=\s*0/);
    expect(REGRESSION_WHERE_BASE).not.toMatch(/ended_at\s*>/);
  });

  it('buildRegressionSql(bind placeholder)은 ended_at > ? 로 조립한다(옵션 A)', () => {
    const sql = buildRegressionSql('?');
    expect(sql).toContain(REGRESSION_WHERE_BASE);
    expect(sql).toContain(REGRESSION_SELECT_COLUMNS);
    expect(sql).toMatch(/ended_at\s*>\s*\?/);
    expect(sql).toMatch(/FROM trip_metrics/);
    expect(sql).toMatch(/ORDER BY started_at DESC/);
  });

  it('buildRegressionSql(리터럴 windowExpr)은 그대로 삽입한다(옵션 B)', () => {
    const sql = buildRegressionSql('1700000000000');
    expect(sql).toMatch(/ended_at\s*>\s*1700000000000/);
  });
});
