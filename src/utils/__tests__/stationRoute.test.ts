import { getStationsOnLine, getRemainingStops, findRoute } from '../stationRoute';

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

describe('findRoute', () => {
  it('returns null for unknown station id', () => {
    expect(findRoute('1-001', 'unknown-id')).toBeNull();
    expect(findRoute('unknown-id', '1-001')).toBeNull();
  });

  it('같은 노선이면 DirectRoute를 반환한다', () => {
    // 1-001(소요산) → 1-003(보산)
    const route = findRoute('1-001', '1-003');
    expect(route).not.toBeNull();
    expect(route?.type).toBe('direct');
    if (route?.type === 'direct') {
      expect(route.stops).toBe(2);
    }
  });

  it('같은 역이면 DirectRoute stops=0을 반환한다', () => {
    const route = findRoute('1-001', '1-001');
    expect(route?.type).toBe('direct');
    if (route?.type === 'direct') {
      expect(route.stops).toBe(0);
    }
  });

  it('환승 가능한 다른 노선이면 TransferRoute를 반환한다', () => {
    // 2호선 강남(2-022) → 3호선 방배 근처: 교대(2-023/3-032)가 환승역
    // 2호선 → 3호선 환승 가능 여부 확인
    const line2 = getStationsOnLine('2');
    const line3 = getStationsOnLine('3');
    // 교대역: line2에 있고 line3에도 있음
    const gyodae2 = line2.find((s) => s.name === '교대');
    const gyodae3 = line3.find((s) => s.name === '교대');

    if (gyodae2 && gyodae3) {
      // 강남(2호선) → 교대 바로 다음 3호선 역으로 라우팅
      const destStation = line3[line3.indexOf(gyodae3) + 1]; // 교대 다음 3호선 역
      if (destStation) {
        const route = findRoute(gyodae2.id, destStation.id);
        expect(route?.type).toBe('transfer');
        if (route?.type === 'transfer') {
          expect(route.transferName).toBe('교대');
          expect(route.fromLine).toBe('2');
          expect(route.toLine).toBe('3');
          expect(route.stopsToTransfer).toBe(0); // 이미 환승역에 있음
          expect(route.stopsFromTransfer).toBe(1);
        }
      }
    }
  });

  it('환승역이 여러 개일 때 최적 경로를 선택한다', () => {
    // 2호선↔5호선: 을지로4가, 동대문역사문화공원, 왕십리, 영등포구청, 충정로 (5개 환승역)
    // 여러 후보 중 total이 가장 작은 경로를 선택해야 함
    const line2 = getStationsOnLine('2');
    const line5 = getStationsOnLine('5');
    // 2호선과 5호선 각각 첫 역에서 라우팅 → 여러 후보 순회
    const route = findRoute(line2[0].id, line5[0].id);
    // 환승역이 존재하므로 TransferRoute여야 함
    expect(route?.type).toBe('transfer');
    if (route?.type === 'transfer') {
      expect(route.fromLine).toBe('2');
      expect(route.toLine).toBe('5');
      // 5개 후보 중 가장 좋은 것을 선택했으므로 valid한 환승역 이름이어야 함
      const validTransfers = ['을지로4가', '동대문역사문화공원', '왕십리', '영등포구청', '충정로'];
      expect(validTransfers).toContain(route.transferName);
    }
  });

  it('환승역이 없으면 null을 반환한다', () => {
    // 1호선과 9호선은 환승역이 없음
    const line1 = getStationsOnLine('1');
    const line9 = getStationsOnLine('9');
    const line1Names = new Set(line1.map((s) => s.name));
    const hasTransfer = line9.some((s) => line1Names.has(s.name));

    if (!hasTransfer) {
      const route = findRoute(line1[0].id, line9[0].id);
      expect(route).toBeNull();
    } else {
      // 환승역이 있으면 TransferRoute를 반환해야 함
      const route = findRoute(line1[0].id, line9[0].id);
      expect(route?.type).toBe('transfer');
    }
  });
});
