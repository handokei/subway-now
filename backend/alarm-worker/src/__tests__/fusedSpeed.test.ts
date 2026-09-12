import { describe, expect, it } from 'vitest';
import { KALMAN_WEIGHT, fusedSpeed } from '../fusedSpeed';

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

describe('fusedSpeed — Phase 3 Kalman 통합 (#824)', () => {
  it('kalmanKmh=undefined (미지정) → 기존 결과와 동일 (Phase 1/2 회귀 없음)', () => {
    // Phase 3 미적용 호출: kalmanKmh 미지정 → kalmanWeight=0 → 기존 가중치와 동일
    const withoutKalman = fusedSpeed({
      gpsAvgKmh: 30,
      gpsAccuracyMeters: 10,
      motion: 'unknown',
      mapMatchedKmh: null,
    });
    const withUndefined = fusedSpeed({
      gpsAvgKmh: 30,
      gpsAccuracyMeters: 10,
      motion: 'unknown',
      mapMatchedKmh: null,
      kalmanKmh: undefined,
    });
    expect(withUndefined).toEqual(withoutKalman);
  });

  it('kalmanKmh=null → kalmanWeight=0, 기존 결과와 동일', () => {
    const withNull = fusedSpeed({
      gpsAvgKmh: 30,
      gpsAccuracyMeters: 10,
      motion: 'unknown',
      mapMatchedKmh: null,
      kalmanKmh: null,
    });
    const withoutKalman = fusedSpeed({
      gpsAvgKmh: 30,
      gpsAccuracyMeters: 10,
      motion: 'unknown',
      mapMatchedKmh: null,
    });
    expect(withNull).toEqual(withoutKalman);
  });

  it('kalmanKmh 있을 때 가중치 합산 — GPS+Kalman → high confidence', () => {
    // GPS accuracy=10m → gpsWeight=0.7, mapMatched=null → mapWeight=0
    // kalmanKmh 있음 → kalmanWeight=KALMAN_WEIGHT=0.6
    // totalW = 0.7 + 0 + 0.6 = 1.3 → high confidence
    // raw = (30*0.7 + 0*0 + 35*0.6) / 1.3 = (21 + 0 + 21) / 1.3 ≈ 32.31
    const r = fusedSpeed({
      gpsAvgKmh: 30,
      gpsAccuracyMeters: 10,
      motion: 'unknown',
      mapMatchedKmh: null,
      kalmanKmh: 35,
    });
    expect(r.confidence).toBe('high'); // totalW=1.3 ≥ 1.0
    const expectedRaw = (30 * 0.7 + 35 * KALMAN_WEIGHT) / (0.7 + KALMAN_WEIGHT);
    expect(r.speed).toBeCloseTo(expectedRaw, 4);
  });

  it('kalmanKmh 단독 (GPS accuracy≥100m + mapMatched null) → gpsWeight=0, kalmanWeight=0.6 → medium', () => {
    // GPS accuracy=200m → gpsWeight=0, kalmanKmh 있음 → kalmanWeight=0.6
    // totalW = 0 + 0 + 0.6 = 0.6 → medium (0.5 ≤ totalW < 1.0)
    // raw = (gps*0 + 0*0 + kalman*0.6) / 0.6 = kalman
    const r = fusedSpeed({
      gpsAvgKmh: 5,
      gpsAccuracyMeters: 200,
      motion: 'unknown',
      mapMatchedKmh: null,
      kalmanKmh: 25,
    });
    expect(r.confidence).toBe('medium'); // 0.5 ≤ 0.6 < 1.0
    expect(r.speed).toBeCloseTo(25, 4); // Kalman만 영향
  });

  it('motion=stationary이면 kalmanKmh 있어도 speed=0 (early return)', () => {
    const r = fusedSpeed({
      gpsAvgKmh: 40,
      gpsAccuracyMeters: 10,
      motion: 'stationary',
      mapMatchedKmh: 50,
      kalmanKmh: 45,
    });
    expect(r).toEqual({ speed: 0, confidence: 'high' });
  });

  it('kalmanKmh + walking motion clamp (상한 10 km/h)', () => {
    // GPS 10m → 0.7, kalman → 0.6, totalW=1.3
    // raw = (60*0.7 + 80*0.6) / 1.3 ≈ 69.23 → clamp at 10 (walking)
    const r = fusedSpeed({
      gpsAvgKmh: 60,
      gpsAccuracyMeters: 10,
      motion: 'walking',
      mapMatchedKmh: null,
      kalmanKmh: 80,
    });
    expect(r.speed).toBe(10); // walking clamp
  });

  it('kalmanKmh + automotive motion floor (하한 5 km/h)', () => {
    // GPS=1 km/h, kalman=2 km/h → 매우 낮은 속도 → automotive clamp 5 km/h
    const r = fusedSpeed({
      gpsAvgKmh: 1,
      gpsAccuracyMeters: 10,
      motion: 'automotive',
      mapMatchedKmh: null,
      kalmanKmh: 2,
    });
    expect(r.speed).toBe(5); // automotive floor
  });

  it('GPS + mapMatched + kalman 3중 fusion → high confidence + 정확한 가중 평균', () => {
    // GPS 10m → 0.7, map → 0.5, kalman → 0.6, totalW=1.8 → high
    // raw = (30*0.7 + 40*0.5 + 35*0.6) / 1.8 = (21 + 20 + 21) / 1.8 = 62 / 1.8 ≈ 34.44
    const r = fusedSpeed({
      gpsAvgKmh: 30,
      gpsAccuracyMeters: 10,
      motion: 'unknown',
      mapMatchedKmh: 40,
      kalmanKmh: 35,
    });
    expect(r.confidence).toBe('high');
    const expectedRaw = (30 * 0.7 + 40 * 0.5 + 35 * KALMAN_WEIGHT) / (0.7 + 0.5 + KALMAN_WEIGHT);
    expect(r.speed).toBeCloseTo(expectedRaw, 4);
  });

  it('KALMAN_WEIGHT 상수값 검증 — 0.6', () => {
    expect(KALMAN_WEIGHT).toBe(0.6);
  });
});
