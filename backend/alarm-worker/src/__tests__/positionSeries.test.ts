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

describe('evaluateWindow — mapMatchedKmh (#828 Phase 1+2 wire)', () => {
  // arc 시작점/끝점 1km 차이를 30초에 → 120 km/h. 평균속도 산식이 맞는지 확인용.
  const lineCode = '2';

  it('양 끝 sample이 같은 line + arcM → mapMatchedKmh 산출', () => {
    const now = 60_000;
    const series = [
      point({
        ts: 30_000,
        lat: 37.5,
        lng: 127.0,
        accuracy: 5,
        mapMatchedLine: lineCode,
        mapMatchedArcM: 0,
      }),
      point({
        ts: 60_000,
        lat: 37.502,
        lng: 127.0,
        accuracy: 5,
        mapMatchedLine: lineCode,
        mapMatchedArcM: 1000,
      }),
    ];
    const m = evaluateWindow(series, now);
    // |1000 - 0| / 30s = 33.33 m/s → 120 km/h
    expect(m.mapMatchedKmh).toBeCloseTo(120, 0);
  });

  it('한쪽 sample에 mapMatchedLine 없으면 mapMatchedKmh=null (Phase 1 회귀 없음)', () => {
    const now = 60_000;
    const series = [
      point({ ts: 30_000, lat: 37.5, lng: 127.0, accuracy: 5 }),
      point({
        ts: 60_000,
        lat: 37.502,
        lng: 127.0,
        accuracy: 5,
        mapMatchedLine: lineCode,
        mapMatchedArcM: 1000,
      }),
    ];
    expect(evaluateWindow(series, now).mapMatchedKmh).toBeNull();
  });

  it('환승역 disambiguate — 두 sample line이 다르면 null (다른 노선 점프 차단)', () => {
    const now = 60_000;
    const series = [
      point({
        ts: 30_000,
        lat: 37.5,
        lng: 127.0,
        accuracy: 5,
        mapMatchedLine: '2',
        mapMatchedArcM: 100,
      }),
      point({
        ts: 60_000,
        lat: 37.5,
        lng: 127.0,
        accuracy: 5,
        mapMatchedLine: '3',
        mapMatchedArcM: 200,
      }),
    ];
    expect(evaluateWindow(series, now).mapMatchedKmh).toBeNull();
  });

  it('역방향 진행(end.arcM < start.arcM)도 |Δarc|로 산출', () => {
    const now = 60_000;
    const series = [
      point({
        ts: 30_000,
        lat: 37.5,
        lng: 127.0,
        accuracy: 5,
        mapMatchedLine: lineCode,
        mapMatchedArcM: 1000,
      }),
      point({
        ts: 60_000,
        lat: 37.498,
        lng: 127.0,
        accuracy: 5,
        mapMatchedLine: lineCode,
        mapMatchedArcM: 0,
      }),
    ];
    const m = evaluateWindow(series, now);
    expect(m.mapMatchedKmh).toBeCloseTo(120, 0);
  });

  it('Δarc=0 → null (정지 sample은 mapMatched 신호 없음)', () => {
    const now = 60_000;
    const series = [
      point({
        ts: 30_000,
        lat: 37.5,
        lng: 127.0,
        accuracy: 5,
        mapMatchedLine: lineCode,
        mapMatchedArcM: 500,
      }),
      point({
        ts: 60_000,
        lat: 37.5,
        lng: 127.0,
        accuracy: 5,
        mapMatchedLine: lineCode,
        mapMatchedArcM: 500,
      }),
    ];
    expect(evaluateWindow(series, now).mapMatchedKmh).toBeNull();
  });

  it('빈 윈도우 → mapMatchedKmh=null', () => {
    expect(evaluateWindow([], 0).mapMatchedKmh).toBeNull();
  });
});

