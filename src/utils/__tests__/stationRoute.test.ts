import { getStationsOnLine, getRemainingStops } from '../stationRoute';

describe('getStationsOnLine', () => {
  it('returns only stations on the given line, sorted by id', () => {
    const line1 = getStationsOnLine('1');
    expect(line1.length).toBeGreaterThan(0);
    line1.forEach((s) => expect(s.line).toBe('1'));
    for (let i = 1; i < line1.length; i++) {
      expect(line1[i - 1].id.localeCompare(line1[i].id)).toBeLessThan(0);
    }
  });

  it('returns empty array for unknown line', () => {
    expect(getStationsOnLine('999')).toEqual([]);
  });
});

describe('getRemainingStops', () => {
  it('returns 0 when current and destination are the same station', () => {
    expect(getRemainingStops('1-001', '1-001')).toBe(0);
  });

  it('returns correct count in forward direction', () => {
    // 1-001(소요산) → 1-003(보산): 2 stops
    expect(getRemainingStops('1-001', '1-003')).toBe(2);
  });

  it('returns correct count in reverse direction', () => {
    // 1-003(보산) → 1-001(소요산): 2 stops
    expect(getRemainingStops('1-003', '1-001')).toBe(2);
  });

  it('returns null when stations are on different lines', () => {
    const line1 = getStationsOnLine('1')[0];
    const line2 = getStationsOnLine('2')[0];
    expect(getRemainingStops(line1.id, line2.id)).toBeNull();
  });

  it('returns null for unknown station id', () => {
    expect(getRemainingStops('1-001', 'unknown-id')).toBeNull();
    expect(getRemainingStops('unknown-id', '1-001')).toBeNull();
  });
});
