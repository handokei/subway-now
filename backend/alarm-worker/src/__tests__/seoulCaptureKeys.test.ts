/**
 * seoulCaptureKeys.ts (#2592, Epic #2239 P1 후속) 단위테스트 — GET /admin/seoul-capture/keys
 * 라우트(index.ts)가 위임하는 스캔/검증 로직. 라우트 자체의 auth/binding 위임 여부는
 * index.seoulCaptureKeysWire.test.ts가 별도로 커버(alarmLogStats.ts 선례).
 */
import { describe, expect, it } from 'vitest';
import {
  parseSeoulCaptureRangeQuery,
  listSeoulCaptureKeys,
  SEOUL_CAPTURE_MAX_DATE_RANGE_DAYS,
} from '../seoulCaptureKeys';
import { buildSeoulCaptureKey } from '../seoulCapture';
import { makeFakeR2, makeEmptyFakeR2 } from './helpers/r2Fixtures';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('parseSeoulCaptureRangeQuery (#2592)', () => {
  it('returns {} when neither from nor to given', () => {
    expect(parseSeoulCaptureRangeQuery(undefined, undefined)).toEqual({
      from: undefined,
      to: undefined,
    });
  });

  it('parses valid numeric from/to', () => {
    expect(parseSeoulCaptureRangeQuery('100', '200')).toEqual({ from: 100, to: 200 });
  });

  it.each([
    { label: 'empty string from', from: '', to: '100' },
    { label: 'empty string to', from: '100', to: '' },
    { label: 'whitespace from', from: ' ', to: '100' },
    { label: 'whitespace-padded numeric from', from: ' 100', to: '200' },
    { label: 'non-numeric from', from: 'abc', to: '100' },
    { label: 'non-numeric to', from: '100', to: 'xyz' },
    { label: 'decimal from', from: '100.5', to: '200' },
    { label: 'negative from', from: '-100', to: '200' },
    { label: 'from > to', from: '200', to: '100' },
    { label: 'digit overflow to Infinity', from: '9'.repeat(400), to: '100' },
  ])('returns invalid_range — $label (empty string 함정 회귀)', ({ from, to }) => {
    const result = parseSeoulCaptureRangeQuery(from, to);
    expect(result).toEqual({ error: 'invalid_range' });
  });

  it('returns range_too_wide when date span exceeds the day cap (independent of key count)', () => {
    const from = 0;
    const to = (SEOUL_CAPTURE_MAX_DATE_RANGE_DAYS + 5) * MS_PER_DAY;
    const result = parseSeoulCaptureRangeQuery(String(from), String(to));
    expect(result).toEqual({ error: 'range_too_wide' });
  });

  it('accepts a date span exactly at the day cap', () => {
    const from = 0;
    const to = (SEOUL_CAPTURE_MAX_DATE_RANGE_DAYS - 1) * MS_PER_DAY;
    const result = parseSeoulCaptureRangeQuery(String(from), String(to));
    expect(result).toEqual({ from, to });
  });

  it('does not apply the day cap when only one of from/to is given (full-prefix scan)', () => {
    expect(parseSeoulCaptureRangeQuery('0', undefined)).toEqual({ from: 0, to: undefined });
  });
});

