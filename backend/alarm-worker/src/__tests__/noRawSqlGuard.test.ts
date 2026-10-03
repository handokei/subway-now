import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * raw SQL 재발 차단 (#2783 요구사항 4).
 *
 * `trip_metrics`는 이제 `src/db/schema.ts` 엔티티(Drizzle)를 통해서만 write(INSERT/UPDATE)한다
 * (`src/d1TripMetrics.ts`). raw SQL 문자열로 같은 테이블에 INSERT/UPDATE 하는 새 코드가 다시
 * 생기면 이 이슈의 원 결함(컬럼이 조용히 누락)이 재발한다 — 그래서 이 테스트가 소스 전체를
 * 스캔해 허용 목록(entity write 경로) 밖에서 해당 패턴이 나오면 즉시 실패시킨다.
 *
 * 스코프: 이번 PR은 `trip_metrics` 하나만 엔티티로 옮긴다(#2783). `trip_events` 등 나머지
 * 테이블은 후속 PR 전까지 raw SQL이 정상이므로 이 가드 대상이 아니다.
 */
const REPO_ROOT = join(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');

/** trip_metrics INSERT/UPDATE가 엔티티를 통해서만 실행되도록 허용된 유일한 파일. */
const ALLOWED_FILE = join(SRC_DIR, 'd1TripMetrics.ts');

// 한 줄 내에서만 매칭 — 실제 raw SQL 문자열 형태(`INSERT INTO trip_metrics` / `UPDATE
// trip_metrics SET ...`)만 잡고, 여러 줄에 걸친 산문 주석(예: 이 파일/schema.ts 자체가
// "INSERT" 와 "trip_metrics" 를 설명하는 문장)은 오탐하지 않는다.
const RAW_SQL_PATTERN = /(INSERT\s+(?:OR\s+\w+\s+)?INTO\s+trip_metrics|UPDATE\s+trip_metrics\s+SET)/i;

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...listTsFiles(fullPath));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('raw SQL 재발 차단 — trip_metrics INSERT/UPDATE (#2783)', () => {
  it('trip_metrics에 대한 raw SQL INSERT/UPDATE는 d1TripMetrics.ts(엔티티 write 경로) 밖에 없다', () => {
    const violations: string[] = [];
    for (const file of listTsFiles(SRC_DIR)) {
      if (file === ALLOWED_FILE) continue;
      if (file.includes(`${join('__tests__', '')}`) || file.endsWith('.test.ts')) continue;
      const content = readFileSync(file, 'utf-8');
      if (RAW_SQL_PATTERN.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  it('허용 파일(d1TripMetrics.ts) 자체도 raw SQL INSERT/UPDATE 문자열을 갖지 않는다(엔티티 전용)', () => {
    const content = readFileSync(ALLOWED_FILE, 'utf-8');
    expect(RAW_SQL_PATTERN.test(content)).toBe(false);
  });
});
