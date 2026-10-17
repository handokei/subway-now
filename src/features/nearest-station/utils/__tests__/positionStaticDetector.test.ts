import {
  classifyPositionStability,
  STATIC_MIN_SAMPLES,
  STATIC_WINDOW_MS,
  type PositionSample,
} from '../positionStaticDetector';

const NOW = 10_000_000;

function sample(lat: number, lng: number, offsetMs: number): PositionSample {
  return { lat, lng, ts: NOW - offsetMs };
}

describe('classifyPositionStability', () => {
  it('빈 배열이면 unknown', () => {
    expect(classifyPositionStability([], NOW)).toBe('unknown');
  });

  it('minSamples 미만이면 unknown', () => {
    const samples: PositionSample[] = [
      sample(37.5756, 127.087, 30_000),
      sample(37.5756, 127.087, 0),
    ];
    expect(samples.length).toBeLessThan(STATIC_MIN_SAMPLES);
    expect(classifyPositionStability(samples, NOW)).toBe('unknown');
  });

  it('windowMs 안의 sample만 계산에 포함 — 오래된 sample은 제외', () => {
    const samples: PositionSample[] = [
      // 윈도우 밖
      sample(37.7, 127.5, STATIC_WINDOW_MS + 1_000),
      sample(37.7, 127.5, STATIC_WINDOW_MS + 2_000),
      // 윈도우 안
      sample(37.5756, 127.087, 50_000),
      sample(37.5756, 127.087, 30_000),
      sample(37.5756, 127.087, 0),
    ];
    expect(classifyPositionStability(samples, NOW)).toBe('static');
  });

  it('윈도우 안에 minSamples 모이고 시간 폭 충분하면 spread로 판정', () => {
    const samples: PositionSample[] = [
      sample(37.5756, 127.087, 50_000),
      sample(37.5757, 127.0871, 30_000),
      sample(37.5756, 127.087, 0),
    ];
    expect(classifyPositionStability(samples, NOW)).toBe('static');
  });

  it('spread가 maxDeltaM 초과면 moving', () => {
    const samples: PositionSample[] = [
      sample(37.5756, 127.087, 50_000),
      sample(37.58, 127.087, 30_000),
      sample(37.59, 127.087, 0),
    ];
    expect(classifyPositionStability(samples, NOW)).toBe('moving');
  });

  it('spread가 정확히 maxDeltaM 경계 내(50m)면 static', () => {
    // 위도 1° ≒ 111.0km. 50m = 0.00045°. 임계값 60m 이내.
    const offsetDeg = 50 / 1000 / 111;
    const samples: PositionSample[] = [
      sample(37.5756, 127.087, 50_000),
      sample(37.5756 + offsetDeg, 127.087, 30_000),
      sample(37.5756, 127.087, 0),
    ];
    expect(classifyPositionStability(samples, NOW)).toBe('static');
  });

  it('spread가 maxDeltaM 임계값 외(70m)면 moving', () => {
    const offsetDeg = 70 / 1000 / 111;
    const samples: PositionSample[] = [
      sample(37.5756, 127.087, 50_000),
      sample(37.5756 + offsetDeg, 127.087, 30_000),
      sample(37.5756, 127.087, 0),
    ];
    expect(classifyPositionStability(samples, NOW)).toBe('moving');
  });

  it('시간 폭이 windowMs * MIN_TIME_SPAN_RATIO 미만이면 unknown', () => {
    const samples: PositionSample[] = [
      sample(37.5756, 127.087, 5_000),
      sample(37.5756, 127.087, 4_000),
      sample(37.5756, 127.087, 3_000),
    ];
    expect(classifyPositionStability(samples, NOW)).toBe('unknown');
  });

  it('config로 임계값 override 가능 (윈도우/샘플/거리/타임스팬)', () => {
    const samples: PositionSample[] = [
      sample(37.5756, 127.087, 5_000),
      sample(37.5756, 127.087, 3_000),
      sample(37.5756, 127.087, 1_000),
    ];
    expect(
      classifyPositionStability(samples, NOW, {
        windowMs: 10_000,
        minSamples: 2,
        maxDeltaM: 10,
        minTimeSpanRatio: 0.1,
      }),
    ).toBe('static');
  });

  it('now 미지정 시 Date.now() 사용 — 신선한 sample이면 정상 판정', () => {
    const realNow = Date.now();
    const samples: PositionSample[] = [
      { lat: 37.5756, lng: 127.087, ts: realNow - 50_000 },
      { lat: 37.5756, lng: 127.087, ts: realNow - 30_000 },
      { lat: 37.5756, lng: 127.087, ts: realNow - 1_000 },
    ];
    expect(classifyPositionStability(samples)).toBe('static');
  });
});