describe('listSeoulCaptureKeys (#2592)', () => {
  it('returns empty keys when R2 has no objects and no range given', async () => {
    const result = await listSeoulCaptureKeys(makeEmptyFakeR2(), undefined, undefined);
    expect(result).toEqual({ keys: [] });
  });

  it('returns all keys when from/to not given (full prefix scan)', async () => {
    const k1 = buildSeoulCaptureKey(1_700_000_000_000);
    const k2 = buildSeoulCaptureKey(1_700_000_100_000);
    const r2 = makeFakeR2([
      { key: k1, tripEndedAt: 0, body: '' },
      { key: k2, tripEndedAt: 0, body: '' },
    ]);
    const result = await listSeoulCaptureKeys(r2, undefined, undefined);
    expect('keys' in result && result.keys.sort()).toEqual([k1, k2].sort());
  });

  it('filters by from<=cycleStartMs<=to across date-partitioned prefixes', async () => {
    const day1 = Date.UTC(2026, 8, 1, 12, 0, 0);
    const day2 = Date.UTC(2026, 8, 2, 12, 0, 0);
    const day3 = Date.UTC(2026, 8, 3, 12, 0, 0);
    const k1 = buildSeoulCaptureKey(day1);
    const k2 = buildSeoulCaptureKey(day2);
    const k3 = buildSeoulCaptureKey(day3);
    const r2 = makeFakeR2([
      { key: k1, tripEndedAt: 0, body: '' },
      { key: k2, tripEndedAt: 0, body: '' },
      { key: k3, tripEndedAt: 0, body: '' },
    ]);
    const result = await listSeoulCaptureKeys(r2, day2 - 1000, day2 + 1000);
    expect(result).toEqual({ keys: [k2] });
  });

  it('applies only the lower bound when to is omitted (full-prefix scan)', async () => {
    const older = buildSeoulCaptureKey(1_700_000_000_000);
    const newer = buildSeoulCaptureKey(1_700_000_100_000);
    const r2 = makeFakeR2([
      { key: older, tripEndedAt: 0, body: '' },
      { key: newer, tripEndedAt: 0, body: '' },
    ]);
    const result = await listSeoulCaptureKeys(r2, 1_700_000_050_000, undefined);
    expect(result).toEqual({ keys: [newer] });
  });

  it('applies only the upper bound when from is omitted (full-prefix scan)', async () => {
    const older = buildSeoulCaptureKey(1_700_000_000_000);
    const newer = buildSeoulCaptureKey(1_700_000_100_000);
    const r2 = makeFakeR2([
      { key: older, tripEndedAt: 0, body: '' },
      { key: newer, tripEndedAt: 0, body: '' },
    ]);
    const result = await listSeoulCaptureKeys(r2, undefined, 1_700_000_050_000);
    expect(result).toEqual({ keys: [older] });
  });

  it('scans multiple date-partitioned prefixes in parallel (bounded concurrency)', async () => {
    // 45일 상한 안에서 여러 날짜에 걸친 key들이 모두 매칭되는지 (동시성 워커 수(5)보다 많은
    // prefix 수로 워커 재사용 경로도 실행).
    const days = Array.from({ length: 8 }, (_, i) => Date.UTC(2026, 8, 1 + i, 12, 0, 0));
    const keys = days.map((d) => buildSeoulCaptureKey(d));
    const r2 = makeFakeR2(keys.map((key) => ({ key, tripEndedAt: 0, body: '' })));
    const result = await listSeoulCaptureKeys(r2, days[0] - 1000, days[days.length - 1] + 1000);
    expect('keys' in result && result.keys.sort()).toEqual([...keys].sort());
  });

  it('paginates truncated R2 list() results (pageSize forced small)', async () => {
    const keys = Array.from({ length: 5 }, (_, i) =>
      buildSeoulCaptureKey(1_700_000_000_000 + i * 1000),
    );
    const r2 = makeFakeR2(
      keys.map((key) => ({ key, tripEndedAt: 0, body: '' })),
      2,
    );
    const result = await listSeoulCaptureKeys(r2, undefined, undefined);
    expect('keys' in result && result.keys.sort()).toEqual([...keys].sort());
  });

  it('ignores keys that do not match the {cycleStartMs}.json basename format', async () => {
    const validKey = buildSeoulCaptureKey(1_700_000_000_000);
    const r2 = makeFakeR2([
      { key: validKey, tripEndedAt: 0, body: '' },
      { key: 'seoul-capture/2026-09-01/not-a-number.json', tripEndedAt: 0, body: '' },
    ]);
    const result = await listSeoulCaptureKeys(r2, undefined, undefined);
    expect(result).toEqual({ keys: [validKey] });
  });

  it('returns range_too_wide when matched keys exceed 5000', async () => {
    const base = 1_700_000_000_000;
    const keys = Array.from({ length: 5001 }, (_, i) => buildSeoulCaptureKey(base + i));
    const r2 = makeFakeR2(keys.map((key) => ({ key, tripEndedAt: 0, body: '' })));
    const result = await listSeoulCaptureKeys(r2, undefined, undefined);
    expect(result).toEqual({ error: 'range_too_wide' });
  });
});
