import { describe, expect, it } from 'vitest';
import {
  ACCURACY_CUTOFF_M,
  ARC_OVERSHOOT_MIN_ARC_DELTA_M,
  ARC_OVERSHOOT_RATIO_DEFAULT,
  appendPositionPoint,
  clearSeries,
  cosineDirection,
  detectArcOvershoot,
  evaluateWindow,
  haversineKm,
  pickMotionMode,
  POSITION_SERIES_WRITE_MIN_INTERVAL_MS,
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
    // write throttle(POSITION_SERIES_WRITE_MIN_INTERVAL_MS) 간격보다 넉넉히 벌려서
    // 매 point가 실제로 write되도록 함 (ring-trim 자체를 검증하는 테스트).
    const kv = new InMemoryKV() as unknown as KVNamespace;
    for (let i = 0; i < 40; i++) {
      await appendPositionPoint(kv, 'tok', point({ ts: i * 40_000 }));
    }
    const series = await readSeries(kv, 'tok');
    expect(series).toHaveLength(30);
    expect(series[0].ts).toBe(10 * 40_000);
    expect(series[29].ts).toBe(39 * 40_000);
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

describe('appendPositionPoint — write throttle (KV quota #2439-ish)', () => {
  it('cold start(series 비어있음)는 항상 write', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const series = await appendPositionPoint(kv, 'tok', point({ ts: 1000 }));
    expect(series).toHaveLength(1);
    expect(await readSeries(kv, 'tok')).toHaveLength(1);
  });

  it('간격 미달(직전 point 대비 interval 미만) → put skip, 메모리 append도 skip', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await appendPositionPoint(kv, 'tok', point({ ts: 0 }));
    const result = await appendPositionPoint(
      kv,
      'tok',
      point({ ts: POSITION_SERIES_WRITE_MIN_INTERVAL_MS - 1 }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].ts).toBe(0);
    const persisted = await readSeries(kv, 'tok');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].ts).toBe(0);
  });

  it('간격 충족(정확히 interval) → write 진행', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await appendPositionPoint(kv, 'tok', point({ ts: 0 }));
    const result = await appendPositionPoint(
      kv,
      'tok',
      point({ ts: POSITION_SERIES_WRITE_MIN_INTERVAL_MS }),
    );
    expect(result).toHaveLength(2);
    const persisted = await readSeries(kv, 'tok');
    expect(persisted).toHaveLength(2);
  });

  it('역행/동시 ts(clock skew) → skip (throttle과 동일 취급)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await appendPositionPoint(kv, 'tok', point({ ts: 100_000 }));
    const result = await appendPositionPoint(kv, 'tok', point({ ts: 50_000 }));
    expect(result).toHaveLength(1);
    expect(result[0].ts).toBe(100_000);
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

describe('detectArcOvershoot (#2023 arc time-integration overshoot guard)', () => {
  /**
   * arc 델타 vs 실제 haversine 이동 거리 비율로 device 시간 적분 폭주 감지.
   *
   * 2026-07-03 evidence 재현: device velocity=0 판단인데 arc가 시간 적분으로 계속 누적 →
   * 성수 조기 발사. arc 델타 > haversine × 2 시 overshoot=true.
   *
   * 정책: series 부족 / arc 미부착 / 낮은 arc 델타는 false (graceful, false positive 차단).
   */

  const line = '2';

  function makeSeries(
    start: { arcM: number; lat: number; lng: number; ts: number },
    end: { arcM: number; lat: number; lng: number; ts: number },
  ): PositionPoint[] {
    return [
      {
        lat: start.lat,
        lng: start.lng,
        accuracy: 10,
        ts: start.ts,
        motion: 'walking',
        mapMatchedLine: line,
        mapMatchedArcM: start.arcM,
      },
      {
        lat: end.lat,
        lng: end.lng,
        accuracy: 10,
        ts: end.ts,
        motion: 'walking',
        mapMatchedLine: line,
        mapMatchedArcM: end.arcM,
      },
    ];
  }

  it('arc 델타 > haversine × 2 → overshoot=true (오늘 evidence 재현)', () => {
    // 2026-07-03 evidence: 08:32:45 arc=3998 → 08:37:25 arc=4710 (Δ=712m)
    // 실 이동 haversine ≈ 100m (사용자 정지 판단 상태에서 device 시간 적분만 증가)
    // 712 / 100 = 7.12배 → overshoot=true (ratio 2 초과)
    const series = makeSeries(
      { arcM: 3998, lat: 37.5, lng: 127.0, ts: 0 },
      { arcM: 4710, lat: 37.5009, lng: 127.0, ts: 4 * 60_000 + 40_000 },
    );
    expect(detectArcOvershoot(series)).toBe(true);
  });

  it('arc 델타 ≈ haversine → overshoot=false (정상 이동)', () => {
    // 정상 이동: arc 델타와 haversine 거리 비슷.
    // ~200m 이동, arc 델타 200m (ratio ~1) → false
    const series = makeSeries(
      { arcM: 1000, lat: 37.5, lng: 127.0, ts: 0 },
      { arcM: 1200, lat: 37.5018, lng: 127.0, ts: 30_000 },
    );
    expect(detectArcOvershoot(series)).toBe(false);
  });

  it('arc 델타 = 0 → overshoot=false (변화 없음)', () => {
    // arc 델타 0이면 폭주 아님. (기존 mapMatchedKmh 정책과 정렬)
    const series = makeSeries(
      { arcM: 500, lat: 37.5, lng: 127.0, ts: 0 },
      { arcM: 500, lat: 37.5, lng: 127.0, ts: 30_000 },
    );
    expect(detectArcOvershoot(series)).toBe(false);
  });

  it('arc 델타 < min threshold → overshoot=false (신호 부족)', () => {
    // 작은 arc 델타는 GPS/arc 노이즈 범위 — 판단 유보.
    // ratio는 초과해도 절대값이 작으면 false positive 위험.
    const series = makeSeries(
      { arcM: 100, lat: 37.5, lng: 127.0, ts: 0 },
      { arcM: 100 + ARC_OVERSHOOT_MIN_ARC_DELTA_M - 1, lat: 37.5, lng: 127.0, ts: 30_000 },
    );
    expect(detectArcOvershoot(series)).toBe(false);
  });

  it('series 길이 < 2 → overshoot=false (graceful)', () => {
    expect(detectArcOvershoot([])).toBe(false);
    expect(
      detectArcOvershoot([
        {
          lat: 37.5,
          lng: 127.0,
          accuracy: 10,
          ts: 0,
          motion: 'walking',
          mapMatchedLine: line,
          mapMatchedArcM: 100,
        },
      ]),
    ).toBe(false);
  });

  it('arc 미부착 (mapMatchedArcM=undefined) → overshoot=false (graceful)', () => {
    // arc 없으면 판단 유보 (Phase 1 회귀 없음 정책과 정렬).
    const series: PositionPoint[] = [
      { lat: 37.5, lng: 127.0, accuracy: 10, ts: 0, motion: 'walking' },
      { lat: 37.501, lng: 127.0, accuracy: 10, ts: 30_000, motion: 'walking' },
    ];
    expect(detectArcOvershoot(series)).toBe(false);
  });

  it('한쪽만 arc 있음 → overshoot=false (짝 정책과 정렬)', () => {
    const series: PositionPoint[] = [
      {
        lat: 37.5,
        lng: 127.0,
        accuracy: 10,
        ts: 0,
        motion: 'walking',
        mapMatchedLine: line,
        mapMatchedArcM: 1000,
      },
      { lat: 37.501, lng: 127.0, accuracy: 10, ts: 30_000, motion: 'walking' },
    ];
    expect(detectArcOvershoot(series)).toBe(false);
  });

  it('환승역 disambiguate — 두 sample line이 다르면 false (mapMatchedKmh 정책과 정렬)', () => {
    // 노선이 다르면 arc 자체를 신뢰 X → 폭주 판단 유보.
    const series: PositionPoint[] = [
      {
        lat: 37.5,
        lng: 127.0,
        accuracy: 10,
        ts: 0,
        motion: 'walking',
        mapMatchedLine: '2',
        mapMatchedArcM: 1000,
      },
      {
        lat: 37.5,
        lng: 127.0,
        accuracy: 10,
        ts: 30_000,
        motion: 'walking',
        mapMatchedLine: '3',
        mapMatchedArcM: 5000,
      },
    ];
    expect(detectArcOvershoot(series)).toBe(false);
  });

  it('custom ratio threshold 지원 (더 엄격/느슨 config)', () => {
    // arc 델타 = 700m, haversine ≈ 200m → ratio ≈ 3.5
    const series = makeSeries(
      { arcM: 1000, lat: 37.5, lng: 127.0, ts: 0 },
      { arcM: 1700, lat: 37.5018, lng: 127.0, ts: 30_000 },
    );
    // 기본 ratio 2 → overshoot=true
    expect(detectArcOvershoot(series)).toBe(true);
    // 더 느슨한 ratio 5 → overshoot=false
    expect(detectArcOvershoot(series, { ratioThreshold: 5 })).toBe(false);
  });

  it('ARC_OVERSHOOT_RATIO_DEFAULT 상수 노출 (caller 참조용)', () => {
    expect(ARC_OVERSHOOT_RATIO_DEFAULT).toBeGreaterThan(1);
  });

  it('ARC_OVERSHOOT_MIN_ARC_DELTA_M 상수 노출 (caller 참조용)', () => {
    expect(ARC_OVERSHOOT_MIN_ARC_DELTA_M).toBeGreaterThan(0);
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
