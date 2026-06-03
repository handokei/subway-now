import { describe, expect, it } from 'vitest';
import { fusedSpeed } from '../fusedSpeed';

describe('fusedSpeed (#819)', () => {
  it('stationary motion → speed=0 confidence=high (다른 신호 무시)', () => {
    const r = fusedSpeed({
      gpsAvgKmh: 50,
      gpsAccuracyMeters: 10,
      motion: 'stationary',
      mapMatchedKmh: null,
    });
    expect(r).toEqual({ speed: 0, confidence: 'high' });
  });

  it.each([
    // GPS only: 10m → weight 0.7 (medium), 25m → 0.5 (medium), 70m → 0.2 (low), 150m → 0 (low).
    // Phase 1 단독에서는 'high'(totalW≥1.0)는 mapMatchedKmh 없이 도달 불가 — Phase 2 합류 케이스는
    // 별도 mapMatchedKmh 테스트에서 검증.
    [10, 'medium'],
    [25, 'medium'],
    [70, 'low'],
    [150, 'low'],
  ] as const)(
    'GPS 정확도 %dm (GPS-only) → confidence=%s',
    (acc, confidence) => {
      const r = fusedSpeed({
        gpsAvgKmh: 30,
        gpsAccuracyMeters: acc,
        motion: 'walking',
        mapMatchedKmh: null,
      });
      expect(r.confidence).toBe(confidence);
    },
  );

  it('GPS accuracy ≥ 100m + mapMatchedKmh null → totalW=0 speed=0 confidence=low', () => {
    const r = fusedSpeed({
      gpsAvgKmh: 30,
      gpsAccuracyMeters: 200,
      motion: 'walking',
      mapMatchedKmh: null,
    });
    expect(r).toEqual({ speed: 0, confidence: 'low' });
  });

  it('walking motion → 최대 10 km/h로 clamp', () => {
    const r = fusedSpeed({
      gpsAvgKmh: 30,
      gpsAccuracyMeters: 10,
      motion: 'walking',
      mapMatchedKmh: null,
    });
    expect(r.speed).toBe(10);
  });

  it('automotive motion → 최소 5 km/h로 floor (저속 GPS 보정)', () => {
    const r = fusedSpeed({
      gpsAvgKmh: 1,
      gpsAccuracyMeters: 10,
      motion: 'automotive',
      mapMatchedKmh: null,
    });
    expect(r.speed).toBe(5);
  });

  it('unknown motion → clamp 없이 raw 값 그대로', () => {
    const r = fusedSpeed({
      gpsAvgKmh: 25,
      gpsAccuracyMeters: 10,
      motion: 'unknown',
      mapMatchedKmh: null,
    });
    expect(r.speed).toBeCloseTo(25, 5);
  });

  it('mapMatchedKmh 있을 때 가중 평균 fusion (Phase 2 합류 검증)', () => {
    // gpsWeight 0.7 (10m) + mapWeight 0.5 = 1.2 → confidence high
    // raw = (30*0.7 + 40*0.5)/1.2 = 41/1.2 ≈ 34.17
    const r = fusedSpeed({
      gpsAvgKmh: 30,
      gpsAccuracyMeters: 10,
      motion: 'unknown',
      mapMatchedKmh: 40,
    });
    expect(r.speed).toBeCloseTo(34.166, 2);
    expect(r.confidence).toBe('high');
  });

  it('totalW ≥ 1 → high, ≥ 0.5 → medium, < 0.5 → low', () => {
    // GPS only accuracy 25m → weight 0.5 → totalW=0.5 → medium
    const med = fusedSpeed({
      gpsAvgKmh: 20,
      gpsAccuracyMeters: 25,
      motion: 'walking',
      mapMatchedKmh: null,
    });
    expect(med.confidence).toBe('medium');
    // GPS 80m → weight 0.2 → totalW=0.2 → low
    const low = fusedSpeed({
      gpsAvgKmh: 20,
      gpsAccuracyMeters: 80,
      motion: 'walking',
      mapMatchedKmh: null,
    });
    expect(low.confidence).toBe('low');
  });
});
