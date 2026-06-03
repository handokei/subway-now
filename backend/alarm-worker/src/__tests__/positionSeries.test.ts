import { describe, expect, it } from 'vitest';
import {
  ACCURACY_CUTOFF_M,
  appendPositionPoint,
  clearSeries,
  cosineDirection,
  evaluateWindow,
  haversineKm,
  pickMotionMode,
  POSITION_WINDOW_MS,
  readSeries,
} from '../positionSeries';
import type { PositionPoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

function point(overrides: Partial<PositionPoint>): PositionPoint {
  return {
    lat: 37.5,
    lng: 127.0,
    accuracy: 10,
    ts: 0,
    motion: 'unknown',
    ...overrides,
  };
}

describe('positionSeries — KV roundtrip', () => {
  it('append → read 시 동일 series 복원', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const p = point({ ts: 1000 });
    await appendPositionPoint(kv, 'tok', p);
    const series = await readSeries(kv, 'tok');
    expect(series).toEqual([p]);
  });

  it('30개를 넘어가면 oldest sample이 ring으로 잘림', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    for (let i = 0; i < 40; i++) {
      await appendPositionPoint(kv, 'tok', point({ ts: i }));
    }
    const series = await readSeries(kv, 'tok');
    expect(series).toHaveLength(30);
    expect(series[0].ts).toBe(10);
    expect(series[29].ts).toBe(39);
  });

  it('clearSeries → readSeries 빈 배열', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await appendPositionPoint(kv, 'tok', point({ ts: 1 }));
    await clearSeries(kv, 'tok');
    expect(await readSeries(kv, 'tok')).toEqual([]);
  });

  it('읽은 JSON이 배열이 아니면 빈 배열로 폴백', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await kv.put('pos:tok', JSON.stringify({ notArray: true }));
    expect(await readSeries(kv, 'tok')).toEqual([]);
  });

  it('JSON 파싱 실패 시 빈 배열', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await kv.put('pos:tok', 'not-json');
    expect(await readSeries(kv, 'tok')).toEqual([]);
  });

  it('필드 누락 sample은 filter됨', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const invalid = JSON.stringify([
      { lat: 1, lng: 2, accuracy: 3, ts: 4, motion: 'walking' },
      { lat: 'bad', lng: 2, accuracy: 3, ts: 4, motion: 'walking' },
      null,
    ]);
    await kv.put('pos:tok', invalid);
    const series = await readSeries(kv, 'tok');
    expect(series).toHaveLength(1);
  });
});

describe('haversineKm', () => {
  it('서울시청 → 잠실역 ~ 9-12km 거리', () => {
    const d = haversineKm(37.5663, 126.9779, 37.5133, 127.1006);
    expect(d).toBeGreaterThan(8);
    expect(d).toBeLessThan(15);
  });
  it('동일 좌표 → 0', () => {
    expect(haversineKm(37.5, 127, 37.5, 127)).toBe(0);
  });
});

describe('pickMotionMode', () => {
  it('빈 입력 → unknown', () => {
    expect(pickMotionMode([])).toBe('unknown');
  });
  it('단일 분류 dominant → 해당 분류', () => {
    expect(
      pickMotionMode([
        point({ motion: 'walking' }),
        point({ motion: 'walking' }),
        point({ motion: 'automotive' }),
      ]),
    ).toBe('walking');
  });
  it('동률 → unknown으로 강등', () => {
    expect(
      pickMotionMode([
        point({ motion: 'walking' }),
        point({ motion: 'automotive' }),
      ]),
    ).toBe('unknown');
  });
});

describe('evaluateWindow', () => {
  it('윈도우 밖 sample은 제외 (POSITION_WINDOW_MS 기준)', () => {
    const now = POSITION_WINDOW_MS + 10_000;
    // 1000ms ts는 윈도우 밖 (now - 1000 > 60s)
    const series = [
      point({ ts: 1000, lat: 37.0, lng: 127.0, accuracy: 5, motion: 'walking' }),
      // 윈도우 안 sample 3개 — 1km 정도 이동
      point({ ts: now - 30_000, lat: 37.5, lng: 127.0, accuracy: 5, motion: 'walking' }),
      point({ ts: now - 15_000, lat: 37.502, lng: 127.0, accuracy: 5, motion: 'walking' }),
      point({ ts: now, lat: 37.504, lng: 127.0, accuracy: 5, motion: 'walking' }),
    ];
    const m = evaluateWindow(series, now);
    expect(m.count).toBe(3);
    expect(m.gpsAvgKmh).toBeGreaterThan(0);
  });

  it('accuracy ≥ 50m sample은 hop에서 제외 (게이트 #3 정책)', () => {
    const now = 60_000;
    const series = [
      point({ ts: 0, lat: 37.5, lng: 127.0, accuracy: ACCURACY_CUTOFF_M + 1 }),
      point({ ts: 30_000, lat: 37.51, lng: 127.0, accuracy: 5 }),
      point({ ts: 60_000, lat: 37.52, lng: 127.0, accuracy: 5 }),
    ];
    const m = evaluateWindow(series, now);
    // 첫 번째 hop은 accuracy 50+ 이라 제외, 두 번째 hop (30s, 37.51→37.52)만 카운트
    expect(m.count).toBe(3);
    expect(m.gpsAvgKmh).toBeGreaterThan(0);
  });

  it('윈도우 밖 sample만 있으면 빈 metrics — start/end null, gpsAvgKmh=0', () => {
    const m = evaluateWindow([point({ ts: 0 })], 999_999);
    expect(m.count).toBe(0);
    expect(m.start).toBeNull();
    expect(m.end).toBeNull();
    expect(m.gpsAvgKmh).toBe(0);
    expect(m.motion).toBe('unknown');
  });

  it('dtMs ≤ 0인 sample 쌍은 hop 제외 (시계 역행 보호)', () => {
    const now = 60_000;
    const series = [
      point({ ts: 30_000, lat: 37.5, lng: 127.0, accuracy: 5 }),
      // 두 번째가 ts 같음 → dtMs=0 → skip
      point({ ts: 30_000, lat: 37.51, lng: 127.0, accuracy: 5 }),
      point({ ts: 60_000, lat: 37.52, lng: 127.0, accuracy: 5 }),
    ];
    const m = evaluateWindow(series, now);
    // 첫 hop dtMs=0 skip, 두 번째 hop만 카운트
    expect(m.gpsAvgKmh).toBeGreaterThan(0);
  });
});

describe('cosineDirection', () => {
  it('같은 방향 → 1', () => {
    // 동→서 두 vector 동일 방향
    expect(cosineDirection(0, 0, 0, 1, 0, 0, 0, 2)).toBeCloseTo(1, 5);
  });
  it('정반대 방향 → -1', () => {
    expect(cosineDirection(0, 0, 0, 1, 0, 0, 0, -2)).toBeCloseTo(-1, 5);
  });
  it('직각 → 0', () => {
    expect(cosineDirection(0, 0, 0, 1, 0, 0, 1, 0)).toBeCloseTo(0, 5);
  });
  it('영벡터(velocity 0) → 0', () => {
    expect(cosineDirection(0, 0, 0, 0, 0, 0, 1, 0)).toBe(0);
  });
  it('영벡터(expected 0) → 0', () => {
    expect(cosineDirection(0, 0, 0, 1, 0, 0, 0, 0)).toBe(0);
  });
});
