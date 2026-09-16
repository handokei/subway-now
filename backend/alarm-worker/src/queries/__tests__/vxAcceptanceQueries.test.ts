/**
 * Phase 0 #1581 — V/X acceptance SQL 카탈로그 정적 검증.
 *
 * SQL을 실제 실행할 수는 없지만(Cloudflare Analytics Engine 전용), 카탈로그가
 * 다음을 보장하는지 정적으로 확인한다:
 *   - 20개 entry 모두 존재 (V1~V9, V8a/V8b/V8c, X1~X11)
 *   - key 중복 없음
 *   - SQL이 SELECT/FROM 절 + `trip_metrics` dataset 참조 + `{WINDOW}` placeholder 포함
 *   - renderQuery 가 placeholder를 치환 + 미존재 key 처리
 *   - V/X kind 분류 일관성
 */

import { describe, expect, it } from 'vitest';
import {
  VX_ACCEPTANCE_QUERIES,
  findQuery,
  renderQuery,
  type VxKey,
} from '../vxAcceptanceQueries';

const EXPECTED_KEYS: VxKey[] = [
  'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7',
  'V8a', 'V8b', 'V8c', 'V9',
  'X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8', 'X9', 'X10', 'X11',
];

describe('VX_ACCEPTANCE_QUERIES catalog', () => {
  it('contains all 22 V/X entries', () => {
    expect(VX_ACCEPTANCE_QUERIES).toHaveLength(EXPECTED_KEYS.length);
    const keys = VX_ACCEPTANCE_QUERIES.map((q) => q.key);
    expect(new Set(keys)).toEqual(new Set(EXPECTED_KEYS));
  });

  it('has no duplicate keys', () => {
    const keys = VX_ACCEPTANCE_QUERIES.map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(EXPECTED_KEYS)('%s has valid SQL shape', (key) => {
    const entry = findQuery(key);
    expect(entry).toBeDefined();
    const sql = entry!.sql;
    expect(sql).toMatch(/SELECT/i);
    expect(sql).toMatch(/FROM\s+trip_metrics/i);
    expect(sql).toContain('{WINDOW}');
    expect(entry!.description.length).toBeGreaterThan(0);
    expect(entry!.threshold.length).toBeGreaterThan(0);
  });

  it('classifies V* as value and X* as harm', () => {
    for (const entry of VX_ACCEPTANCE_QUERIES) {
      const expected = entry.key.startsWith('V') ? 'value' : 'harm';
      expect(entry.kind).toBe(expected);
    }
  });
});

describe('renderQuery', () => {
  it('replaces {WINDOW} placeholder with the given INTERVAL expression', () => {
    const entry = findQuery('V1')!;
    const rendered = renderQuery(entry, `'1' DAY`);
    expect(rendered).not.toContain('{WINDOW}');
    expect(rendered).toContain(`INTERVAL '1' DAY`);
  });

  it('replaces every occurrence when multiple placeholders exist', () => {
    const synthetic = { ...findQuery('V1')!, sql: `A {WINDOW} B {WINDOW} C` };
    expect(renderQuery(synthetic, 'X')).toBe('A X B X C');
  });
});

describe('findQuery', () => {
  it('returns undefined for unknown key', () => {
    // intentional cast — runtime guard branch coverage
    expect(findQuery('ZZZ' as unknown as VxKey)).toBeUndefined();
  });

  it('returns the matching entry for known key', () => {
    expect(findQuery('X11')?.key).toBe('X11');
  });
});