describe('positionSeries — readSeries map matching field validation', () => {
  it('mapMatchedLine + arcM 짝이 있는 sample은 정상 복원', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const valid: PositionPoint = {
      lat: 37.5,
      lng: 127.0,
      accuracy: 5,
      ts: 1000,
      motion: 'automotive',
      mapMatchedLine: '2',
      mapMatchedArcM: 1234,
    };
    await appendPositionPoint(kv, 'tok', valid);
    const series = await readSeries(kv, 'tok');
    expect(series).toEqual([valid]);
  });

  it('mapMatchedLine만 있고 arcM 누락된 sample은 filter됨 (짝 정책)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const bad = JSON.stringify([
      {
        lat: 37.5,
        lng: 127.0,
        accuracy: 5,
        ts: 1000,
        motion: 'walking',
        mapMatchedLine: '2',
        // arcM 누락
      },
    ]);
    await kv.put('pos:tok', bad);
    expect(await readSeries(kv, 'tok')).toEqual([]);
  });

  it('mapMatchedArcM 타입 잘못된 sample은 filter됨', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const bad = JSON.stringify([
      {
        lat: 37.5,
        lng: 127.0,
        accuracy: 5,
        ts: 1000,
        motion: 'walking',
        mapMatchedLine: '2',
        mapMatchedArcM: 'nope',
      },
    ]);
    await kv.put('pos:tok', bad);
    expect(await readSeries(kv, 'tok')).toEqual([]);
  });

  it('mapMatchedLine 타입 잘못된 sample은 filter됨', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const bad = JSON.stringify([
      {
        lat: 37.5,
        lng: 127.0,
        accuracy: 5,
        ts: 1000,
        motion: 'walking',
        mapMatchedLine: 99,
        mapMatchedArcM: 100,
      },
    ]);
    await kv.put('pos:tok', bad);
    expect(await readSeries(kv, 'tok')).toEqual([]);
  });
});

describe('positionSeries — nearestStationDistanceM field validation (#825)', () => {
  it('nearestStationDistanceM 정상값(양수 finite) → series에 정상 적재', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const valid: PositionPoint = {
      lat: 37.5,
      lng: 127.0,
      accuracy: 5,
      ts: 1000,
      motion: 'automotive',
      nearestStationDistanceM: 150,
    };
    await appendPositionPoint(kv, 'tok', valid);
    const series = await readSeries(kv, 'tok');
    expect(series).toEqual([valid]);
    expect(series[0].nearestStationDistanceM).toBe(150);
  });

  it('nearestStationDistanceM=0 → 정상 적재 (0m도 유효)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const raw = JSON.stringify([
      { lat: 37.5, lng: 127.0, accuracy: 5, ts: 1000, motion: 'walking', nearestStationDistanceM: 0 },
    ]);
    await kv.put('pos:tok', raw);
    const series = await readSeries(kv, 'tok');
    expect(series).toHaveLength(1);
    expect(series[0].nearestStationDistanceM).toBe(0);
  });

  it('nearestStationDistanceM 음수 → filter됨 (haversine 거리는 항상 ≥ 0)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const raw = JSON.stringify([
      { lat: 37.5, lng: 127.0, accuracy: 5, ts: 1000, motion: 'walking', nearestStationDistanceM: -1 },
    ]);
    await kv.put('pos:tok', raw);
    expect(await readSeries(kv, 'tok')).toEqual([]);
  });

  it('nearestStationDistanceM=NaN → filter됨', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const raw = JSON.stringify([
      { lat: 37.5, lng: 127.0, accuracy: 5, ts: 1000, motion: 'walking', nearestStationDistanceM: NaN },
    ]);
    await kv.put('pos:tok', raw);
    expect(await readSeries(kv, 'tok')).toEqual([]);
  });

  it('nearestStationDistanceM=Infinity → filter됨', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const raw = JSON.stringify([
      { lat: 37.5, lng: 127.0, accuracy: 5, ts: 1000, motion: 'walking', nearestStationDistanceM: Infinity },
    ]);
    await kv.put('pos:tok', raw);
    expect(await readSeries(kv, 'tok')).toEqual([]);
  });

  it('nearestStationDistanceM 문자열 타입 → filter됨', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const raw = JSON.stringify([
      { lat: 37.5, lng: 127.0, accuracy: 5, ts: 1000, motion: 'walking', nearestStationDistanceM: '100' },
    ]);
    await kv.put('pos:tok', raw);
    expect(await readSeries(kv, 'tok')).toEqual([]);
  });

  it('nearestStationDistanceM 필드 없음(undefined) → 정상 적재 (옵션 필드)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const raw = JSON.stringify([
      { lat: 37.5, lng: 127.0, accuracy: 5, ts: 1000, motion: 'walking' },
    ]);
    await kv.put('pos:tok', raw);
    const series = await readSeries(kv, 'tok');
    expect(series).toHaveLength(1);
    expect(series[0].nearestStationDistanceM).toBeUndefined();
  });
});

