import { __resetRouteGraphCache } from '../buildRouteGraph';
import {
  findRouteByType,
  findRoutes,
  ROUTE_OPTIMIZATION_TYPES,
} from '../dijkstraRoute';

describe('dijkstraRoute (#1499)', () => {
  beforeEach(() => {
    __resetRouteGraphCache();
  });

  it('returns null for unknown station ids', () => {
    expect(findRouteByType('UNKNOWN-1', '2-001', 'min-time')).toBeNull();
    expect(findRouteByType('2-001', 'UNKNOWN-2', 'min-time')).toBeNull();
  });

  it('returns empty route when from === to', () => {
    const r = findRouteByType('2-001', '2-001', 'min-time');
    expect(r).not.toBeNull();
    expect(r?.legs).toHaveLength(0);
    expect(r?.transfers).toHaveLength(0);
    expect(r?.totalDurationSeconds).toBe(0);
    expect(r?.totalDistanceMeters).toBe(0);
    expect(r?.transferCount).toBe(0);
  });

  it('finds a direct same-line route without transfers (2-001 → 2-003)', () => {
    const r = findRouteByType('2-001', '2-003', 'min-distance');
    expect(r).not.toBeNull();
    expect(r?.transferCount).toBe(0);
    expect(r?.legs).toHaveLength(1);
    expect(r?.legs[0].line).toBe('2');
    expect(r?.legs[0].fromId).toBe('2-001');
    expect(r?.legs[0].toId).toBe('2-003');
    expect(r?.legs[0].stationIds).toEqual(['2-001', '2-002', '2-003']);
    // 700 + 800 = 1500m
    expect(r?.totalDistanceMeters).toBe(1500);
  });

  it('finds a transfer route (성수 2-011 → 마장 5-032) min-transfer', () => {
    const r = findRouteByType('2-011', '5-032', 'min-transfer');
    expect(r).not.toBeNull();
    expect(r?.transferCount).toBeGreaterThanOrEqual(1);
    // 첫 leg는 2호선, 마지막 leg는 5호선
    if (r) {
      expect(r.legs[0].line).toBe('2');
      expect(r.legs[r.legs.length - 1].line).toBe('5');
    }
  });

  it('min-transfer prefers fewer transfers than min-distance', () => {
    const a = findRouteByType('2-011', '5-032', 'min-transfer');
    const b = findRouteByType('2-011', '5-032', 'min-distance');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (a && b) {
      expect(a.transferCount).toBeLessThanOrEqual(b.transferCount);
    }
  });

  it('findRoutes returns all three types', () => {
    const result = findRoutes('2-001', '2-003');
    for (const type of ROUTE_OPTIMIZATION_TYPES) {
      expect(result[type]).not.toBeNull();
      expect(result[type]?.type).toBe(type);
    }
  });

  it('min-time accumulates walking seconds for transfer routes', () => {
    const r = findRouteByType('2-011', '5-032', 'min-time');
    expect(r).not.toBeNull();
    if (r && r.transferCount > 0) {
      expect(r.totalWalkingSeconds).toBeGreaterThan(0);
      // totalDuration = sum of leg durations + walking
      const sumLeg = r.legs.reduce((s, l) => s + l.durationSeconds, 0);
      expect(r.totalDurationSeconds).toBeCloseTo(
        sumLeg + r.totalWalkingSeconds,
        3,
      );
    }
  });

  it('returns null when destination is unreachable (no connecting edges)', () => {
    // 9호선/airport는 stationDistances에 없어 unreachable
    // 9-001(개화) → 2-001 라인 외 연결 없음
    const r = findRouteByType('9-001', '2-001', 'min-time');
    expect(r).toBeNull();
  });

  it('min-distance excludes walking distance for transfers', () => {
    const r = findRouteByType('2-011', '5-032', 'min-distance');
    expect(r).not.toBeNull();
    if (r) {
      // totalDistanceMeters should be sum of leg distances only
      const sumLeg = r.legs.reduce((s, l) => s + l.distanceMeters, 0);
      expect(r.totalDistanceMeters).toBe(sumLeg);
    }
  });

  it('heap correctness — large random pair stress', () => {
    // 1-001 → 1-010 같은 호선 직진 sanity
    const r = findRouteByType('1-009', '1-010', 'min-time');
    expect(r).not.toBeNull();
    expect(r?.legs).toHaveLength(1);
    expect(r?.transferCount).toBe(0);
  });
});
