import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { tripMetrics } from '../schema';

/**
 * 프로덕션 `trip_metrics` DDL과 엔티티 정의 drift 감지 (#2783 요구사항 "introspect 결과 대조").
 *
 * 여기 나열된 컬럼 목록은 실측 DDL 스냅샷이다 — 실행 명령과 시각을 그대로 남긴다:
 *
 *   cd backend/alarm-worker && npx --no-install wrangler d1 execute subway-now-db --remote \
 *     --config wrangler.toml --json \
 *     --command "SELECT sql FROM sqlite_master WHERE name='trip_metrics'"
 *
 *   실행 시각: 2026-09-21. 결과(0001_initial.sql과 바이트 단위 동일, 90행 실데이터 보존):
 *     id, trip_token_hash, started_at, ended_at, end_reason, origin_station,
 *     destination_station, line_list, fired_count, suppressed_count,
 *     silent_push_received, boarding_prompt_displayed, boarding_prompt_responded,
 *     lock_attached, environment_distribution, chain_complete
 *
 * 이 PR은 그 중 `silent_push_received`/`environment_distribution` 2개를
 * `migrations/0007_trip_metrics_drop_unfilled_columns.sql`로 제거한다(근거: 요구사항 3, PR 본문).
 * 아래 fixture는 **마이그레이션 적용 후(0001~0007)** 기대 스키마 — 엔티티가 이 목록과
 * 벗어나면(컬럼 추가/삭제/오탈자) 이 테스트가 실패해 drift를 즉시 잡는다.
 */
const EXPECTED_COLUMNS_AFTER_MIGRATION = [
  'id',
  'trip_token_hash',
  'started_at',
  'ended_at',
  'end_reason',
  'origin_station',
  'destination_station',
  'line_list',
  'fired_count',
  'suppressed_count',
  'boarding_prompt_displayed',
  'boarding_prompt_responded',
  'lock_attached',
  'chain_complete',
];

describe('tripMetrics 엔티티 — 프로덕션 스키마 drift 감지 (#2783)', () => {
  it('엔티티 컬럼(DB 컬럼명) 목록이 마이그레이션 적용 후 기대 스키마와 정확히 일치한다', () => {
    const columns = getTableColumns(tripMetrics);
    const dbColumnNames = Object.values(columns).map((c) => c.name);

    expect(dbColumnNames.sort()).toEqual([...EXPECTED_COLUMNS_AFTER_MIGRATION].sort());
  });

  it('제거 대상 컬럼(silent_push_received/environment_distribution)이 엔티티에 없다', () => {
    const columns = getTableColumns(tripMetrics);
    const dbColumnNames = Object.values(columns).map((c) => c.name);

    expect(dbColumnNames).not.toContain('silent_push_received');
    expect(dbColumnNames).not.toContain('environment_distribution');
  });

  it('id는 primary key다', () => {
    const columns = getTableColumns(tripMetrics);
    expect(columns.id.primary).toBe(true);
  });
});
