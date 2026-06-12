import { describe, expect, it, vi } from 'vitest';
import {
  BUCKET_MS,
  KNOWN_REGRESSION_IDS,
  bucketKey,
  dayKey,
  incrementRegressionCounters,
  readRegressionCounters,
  validateRegressionUpload,
  writeRegressionDataPoints,
  type RegressionUpload,
} from '../regressionTelemetry';
import { InMemoryKV } from './inMemoryKv';

function base(): Record<string, unknown> {
  return {
    token: 'aabbccdd11223344',
    since: 1_000,
    until: 2_000,
    counts: { '8': 1, '10': 2 },
  };
}

describe('validateRegressionUpload', () => {
  it('accepts a valid payload', () => {
    const result = validateRegressionUpload(base());
    expect(result).not.toBeNull();
    expect(result?.counts['8']).toBe(1);
    expect(result?.counts['10']).toBe(2);
  });

  it('rejects non-object', () => {
    expect(validateRegressionUpload(null)).toBeNull();
    expect(validateRegressionUpload('x')).toBeNull();
  });

  it('rejects missing/empty token', () => {
    expect(validateRegressionUpload({ ...base(), token: '' })).toBeNull();
    const noToken = base();
    delete noToken.token;
    expect(validateRegressionUpload(noToken)).toBeNull();
  });

  it('rejects non-integer / negative time fields', () => {
    expect(validateRegressionUpload({ ...base(), since: -1 })).toBeNull();
    expect(validateRegressionUpload({ ...base(), until: -1 })).toBeNull();
    expect(validateRegressionUpload({ ...base(), since: 1.5 })).toBeNull();
    expect(validateRegressionUpload({ ...base(), until: NaN })).toBeNull();
    expect(validateRegressionUpload({ ...base(), since: 'x' })).toBeNull();
  });

  it('rejects when until < since', () => {
    expect(validateRegressionUpload({ ...base(), since: 2000, until: 1000 })).toBeNull();
  });

  it('rejects when counts is missing or wrong type', () => {
    const missing = base();
    delete missing.counts;
    expect(validateRegressionUpload(missing)).toBeNull();
    expect(validateRegressionUpload({ ...base(), counts: null })).toBeNull();
    expect(validateRegressionUpload({ ...base(), counts: 'x' })).toBeNull();
  });

  it('rejects invalid count value', () => {
    expect(validateRegressionUpload({ ...base(), counts: { '8': -1 } })).toBeNull();
    expect(validateRegressionUpload({ ...base(), counts: { '8': 1.5 } })).toBeNull();
    expect(validateRegressionUpload({ ...base(), counts: { '8': 'x' } })).toBeNull();
  });

  it('drops unknown regression ids', () => {
    const result = validateRegressionUpload({
      ...base(),
      counts: { '8': 1, '99': 5 },
    });
    expect(result?.counts['8']).toBe(1);
    expect((result?.counts as Record<string, number>)['99']).toBeUndefined();
  });

  it('rejects when total is zero (all known ids missing or zero)', () => {
    expect(validateRegressionUpload({ ...base(), counts: {} })).toBeNull();
    expect(
      validateRegressionUpload({ ...base(), counts: { '8': 0, '10': 0 } }),
    ).toBeNull();
    expect(
      validateRegressionUpload({ ...base(), counts: { '99': 5 } }),
    ).toBeNull();
  });
});

describe('writeRegressionDataPoints', () => {
  function makeWriter() {
    return { writeDataPoint: vi.fn() };
  }

  const payload: RegressionUpload = {
    token: 'aabbccdd11223344',
    since: 0,
    until: 1,
    counts: { '8': 2, '10': 0, '11': 3 },
  };

  it('writes one data point per non-zero counter', () => {
    const writer = makeWriter();
    writeRegressionDataPoints(writer, payload);
    expect(writer.writeDataPoint).toHaveBeenCalledTimes(2);
    const labels = writer.writeDataPoint.mock.calls.map((c) => c[0].blobs[0]);
    expect(labels).toContain('regression:8');
    expect(labels).toContain('regression:11');
    expect(labels).not.toContain('regression:10');
  });

  it('skips when all counts are zero', () => {
    const writer = makeWriter();
    writeRegressionDataPoints(writer, { ...payload, counts: { '8': 0 } });
    expect(writer.writeDataPoint).not.toHaveBeenCalled();
  });

  it('includes token prefix in blobs and indexes', () => {
    const writer = makeWriter();
    writeRegressionDataPoints(writer, payload);
    const first = writer.writeDataPoint.mock.calls[0][0];
    expect(first.blobs[1]).toBe('aabbccdd');
    expect(first.indexes[0]).toBe('aabbccdd');
    expect(first.doubles[0]).toBeGreaterThan(0);
  });
});

