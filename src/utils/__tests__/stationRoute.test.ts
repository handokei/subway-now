import { getStationsOnLine, getRemainingStops, findRoute, buildJourneyDisplay, calculateETA } from '../stationRoute';
import type { Station } from '../../types/station';
import type { DirectRoute, TransferRoute, MultiTransferRoute } from '../stationRoute';

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

  it.each([
    ['airport', 13],
    ['gyeongui', 57],
    ['bundang', 54],
    ['sinbundang', 16],
  ])('%s 노선 역 데이터를 로드한다 (%i개)', (line, expectedCount) => {
    const stations = getStationsOnLine(line);
    expect(stations).toHaveLength(expectedCount);
    stations.forEach((s) => expect(s.line).toBe(line));
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

  it('직접 환승이 없으면 MultiTransferRoute를 반환한다 (8호선→1호선)', () => {
    const line8 = getStationsOnLine('8');
    const line1 = getStationsOnLine('1');
    const route = findRoute(line8[0].id, line1[0].id);
    expect(route).not.toBeNull();
    expect(route?.type).toBe('multi-transfer');
    if (route?.type === 'multi-transfer') {
      expect(route.transfers).toHaveLength(2);
      expect(route.transfers[0].fromLine).toBe('8');
      expect(route.transfers[1].toLine).toBe('1');
      expect(route.stopsAfterLastTransfer).toBeGreaterThanOrEqual(0);
    }
  });

  it('직접 환승 가능하면 단일 환승을 우선한다', () => {
    // 8호선 → 2호선은 잠실에서 직접 환승 가능
    const line8 = getStationsOnLine('8');
    const line2 = getStationsOnLine('2');
    const route = findRoute(line8[0].id, line2[0].id);
    expect(route?.type).toBe('transfer');
  });

  it('8호선→4호선 multi-transfer 경로를 찾는다', () => {
    const line8 = getStationsOnLine('8');
    const line4 = getStationsOnLine('4');
    const route = findRoute(line8[0].id, line4[0].id);
    expect(route).not.toBeNull();
    expect(route?.type).toBe('multi-transfer');
  });

  it('신분당선↔2호선 강남역 환승 경로를 찾는다', () => {
    const sinbundang = getStationsOnLine('sinbundang');
    const line2 = getStationsOnLine('2');
    const sinGangnam = sinbundang.find((s) => s.name === '강남');
    const line2First = line2[0];
    expect(sinGangnam).toBeDefined();
    const route = findRoute(sinGangnam!.id, line2First.id);
    expect(route?.type).toBe('transfer');
    if (route?.type === 'transfer') {
      expect(route.transferName).toBe('강남');
    }
  });

  it('경의중앙선↔2호선 홍대입구역 환승 경로를 찾는다', () => {
    const gyeongui = getStationsOnLine('gyeongui');
    const line2 = getStationsOnLine('2');
    const gyeonguiHongdae = gyeongui.find((s) => s.name === '홍대입구');
    const line2First = line2[0];
    expect(gyeonguiHongdae).toBeDefined();
    const route = findRoute(gyeonguiHongdae!.id, line2First.id);
    expect(route?.type).toBe('transfer');
    if (route?.type === 'transfer') {
      expect(route.transferName).toBe('홍대입구');
    }
  });

  it('공항철도↔경의중앙선 환승 경로를 찾는다', () => {
    const airport = getStationsOnLine('airport');
    const gyeongui = getStationsOnLine('gyeongui');
    const airportFirst = airport[0]; // 서울역
    const gyeonguiLast = gyeongui[gyeongui.length - 1]; // 지평
    const route = findRoute(airportFirst.id, gyeonguiLast.id);
    expect(route?.type).toBe('transfer');
    if (route?.type === 'transfer') {
      // 서울역 또는 공덕에서 환승 가능
      expect(['서울역', '공덕', '홍대입구', '디지털미디어시티']).toContain(route.transferName);
    }
  });

  it('수인분당선 직통 경로를 찾는다', () => {
    const bundang = getStationsOnLine('bundang');
    const incheon = bundang.find((s) => s.name === '인천');
    const seoulSup = bundang.find((s) => s.name === '서울숲');
    expect(incheon).toBeDefined();
    expect(seoulSup).toBeDefined();
    const route = findRoute(incheon!.id, seoulSup!.id);
    expect(route?.type).toBe('direct');
  });
});

const mockStation = (overrides: Partial<Station> = {}): Station => ({
  id: '2-022',
  name: '강남',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127.0276,
  ...overrides,
});

