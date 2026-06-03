import { describe, expect, it } from 'vitest';
import {
  ACCEL_WINDOW_MS,
  appendAccelSample,
  clearAccelSeries,
  evaluateAccelWindow,
  isAccelSummary,
  readAccelSeries,
} from '../accelSeries';
import type { AccelSummary } from '../types';
import { InMemoryKV } from './inMemoryKv';

function sample(overrides: Partial<AccelSummary> = {}): AccelSummary {
  return {
    startTs: 0,
    endTs: 1000,
    count: 100,
    ax: 0.1,
    ay: 0.2,
    az: 0.3,
    magnitudeMean: 0.5,
    magnitudeStd: 0.1,
    magnitudePeak: 1.2,
    ...overrides,
  };
}

describe('accelSeries — KV roundtrip', () => {
  it('append → read 시 동일 series 복원', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const s = sample({ startTs: 1000, endTs: 2000 });
    await appendAccelSample(kv, 'tok', s);
    expect(await readAccelSeries(kv, 'tok')).toEqual([s]);
  });

  it('90개를 넘어가면 oldest sample이 ring으로 잘림', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    for (let i = 0; i < 100; i++) {
      await appendAccelSample(kv, 'tok', sample({ startTs: i, endTs: i + 1 }));
    }
    const series = await readAccelSeries(kv, 'tok');
    expect(series).toHaveLength(90);
    expect(series[0].startTs).toBe(10);
    expect(series[89].startTs).toBe(99);
  });

  it('clearAccelSeries → readAccelSeries 빈 배열', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await appendAccelSample(kv, 'tok', sample());
    await clearAccelSeries(kv, 'tok');
    expect(await readAccelSeries(kv, 'tok')).toEqual([]);
  });

  it('읽은 JSON이 배열이 아니면 빈 배열로 폴백', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await kv.put('accel:tok', JSON.stringify({ notArray: true }));
    expect(await readAccelSeries(kv, 'tok')).toEqual([]);
  });

  it('JSON 파싱 실패 시 빈 배열', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await kv.put('accel:tok', 'not-json');
    expect(await readAccelSeries(kv, 'tok')).toEqual([]);
  });

  it('필드 누락 sample은 filter됨', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const invalid = JSON.stringify([
      { startTs: 1, endTs: 2, count: 100, ax: 0, ay: 0, az: 0, magnitudeMean: 0, magnitudeStd: 0, magnitudePeak: 0 },
      { startTs: 'bad', endTs: 2 }, // 잘못된 타입
      null,
    ]);
    await kv.put('accel:tok', invalid);
    const series = await readAccelSeries(kv, 'tok');
    expect(series).toHaveLength(1);
  });
});

describe('isAccelSummary', () => {
  it('정상 sample → true', () => {
    expect(isAccelSummary(sample())).toBe(true);
  });

  it.each([
    ['null', null],
    ['string', 'foo'],
    ['number', 123],
    ['missing startTs', { ...sample(), startTs: undefined }],
    ['NaN endTs', { ...sample(), endTs: Number.NaN }],
    ['count Infinity', { ...sample(), count: Infinity }],
    ['ax string', { ...sample(), ax: 'x' }],
    ['ay missing', { ...sample(), ay: undefined }],
    ['az missing', { ...sample(), az: undefined }],
    ['magnitudeMean NaN', { ...sample(), magnitudeMean: Number.NaN }],
    ['magnitudeStd Infinity', { ...sample(), magnitudeStd: Infinity }],
    ['magnitudePeak missing', { ...sample(), magnitudePeak: undefined }],
  ])('reject — %s', (_label, value) => {
    expect(isAccelSummary(value)).toBe(false);
  });
});

describe('evaluateAccelWindow', () => {
  const now = 1_000_000;

  it('빈 series → 0 metrics', () => {
    expect(evaluateAccelWindow([], now)).toEqual({
      count: 0,
      avgMagnitudeMean: 0,
      maxMagnitudePeak: 0,
      avgMagnitudeStd: 0,
    });
  });

  it('window 안 sample만 집계, 오래된 sample은 컷', () => {
    const inside = sample({
      endTs: now - 1000,
      magnitudeMean: 1,
      magnitudeStd: 0.1,
      magnitudePeak: 2,
    });
    const insideOlder = sample({
      endTs: now - 30_000,
      magnitudeMean: 3,
      magnitudeStd: 0.5,
      magnitudePeak: 4,
    });
    const outside = sample({
      endTs: now - ACCEL_WINDOW_MS - 1, // 윈도우 직후 1ms 초과 → 제외
      magnitudeMean: 100,
      magnitudeStd: 100,
      magnitudePeak: 100,
    });
    const m = evaluateAccelWindow([outside, insideOlder, inside], now);
    expect(m.count).toBe(2);
    expect(m.avgMagnitudeMean).toBeCloseTo(2);
    expect(m.avgMagnitudeStd).toBeCloseTo(0.3);
    expect(m.maxMagnitudePeak).toBe(4);
  });
});