describe('positionSeries — currentStationName field validation (#1363)', () => {
  it('currentStationName 정상값(비어있지 않은 string) → series에 정상 적재', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const raw = JSON.stringify([
      { lat: 37.5, lng: 127.0, accuracy: 5, ts: 1000, motion: 'walking', currentStationName: '강남' },
    ]);
    await kv.put('pos:tok', raw);
    const series = await readSeries(kv, 'tok');
    expect(series).toHaveLength(1);
    expect(series[0].currentStationName).toBe('강남');
  });

  it('빈 문자열 → filter됨 (graceful 거부 — 의미 없는 라벨)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const raw = JSON.stringify([
      { lat: 37.5, lng: 127.0, accuracy: 5, ts: 1000, motion: 'walking', currentStationName: '' },
    ]);
    await kv.put('pos:tok', raw);
    const series = await readSeries(kv, 'tok');
    expect(series).toHaveLength(0);
  });

  it('non-string 타입 → filter됨', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const raw = JSON.stringify([
      { lat: 37.5, lng: 127.0, accuracy: 5, ts: 1000, motion: 'walking', currentStationName: 123 },
    ]);
    await kv.put('pos:tok', raw);
    const series = await readSeries(kv, 'tok');
    expect(series).toHaveLength(0);
  });

  it('필드 부재 → 정상 적재 (옵션)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const raw = JSON.stringify([
      { lat: 37.5, lng: 127.0, accuracy: 5, ts: 1000, motion: 'walking' },
    ]);
    await kv.put('pos:tok', raw);
    const series = await readSeries(kv, 'tok');
    expect(series).toHaveLength(1);
    expect(series[0].currentStationName).toBeUndefined();
  });
});

describe('positionSeries — cellularEnvironmentVote field validation (#1543)', () => {
  it.each(['surface', 'underground', 'unknown'] as const)(
    'enum %s → series에 정상 적재',
    async (vote) => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      const raw = JSON.stringify([
        {
          lat: 37.5,
          lng: 127.0,
          accuracy: 5,
          ts: 1000,
          motion: 'walking',
          cellularEnvironmentVote: vote,
        },
      ]);
      await kv.put('pos:tok', raw);
      const series = await readSeries(kv, 'tok');
      expect(series).toHaveLength(1);
      expect(series[0].cellularEnvironmentVote).toBe(vote);
    },
  );

  it('enum 외 값 → series에서 filter됨 (정합성 보장)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const raw = JSON.stringify([
      {
        lat: 37.5,
        lng: 127.0,
        accuracy: 5,
        ts: 1000,
        motion: 'walking',
        cellularEnvironmentVote: 'mars',
      },
    ]);
    await kv.put('pos:tok', raw);
    const series = await readSeries(kv, 'tok');
    expect(series).toHaveLength(0);
  });

  it('필드 부재 → 정상 적재 (옵션)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const raw = JSON.stringify([
      { lat: 37.5, lng: 127.0, accuracy: 5, ts: 1000, motion: 'walking' },
    ]);
    await kv.put('pos:tok', raw);
    const series = await readSeries(kv, 'tok');
    expect(series).toHaveLength(1);
    expect(series[0].cellularEnvironmentVote).toBeUndefined();
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
