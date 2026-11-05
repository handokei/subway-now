/**
 * Tests for backend lockless miss metric helper (#1972, #1503 잔여 3/3).
 *
 * outcome → bucket 데이터 주도 매핑 + buildLocklessTripMissBucket의 division-by-zero 방어를 검증.
 */
import { describe, expect, it } from 'vitest';
import {
  LOCKLESS_TRIP_END_OUTCOME_TO_BUCKET,
  LOCKLESS_TRIP_END_SOURCE,
  buildLocklessTripMissBucket,
} from '../locklessMissMetric';

describe('LOCKLESS_TRIP_END_SOURCE', () => {
  it('source 식별자가 device alarmLog source와 정합', () => {
    expect(LOCKLESS_TRIP_END_SOURCE).toBe('lockless-trip-end');
  });
});

describe('LOCKLESS_TRIP_END_OUTCOME_TO_BUCKET', () => {
  const cases: Array<[string, 'miss' | 'fired' | 'paradigmIntent']> = [
    ['fired', 'fired'],
    ['suppressed', 'miss'],
    ['received', 'paradigmIntent'],
  ];
  it.each(cases)('outcome=%s → bucket=%s', (outcome, expected) => {
    expect(LOCKLESS_TRIP_END_OUTCOME_TO_BUCKET[outcome]).toBe(expected);
  });

  it('알 수 없는 outcome은 undefined (schema 진화 방어 — silent drop)', () => {
    expect(LOCKLESS_TRIP_END_OUTCOME_TO_BUCKET['unknown-outcome']).toBeUndefined();
  });
});

describe('buildLocklessTripMissBucket', () => {
  it('정상 분기 — miss + fired 합산으로 ratio 산출', () => {
    const result = buildLocklessTripMissBucket({ miss: 3, fired: 7, paradigmIntent: 5 });
    expect(result).toEqual({
      miss: 3,
      fired: 7,
      paradigmIntent: 5,
      ratio: 0.3, // 3 / (3 + 7)
    });
  });

  it('paradigmIntent는 분모/분자 모두 제외 — lesson_silent_push_zero_is_paradigm_intent', () => {
    // miss=0, fired=10 + paradigmIntent=999 — paradigmIntent 가 ratio 에 영향 X.
    const result = buildLocklessTripMissBucket({ miss: 0, fired: 10, paradigmIntent: 999 });
    expect(result.ratio).toBe(0);
    expect(result.paradigmIntent).toBe(999);
  });

  it('miss + fired = 0 → ratio=0 (division-by-zero 방어)', () => {
    const result = buildLocklessTripMissBucket({ miss: 0, fired: 0, paradigmIntent: 0 });
    expect(result.ratio).toBe(0);
  });

  it('paradigmIntent만 있을 때도 ratio=0 — 분모 0 보장', () => {
    const result = buildLocklessTripMissBucket({ miss: 0, fired: 0, paradigmIntent: 42 });
    expect(result).toEqual({
      miss: 0,
      fired: 0,
      paradigmIntent: 42,
      ratio: 0,
    });
  });

  it('모든 trip이 miss인 케이스 — ratio=1', () => {
    const result = buildLocklessTripMissBucket({ miss: 5, fired: 0, paradigmIntent: 0 });
    expect(result.ratio).toBe(1);
  });
});
