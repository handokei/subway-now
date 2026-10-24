import {
  GRAVITY_MS2,
  MIN_SAMPLES_FOR_SUMMARY,
  removeGravity,
  summarizeLinear,
  summarizeWindow,
  toSiSamples,
  type AccelSample,
} from '../accelMotion';

function rawSampleAt(t: number, x: number, y: number, z: number): AccelSample {
  return { t, x, y, z };
}

describe('toSiSamples', () => {
  it('빈 배열 → 빈 배열', () => {
    expect(toSiSamples([])).toEqual([]);
  });

  it('g 단위를 m/s²로 변환 (timestamp는 그대로)', () => {
    const raw = [{ t: 100, x: 1, y: 0, z: -1 }];
    const out = toSiSamples(raw);
    expect(out[0].t).toBe(100);
    expect(out[0].x).toBeCloseTo(GRAVITY_MS2);
    expect(out[0].y).toBeCloseTo(0);
    expect(out[0].z).toBeCloseTo(-GRAVITY_MS2);
  });
});

describe('removeGravity', () => {
  it('빈 배열 → 빈 배열', () => {
    expect(removeGravity([])).toEqual([]);
  });

  it('window 평균을 중력으로 간주해 빼면, 평균은 ≈ 0', () => {
    const samples: AccelSample[] = [
      rawSampleAt(0, 1, 2, 9),
      rawSampleAt(1, 3, 2, 11),
      rawSampleAt(2, 2, 2, 10),
    ];
    const linear = removeGravity(samples);
    const meanX = linear.reduce((a, s) => a + s.x, 0) / linear.length;
    const meanY = linear.reduce((a, s) => a + s.y, 0) / linear.length;
    const meanZ = linear.reduce((a, s) => a + s.z, 0) / linear.length;
    expect(meanX).toBeCloseTo(0);
    expect(meanY).toBeCloseTo(0);
    expect(meanZ).toBeCloseTo(0);
    expect(linear[0].t).toBe(0);
  });

  it('각 sample은 (원본 - window평균)이어야 함', () => {
    const samples: AccelSample[] = [
      rawSampleAt(0, 0, 0, 0),
      rawSampleAt(1, 2, 4, 6),
    ];
    // 평균 (1,2,3) → linear: (-1,-2,-3), (1,2,3)
    const linear = removeGravity(samples);
    expect(linear[0]).toEqual({ t: 0, x: -1, y: -2, z: -3 });
    expect(linear[1]).toEqual({ t: 1, x: 1, y: 2, z: 3 });
  });
});

describe('summarizeLinear', () => {
  it('MIN_SAMPLES 미달 → null', () => {
    const linear: AccelSample[] = [];
    for (let i = 0; i < MIN_SAMPLES_FOR_SUMMARY - 1; i++) {
      linear.push(rawSampleAt(i, 0, 0, 0));
    }
    expect(summarizeLinear(linear)).toBeNull();
  });

  it('상수 magnitude window → mean=상수, std=0, peak=상수', () => {
    const linear: AccelSample[] = [];
    // (3,4,0) → magnitude 5. 60개 sample.
    for (let i = 0; i < 60; i++) {
      linear.push(rawSampleAt(i, 3, 4, 0));
    }
    const s = summarizeLinear(linear);
    expect(s).not.toBeNull();
    expect(s!.count).toBe(60);
    expect(s!.startTs).toBe(0);
    expect(s!.endTs).toBe(59);
    expect(s!.ax).toBeCloseTo(3);
    expect(s!.ay).toBeCloseTo(4);
    expect(s!.az).toBeCloseTo(0);
    expect(s!.magnitudeMean).toBeCloseTo(5);
    expect(s!.magnitudeStd).toBeCloseTo(0);
    expect(s!.magnitudePeak).toBeCloseTo(5);
  });

  it('변화하는 magnitude → mean/std/peak 정합', () => {
    const linear: AccelSample[] = [];
    // 절반은 (1,0,0) magnitude 1, 절반은 (3,0,0) magnitude 3 → mean=2 std=1 peak=3
    for (let i = 0; i < 30; i++) linear.push(rawSampleAt(i, 1, 0, 0));
    for (let i = 30; i < 60; i++) linear.push(rawSampleAt(i, 3, 0, 0));
    const s = summarizeLinear(linear)!;
    expect(s.magnitudeMean).toBeCloseTo(2);
    expect(s.magnitudeStd).toBeCloseTo(1);
    expect(s.magnitudePeak).toBeCloseTo(3);
  });
});

describe('summarizeWindow (pipeline)', () => {
  it('MIN_SAMPLES 미달 → null', () => {
    const raw = [{ t: 0, x: 0, y: 0, z: 1 }];
    expect(summarizeWindow(raw)).toBeNull();
  });

  it('정지 상태 (모든 sample 동일) → 중력 제거 후 magnitude≈0', () => {
    // 60개 sample, 모두 (0g, 0g, 1g) — 중력 외 가속도 없음.
    const raw = Array.from({ length: 60 }, (_, i) => ({ t: i, x: 0, y: 0, z: 1 }));
    const s = summarizeWindow(raw)!;
    expect(s.count).toBe(60);
    expect(s.magnitudeMean).toBeCloseTo(0);
    expect(s.magnitudeStd).toBeCloseTo(0);
    expect(s.magnitudePeak).toBeCloseTo(0);
  });

  it('흔들리는 window → 중력 제거 후에도 magnitude > 0', () => {
    const raw: { t: number; x: number; y: number; z: number }[] = [];
    // x축이 ±0.5g 진폭으로 흔들리는 패턴 (지하철 출발 가속 근사)
    for (let i = 0; i < 60; i++) {
      raw.push({ t: i, x: i % 2 === 0 ? 0.5 : -0.5, y: 0, z: 1 });
    }
    const s = summarizeWindow(raw)!;
    // 중력 제거 후 x=±0.5g, m/s² 변환하면 magnitude ≈ 0.5*GRAVITY_MS2.
    expect(s.magnitudeMean).toBeCloseTo(0.5 * GRAVITY_MS2, 1);
    expect(s.magnitudeStd).toBeCloseTo(0);
    expect(s.magnitudePeak).toBeCloseTo(0.5 * GRAVITY_MS2, 1);
  });
});
