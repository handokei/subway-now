import { estimateEtaSeconds, distanceMetersBetween } from '../stationEta';

describe('estimateEtaSeconds', () => {
  it('returns null when speed is null', () => {
    expect(estimateEtaSeconds(100, null)).toBeNull();
  });

  it('returns null when speed is below minimum (< 0.5 m/s)', () => {
    expect(estimateEtaSeconds(100, 0)).toBeNull();
    expect(estimateEtaSeconds(100, 0.4)).toBeNull();
    expect(estimateEtaSeconds(100, -1)).toBeNull();
  });

  it('computes eta when speed >= 0.5 m/s (역 진입 감속 구간 포함)', () => {
    expect(estimateEtaSeconds(100, 10)).toBe(10);
    expect(estimateEtaSeconds(50, 5)).toBe(10);
    expect(estimateEtaSeconds(0, 5)).toBe(0);
    expect(estimateEtaSeconds(5, 0.5)).toBe(10);
  });

  it('matches typical subway speed', () => {
    // 200m at 20 m/s (72 km/h) → 10s
    expect(estimateEtaSeconds(200, 20)).toBe(10);
  });
});

describe('distanceMetersBetween', () => {
  it('returns 0 for identical coords', () => {
    expect(distanceMetersBetween(37.5, 127.0, 37.5, 127.0)).toBe(0);
  });

  it('returns positive distance for different coords', () => {
    // 강남(37.4980, 127.0278) <-> 역삼(37.5006, 127.0364) — 약 800m
    const d = distanceMetersBetween(37.4980, 127.0278, 37.5006, 127.0364);
    expect(d).toBeGreaterThan(500);
    expect(d).toBeLessThan(1200);
  });
});