describe('bucketKey / dayKey', () => {
  it('builds 5m bucket key from bucket timestamp', () => {
    expect(bucketKey(1_700_000_000_000, '8')).toBe('regression:5m:1700000000000:8');
  });

  it('builds day key from iso date', () => {
    expect(dayKey('2026-06-13', '10')).toBe('regression:day:2026-06-13:10');
  });
});

describe('incrementRegressionCounters', () => {
  it('writes both bucket and day key with accumulated value', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const now = Date.UTC(2026, 5, 13, 10, 0, 0);
    await incrementRegressionCounters(kv, now, { '8': 1 });
    await incrementRegressionCounters(kv, now, { '8': 2 });

    const bucketTs = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    expect(await kv.get(bucketKey(bucketTs, '8'))).toBe('3');
    expect(await kv.get(dayKey('2026-06-13', '8'))).toBe('3');
  });

  it('skips zero / missing ids', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const now = Date.UTC(2026, 5, 13, 10, 0, 0);
    await incrementRegressionCounters(kv, now, { '8': 0, '10': 1 });

    const bucketTs = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    expect(await kv.get(bucketKey(bucketTs, '8'))).toBeNull();
    expect(await kv.get(bucketKey(bucketTs, '10'))).toBe('1');
  });

  it('treats malformed KV value as zero on read-modify-write', async () => {
    const kv = new InMemoryKV();
    await kv.put(bucketKey(Math.floor(Date.UTC(2026, 5, 13, 10, 0, 0) / BUCKET_MS) * BUCKET_MS, '8'), 'NaN');
    const now = Date.UTC(2026, 5, 13, 10, 0, 0);
    await incrementRegressionCounters(kv as unknown as KVNamespace, now, { '8': 5 });

    const bucketTs = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    expect(await kv.get(bucketKey(bucketTs, '8'))).toBe('5');
  });
});

describe('readRegressionCounters', () => {
  it('returns all known ids with zeros when KV empty', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const now = Date.UTC(2026, 5, 13, 10, 0, 0);
    const out = await readRegressionCounters(kv, now);
    for (const id of KNOWN_REGRESSION_IDS) {
      expect(out[id]).toEqual({ last5m: 0, lastHour: 0, today: 0, last7d: 0 });
    }
  });

  it('sums current bucket as last5m, 12 buckets as lastHour, day buckets as today/last7d', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const now = Date.UTC(2026, 5, 13, 10, 0, 0);
    const currentBucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;

    // 현재 bucket
    await kv.put(bucketKey(currentBucket, '8'), '5');
    // 30분 전 bucket (포함되어야 함)
    await kv.put(bucketKey(currentBucket - 6 * BUCKET_MS, '8'), '3');
    // 65분 전 bucket (lastHour 윈도우 밖)
    await kv.put(bucketKey(currentBucket - 13 * BUCKET_MS, '8'), '99');

    // 오늘
    await kv.put(dayKey('2026-06-13', '8'), '10');
    // 어제
    await kv.put(dayKey('2026-06-12', '8'), '7');
    // 8일 전 (last7d 윈도우 밖)
    await kv.put(dayKey('2026-06-05', '8'), '99');

    const out = await readRegressionCounters(kv, now);
    expect(out['8'].last5m).toBe(5);
    expect(out['8'].lastHour).toBe(8);
    expect(out['8'].today).toBe(10);
    expect(out['8'].last7d).toBe(17);
  });
});