describe('buildJourneyDisplay', () => {
  it('route가 null이면 null을 반환한다', () => {
    expect(buildJourneyDisplay(null, mockStation(), mockStation())).toBeNull();
  });

  it('DirectRoute이면 세그먼트 1개를 반환한다', () => {
    const route: DirectRoute = { type: 'direct', stops: 3 };
    const current = mockStation({ id: '2-022', name: '강남' });
    const dest = mockStation({ id: '2-025', name: '잠실' });

    const result = buildJourneyDisplay(route, current, dest);
    expect(result).not.toBeNull();
    expect(result!.segments).toHaveLength(1);
    expect(result!.segments[0].fromName).toBe('강남');
    expect(result!.segments[0].toName).toBe('잠실');
    expect(result!.segments[0].line).toBe('2');
    expect(result!.segments[0].lineColor).toBe('#009D3E');
    expect(result!.segments[0].stops).toBe(3);
    expect(result!.totalStops).toBe(3);
  });

  it('MultiTransferRoute이면 세그먼트 3개를 반환한다', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '잠실', fromLine: '8', toLine: '2', stopsToTransfer: 3 },
        { transferName: '시청', fromLine: '2', toLine: '1', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 4,
    };
    const current = mockStation({ name: '암사', line: '8', lineColor: '#E6186C' });
    const dest = mockStation({ name: '종각', line: '1', lineColor: '#0052A4' });

    const result = buildJourneyDisplay(route, current, dest);
    expect(result).not.toBeNull();
    expect(result!.segments).toHaveLength(3);

    expect(result!.segments[0].fromName).toBe('암사');
    expect(result!.segments[0].toName).toBe('잠실');
    expect(result!.segments[0].line).toBe('8');
    expect(result!.segments[0].stops).toBe(3);

    expect(result!.segments[1].fromName).toBe('잠실');
    expect(result!.segments[1].toName).toBe('시청');
    expect(result!.segments[1].line).toBe('2');
    expect(result!.segments[1].stops).toBe(5);

    expect(result!.segments[2].fromName).toBe('시청');
    expect(result!.segments[2].toName).toBe('종각');
    expect(result!.segments[2].line).toBe('1');
    expect(result!.segments[2].stops).toBe(4);

    expect(result!.totalStops).toBe(12);
  });

  it('TransferRoute이면 세그먼트 2개를 반환한다', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '교대',
      fromLine: '2',
      toLine: '3',
      stopsToTransfer: 1,
      stopsFromTransfer: 5,
    };
    const current = mockStation({ name: '강남', line: '2', lineColor: '#009D3E' });
    const dest = mockStation({ name: '경복궁', line: '3', lineColor: '#EF7C1C' });

    const result = buildJourneyDisplay(route, current, dest);
    expect(result).not.toBeNull();
    expect(result!.segments).toHaveLength(2);

    expect(result!.segments[0].fromName).toBe('강남');
    expect(result!.segments[0].toName).toBe('교대');
    expect(result!.segments[0].line).toBe('2');
    expect(result!.segments[0].stops).toBe(1);

    expect(result!.segments[1].fromName).toBe('교대');
    expect(result!.segments[1].toName).toBe('경복궁');
    expect(result!.segments[1].line).toBe('3');
    expect(result!.segments[1].stops).toBe(5);

    expect(result!.totalStops).toBe(6);
  });
});

describe('calculateETA', () => {
  it('DirectRoute일 때 대기시간 + 정거장*2분을 반환한다', () => {
    const route: DirectRoute = { type: 'direct', stops: 5 };
    // 3분 대기 + 5*2분 = 13분
    expect(calculateETA(3, route)).toBe(13);
  });

  it('TransferRoute일 때 대기시간 + 정거장*2분 + 환승3분을 반환한다', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '교대',
      fromLine: '2',
      toLine: '3',
      stopsToTransfer: 1,
      stopsFromTransfer: 5,
    };
    // 2분 대기 + 6*2분 + 3분 환승 = 17분
    expect(calculateETA(2, route)).toBe(17);
  });

  it('MultiTransferRoute일 때 대기시간 + 정거장*2분 + 환승3분*2를 반환한다', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '잠실', fromLine: '8', toLine: '2', stopsToTransfer: 3 },
        { transferName: '시청', fromLine: '2', toLine: '1', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 4,
    };
    // 2분 대기 + 12*2분 + 3분*2 환승 = 32분
    expect(calculateETA(2, route)).toBe(32);
  });

  it('route가 null이면 대기시간만 반환한다', () => {
    expect(calculateETA(5, null)).toBe(5);
  });
});

describe('buildJourneyDisplay — LINE_COLORS fallback', () => {
  it('알 수 없는 노선이면 station의 lineColor를 사용한다', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '환승역',
      fromLine: 'unknown1' as string,
      toLine: 'unknown2' as string,
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    };
    const current = mockStation({ lineColor: '#AAA' });
    const dest = mockStation({ lineColor: '#BBB' });

    const result = buildJourneyDisplay(route, current, dest);
    expect(result!.segments[0].lineColor).toBe('#AAA');
    expect(result!.segments[1].lineColor).toBe('#BBB');
  });

  it('MultiTransferRoute에서 알 수 없는 노선이면 fallback lineColor를 사용한다', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '환승A', fromLine: 'unknown1' as string, toLine: 'unknown2' as string, stopsToTransfer: 1 },
        { transferName: '환승B', fromLine: 'unknown2' as string, toLine: 'unknown3' as string, stopsToTransfer: 2 },
      ],
      stopsAfterLastTransfer: 3,
    };
    const current = mockStation({ lineColor: '#AAA' });
    const dest = mockStation({ lineColor: '#BBB' });

    const result = buildJourneyDisplay(route, current, dest);
    expect(result!.segments[0].lineColor).toBe('#AAA');
    expect(result!.segments[1].lineColor).toBe('#888888');
    expect(result!.segments[2].lineColor).toBe('#BBB');
  });
});
