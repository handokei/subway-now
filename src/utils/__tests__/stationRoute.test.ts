import { getStationsOnLine, getRemainingStops, getIntermediateStationNames, findRoute, findRoutes, pickRouteByPreference, buildJourneyDisplay, calculateETA, calculateStaticETA, getNextStationName, findStationByNameAndLine, updateRouteFromPosition, isStationOnRoute, findRouteCandidatesByCategory, ROUTE_CATEGORIES, normalizeStationName, isSameStationName } from '../stationRoute';
import type { Station, LineNumber } from '../../types/station';
import type { DirectRoute, TransferRoute, MultiTransferRoute, RouteCandidate, RouteCategory } from '../stationRoute';

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
    expect(getStationsOnLine('999' as unknown as LineNumber)).toEqual([]);
  });

  it.each<[LineNumber, number]>([
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
    // 합정(2-038)은 홍대입구(2-039) 바로 옆 → 홍대입구 환승이 명확히 최단.
    // line2[0](시청)은 정규화 fallback 적용 후 왕십리 환승이 더 짧아 후보 다양화로 인해
    // 단일 환승역 단정 의미가 사라짐. 테스트 의도(경의중앙↔2호선 환승) 유지하면서 결정성 확보.
    const hapjeong = line2.find((s) => s.name === '합정');
    expect(gyeonguiHongdae).toBeDefined();
    expect(hapjeong).toBeDefined();
    const route = findRoute(gyeonguiHongdae!.id, hapjeong!.id);
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
    const route: DirectRoute = { type: 'direct', stops: 3, line: '2' };
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

  it('DirectRoute 표시는 current.line이 아닌 route.line을 따른다 (환승역 출발)', () => {
    // 시나리오: 건대입구(2/7 환승)에서 GPS가 2호선 entry를 current로 잡았으나
    // findRouteCandidatesByCategory 결과는 7호선 direct(같은 line) 경로가 우승.
    // 이전 버그: 표시가 current.line='2'를 그대로 사용해 "2호선 직통"으로 잘못 표기.
    const route: DirectRoute = { type: 'direct', stops: 4, line: '7' };
    const current = mockStation({ id: '2-012', name: '건대입구', line: '2', lineColor: '#009D3E' });
    const dest = mockStation({ id: '7-015', name: '용마산', line: '7', lineColor: '#747F00' });

    const result = buildJourneyDisplay(route, current, dest);
    expect(result!.segments[0].line).toBe('7');
    expect(result!.segments[0].lineColor).toBe('#747F00');
  });

  it('DirectRoute에서 LINE_COLORS에 없는 line이면 current.lineColor로 fallback', () => {
    const unknownLine = 'unknown-line' as unknown as LineNumber;
    const route: DirectRoute = { type: 'direct', stops: 2, line: unknownLine };
    const current = mockStation({ name: 'A', line: unknownLine, lineColor: '#ABCDEF' });
    const dest = mockStation({ name: 'B', line: unknownLine });

    const result = buildJourneyDisplay(route, current, dest);
    expect(result!.segments[0].lineColor).toBe('#ABCDEF');
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
    const route: DirectRoute = { type: 'direct', stops: 5, line: '2' };
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

describe('calculateStaticETA', () => {
  it('DirectRoute일 때 기본대기3분 + 정거장*2분을 반환한다', () => {
    const route: DirectRoute = { type: 'direct', stops: 5, line: '2' };
    // 3분 대기 + 5*2분 = 13분
    expect(calculateStaticETA(route)).toBe(13);
  });

  it('TransferRoute일 때 기본대기3분 + 정거장*2분 + 환승3분을 반환한다', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '교대',
      fromLine: '2',
      toLine: '3',
      stopsToTransfer: 1,
      stopsFromTransfer: 5,
    };
    // 3분 대기 + 6*2분 + 3분 환승 = 18분
    expect(calculateStaticETA(route)).toBe(18);
  });

  it('MultiTransferRoute일 때 기본대기3분 + 정거장*2분 + 환승3분*2를 반환한다', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '잠실', fromLine: '8', toLine: '2', stopsToTransfer: 3 },
        { transferName: '시청', fromLine: '2', toLine: '1', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 4,
    };
    // 3분 대기 + 12*2분 + 3분*2 환승 = 33분
    expect(calculateStaticETA(route)).toBe(33);
  });

  it('route가 null이면 null을 반환한다', () => {
    expect(calculateStaticETA(null)).toBeNull();
  });
});

describe('buildJourneyDisplay — LINE_COLORS fallback', () => {
  it('알 수 없는 노선이면 station의 lineColor를 사용한다', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '환승역',
      fromLine: 'unknown1' as unknown as LineNumber,
      toLine: 'unknown2' as unknown as LineNumber,
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
        { transferName: '환승A', fromLine: 'unknown1' as unknown as LineNumber, toLine: 'unknown2' as unknown as LineNumber, stopsToTransfer: 1 },
        { transferName: '환승B', fromLine: 'unknown2' as unknown as LineNumber, toLine: 'unknown3' as unknown as LineNumber, stopsToTransfer: 2 },
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

describe('getNextStationName', () => {
  it('route가 null이면 null을 반환한다', () => {
    expect(getNextStationName('1-001', '1-003', null)).toBeNull();
  });

  it('currentId가 유효하지 않으면 null을 반환한다', () => {
    const route: DirectRoute = { type: 'direct', stops: 2, line: '1' };
    expect(getNextStationName('invalid-id', '1-003', route)).toBeNull();
  });

  it('destinationId가 유효하지 않으면 null을 반환한다', () => {
    const route: DirectRoute = { type: 'direct', stops: 2, line: '1' };
    expect(getNextStationName('1-001', 'invalid-id', route)).toBeNull();
  });

  describe('DirectRoute', () => {
    it('정방향으로 다음 역을 반환한다', () => {
      // 1호선: 소요산(1-001) → 보산(1-003), 중간에 동두천(1-002)
      const route: DirectRoute = { type: 'direct', stops: 2, line: '1' };
      const next = getNextStationName('1-001', '1-003', route);
      // 소요산 다음 역 (1-002)의 이름
      const line1 = getStationsOnLine('1');
      const soyo = line1.findIndex((s) => s.id === '1-001');
      expect(next).toBe(line1[soyo + 1].name);
    });

    it('역방향으로 다음 역을 반환한다', () => {
      // 1호선: 보산(1-003) → 소요산(1-001)
      const route: DirectRoute = { type: 'direct', stops: 2, line: '1' };
      const next = getNextStationName('1-003', '1-001', route);
      const line1 = getStationsOnLine('1');
      const bosan = line1.findIndex((s) => s.id === '1-003');
      expect(next).toBe(line1[bosan - 1].name);
    });

    it('같은 역이면 null을 반환한다 (currentIdx === targetIdx)', () => {
      const route: DirectRoute = { type: 'direct', stops: 0, line: '1' };
      expect(getNextStationName('1-001', '1-001', route)).toBeNull();
    });

  });

  describe('TransferRoute', () => {
    it('환승역 이름이 노선에 없으면 null을 반환한다 (targetIdx undefined)', () => {
      const line1 = getStationsOnLine('1');
      const line2 = getStationsOnLine('2');
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '존재하지않는역',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 1,
        stopsFromTransfer: 1,
      };
      expect(getNextStationName(line1[0].id, line2[0].id, route)).toBeNull();
    });

    it('stopsToTransfer > 0이면 환승역 방향 다음 역을 반환한다', () => {
      // 2호선 강남(2-022) → 3호선 역: 교대(2-023/3-032) 환승
      const line2 = getStationsOnLine('2');
      const line3 = getStationsOnLine('3');
      const gangnam = line2.find((s) => s.name === '강남')!;
      const gyodae3 = line3.find((s) => s.name === '교대')!;
      const destStation = line3[line3.indexOf(gyodae3) + 1];

      const route: TransferRoute = {
        type: 'transfer',
        transferName: '교대',
        fromLine: '2',
        toLine: '3',
        stopsToTransfer: 1,
        stopsFromTransfer: 1,
      };
      const next = getNextStationName(gangnam.id, destStation.id, route);
      expect(next).toBe('교대');
    });

    it('stopsToTransfer === 0이면 toLine에서 목적지 방향 다음 역을 반환한다', () => {
      // 현재 교대역(3호선)에서 목적지 방향으로
      const line3 = getStationsOnLine('3');
      const gyodae3 = line3.find((s) => s.name === '교대')!;
      const gyodaeIdx = line3.indexOf(gyodae3);
      const destStation = line3[gyodaeIdx + 2]; // 교대에서 2칸 뒤

      const route: TransferRoute = {
        type: 'transfer',
        transferName: '교대',
        fromLine: '2',
        toLine: '3',
        stopsToTransfer: 0,
        stopsFromTransfer: 2,
      };
      const next = getNextStationName(gyodae3.id, destStation.id, route);
      expect(next).toBe(line3[gyodaeIdx + 1].name);
    });
  });

  describe('MultiTransferRoute', () => {
    it('t1.stopsToTransfer > 0이면 첫 번째 환승역 방향 다음 역을 반환한다', () => {
      // 8호선 → 2호선(잠실 환승) → 1호선(시청 환승)
      const line8 = getStationsOnLine('8');
      const line1 = getStationsOnLine('1');
      const route = findRoute(line8[0].id, line1[0].id);
      expect(route?.type).toBe('multi-transfer');

      if (route?.type === 'multi-transfer') {
        const next = getNextStationName(line8[0].id, line1[0].id, route);
        // 8호선 첫 역에서 다음 역
        expect(next).toBe(line8[1].name);
      }
    });

    it('t1.stopsToTransfer === 0, t2.stopsToTransfer > 0이면 두 번째 환승역 방향 다음 역을 반환한다', () => {
      // 8호선→1호선 멀티 환승 경로를 가져와서 첫 번째 환승역 위치에서 테스트
      const line8 = getStationsOnLine('8');
      const line1 = getStationsOnLine('1');
      const realRoute = findRoute(line8[0].id, line1[0].id);
      expect(realRoute?.type).toBe('multi-transfer');

      if (realRoute?.type === 'multi-transfer') {
        const [t1, t2] = realRoute.transfers;
        // 첫 번째 환승역에 있는 상태로 가공
        const modifiedRoute: MultiTransferRoute = {
          type: 'multi-transfer',
          transfers: [
            { ...t1, stopsToTransfer: 0 },
            t2,
          ],
          stopsAfterLastTransfer: realRoute.stopsAfterLastTransfer,
        };
        // 첫 번째 환승역은 t1.toLine(=중간노선)에도 있음
        const midLine = getStationsOnLine(t1.toLine);
        const t1Station = midLine.find((s) => s.name === t1.transferName)!;
        const next = getNextStationName(t1Station.id, line1[0].id, modifiedRoute);
        expect(next).not.toBeNull();
        // t1.toLine에서 t2.transferName 방향으로 한 역 이동
        const t1Idx = midLine.indexOf(t1Station);
        const t2Idx = midLine.findIndex((s) => s.name === t2.transferName);
        const step = t2Idx > t1Idx ? 1 : -1;
        expect(next).toBe(midLine[t1Idx + step].name);
      }
    });

    it('t1, t2 모두 stopsToTransfer === 0이면 목적지 방향 다음 역을 반환한다', () => {
      const line8 = getStationsOnLine('8');
      const line1 = getStationsOnLine('1');
      const realRoute = findRoute(line8[0].id, line1[0].id);
      expect(realRoute?.type).toBe('multi-transfer');

      if (realRoute?.type === 'multi-transfer') {
        const [t1, t2] = realRoute.transfers;
        const modifiedRoute: MultiTransferRoute = {
          type: 'multi-transfer',
          transfers: [
            { ...t1, stopsToTransfer: 0 },
            { ...t2, stopsToTransfer: 0 },
          ],
          stopsAfterLastTransfer: realRoute.stopsAfterLastTransfer,
        };
        // 두 번째 환승역 위치에서 목적지 방향
        const destLine = getStationsOnLine(t2.toLine);
        const t2Station = destLine.find((s) => s.name === t2.transferName)!;
        const next = getNextStationName(t2Station.id, line1[0].id, modifiedRoute);
        expect(next).not.toBeNull();
        const t2Idx = destLine.indexOf(t2Station);
        const destIdx = destLine.findIndex((s) => s.id === line1[0].id);
        const step = destIdx > t2Idx ? 1 : -1;
        expect(next).toBe(destLine[t2Idx + step].name);
      }
    });
  });
});

describe('findRoutes', () => {
  it('같은 노선이면 직통 후보 1개를 반환한다', () => {
    const candidates = findRoutes('1-001', '1-003');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].route.type).toBe('direct');
    expect(candidates[0].transferCount).toBe(0);
  });

  it('다른 노선이면 후보를 travelMinutes 기준 정렬하여 반환한다', () => {
    // 2호선 강남 → 3호선 교대
    const candidates = findRoutes('2-022', '3-012');
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i].travelMinutes).toBeGreaterThanOrEqual(candidates[i - 1].travelMinutes);
    }
  });

  it('유효하지 않은 역 ID면 빈 배열을 반환한다', () => {
    expect(findRoutes('invalid', '1-001')).toEqual([]);
    expect(findRoutes('1-001', 'invalid')).toEqual([]);
  });

  it('단일 환승 경로의 transferCount는 1이다', () => {
    const candidates = findRoutes('2-022', '3-012');
    const single = candidates.find((c) => c.route.type === 'transfer');
    if (single) {
      expect(single.transferCount).toBe(1);
    }
  });
});

describe('pickRouteByPreference', () => {
  const c1: RouteCandidate = {
    route: { type: 'direct', stops: 3, line: '2' },
    totalStops: 3,
    transferCount: 0,
    travelMinutes: 6,
  };
  const c2: RouteCandidate = {
    route: { type: 'transfer', transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 2, stopsFromTransfer: 3 },
    totalStops: 5,
    transferCount: 1,
    travelMinutes: 13,
  };

  it('optimal이면 travelMinutes가 가장 낮은 후보를 반환한다', () => {
    expect(pickRouteByPreference([c1, c2], 'optimal')).toBe(c1);
  });

  it('minTransfer이면 transferCount가 가장 낮은 후보를 반환한다', () => {
    expect(pickRouteByPreference([c2, c1], 'minTransfer')).toBe(c1);
  });

  it('minTransfer에서 transferCount가 같으면 travelMinutes가 낮은 후보를 반환한다', () => {
    const fast: RouteCandidate = { route: { type: 'transfer', transferName: 'A', fromLine: '1', toLine: '2', stopsToTransfer: 1, stopsFromTransfer: 2 }, totalStops: 3, transferCount: 1, travelMinutes: 9 };
    const slow: RouteCandidate = { route: { type: 'transfer', transferName: 'B', fromLine: '1', toLine: '2', stopsToTransfer: 3, stopsFromTransfer: 4 }, totalStops: 7, transferCount: 1, travelMinutes: 17 };
    expect(pickRouteByPreference([slow, fast], 'minTransfer')).toBe(fast);
  });

  it('빈 배열이면 null을 반환한다', () => {
    expect(pickRouteByPreference([], 'optimal')).toBeNull();
  });
});

describe('findRouteCandidatesByCategory', () => {
  it('직통 경로일 때 모든 카테고리가 후보를 반환한다 (같은 경로를 가리킴)', () => {
    const result = findRouteCandidatesByCategory(['1-001'], '1-003');
    expect(result).toHaveLength(ROUTE_CATEGORIES.length);
    result.forEach((entry) => {
      expect(entry.candidate.route.type).toBe('direct');
    });
    expect(result[0].candidate).toBe(result[1].candidate);
  });

  it('환승 경로가 있어도 항상 모든 카테고리에 대해 결과를 반환한다', () => {
    const result = findRouteCandidatesByCategory(['2-022'], '3-012');
    expect(result.length).toBe(ROUTE_CATEGORIES.length);
    const keys = result.map((r) => r.category.key);
    expect(keys).toEqual(ROUTE_CATEGORIES.map((c) => c.key));
  });

  it('originIds가 비어있으면 빈 배열을 반환한다', () => {
    expect(findRouteCandidatesByCategory([], '1-001')).toEqual([]);
  });

  it('유효하지 않은 origin이면 빈 배열을 반환한다', () => {
    expect(findRouteCandidatesByCategory(['invalid-id'], '1-001')).toEqual([]);
  });

  it('여러 originIds를 모두 탐색하여 카테고리별 최적을 선택한다', () => {
    // 3-032(교대 3호선) → 3-034 직통, 2-022(강남 2호선) → 3-034는 환승 필요
    // optimal 카테고리는 더 짧은 직통 후보(transferCount=0)를 선택해야 한다.
    const result = findRouteCandidatesByCategory(['2-022', '3-032'], '3-034');
    expect(result.length).toBe(ROUTE_CATEGORIES.length);
    const optimal = result.find((r) => r.category.key === 'optimal')!;
    expect(optimal.candidate.transferCount).toBe(0);
    expect(optimal.candidate.route.type).toBe('direct');
  });

  it('커스텀 categories 인자를 받아 해당 정렬 기준으로 동작한다', () => {
    const onlyOptimal: RouteCategory[] = [
      { key: 'optimal', label: '빠른길', comparator: (a, b) => a.travelMinutes - b.travelMinutes },
    ];
    const result = findRouteCandidatesByCategory(['1-001'], '1-003', onlyOptimal);
    expect(result).toHaveLength(1);
    expect(result[0].category.label).toBe('빠른길');
  });
});

describe('ROUTE_CATEGORIES comparators', () => {
  const makeCandidate = (transferCount: number, travelMinutes: number): RouteCandidate => ({
    route: { type: 'direct', stops: Math.max(0, Math.floor(travelMinutes / 2)), line: '2' },
    totalStops: Math.max(0, Math.floor(travelMinutes / 2)),
    transferCount,
    travelMinutes,
  });

  it('optimal: travelMinutes 차이가 우선, 동률이면 transferCount로 정렬한다', () => {
    const optimal = ROUTE_CATEGORIES.find((c) => c.key === 'optimal')!;
    const fast = makeCandidate(2, 10);
    const slow = makeCandidate(0, 20);
    expect(optimal.comparator(fast, slow)).toBeLessThan(0);
    expect(optimal.comparator(slow, fast)).toBeGreaterThan(0);

    const sameTimeMoreTransfer = makeCandidate(2, 10);
    const sameTimeFewerTransfer = makeCandidate(0, 10);
    expect(optimal.comparator(sameTimeMoreTransfer, sameTimeFewerTransfer)).toBeGreaterThan(0);
  });

  it('minTransfer: transferCount 차이가 우선, 동률이면 travelMinutes로 정렬한다', () => {
    const minTransfer = ROUTE_CATEGORIES.find((c) => c.key === 'minTransfer')!;
    const fewer = makeCandidate(0, 30);
    const more = makeCandidate(2, 10);
    expect(minTransfer.comparator(fewer, more)).toBeLessThan(0);
    expect(minTransfer.comparator(more, fewer)).toBeGreaterThan(0);

    const sameTransferSlower = makeCandidate(1, 20);
    const sameTransferFaster = makeCandidate(1, 10);
    expect(minTransfer.comparator(sameTransferSlower, sameTransferFaster)).toBeGreaterThan(0);
  });
});

describe('findStationByNameAndLine', () => {
  it('이름과 노선이 일치하는 역을 반환한다', () => {
    const station = findStationByNameAndLine('교대', '2');
    expect(station).toBeDefined();
    expect(station?.name).toBe('교대');
    expect(station?.line).toBe('2');
    expect(station?.id).toBe('2-023');
  });

  it('다른 노선에 있는 같은 이름의 역을 반환한다', () => {
    const station = findStationByNameAndLine('교대', '3');
    expect(station).toBeDefined();
    expect(station?.name).toBe('교대');
    expect(station?.line).toBe('3');
    expect(station?.id).toBe('3-032');
  });

  it('존재하지 않는 역 이름이면 undefined를 반환한다', () => {
    expect(findStationByNameAndLine('존재하지않는역', '2')).toBeUndefined();
  });

  it('해당 노선에 없는 역이면 undefined를 반환한다 (다른 노선에는 있어도)', () => {
    // 교대역은 1호선에 없음
    expect(findStationByNameAndLine('교대', '1')).toBeUndefined();
  });
});

describe('updateRouteFromPosition', () => {
  // ── DirectRoute ──
  describe('DirectRoute', () => {
    it('현재 역에서 목적지까지 남은 정거장 수로 업데이트한다', () => {
      // 1호선: 소요산(1-001) → 보산(1-003): 2 stops
      // 현재 동두천(1-002)에 있으면 보산까지 1 stop
      const storedRoute: DirectRoute = { type: 'direct', stops: 2, line: '1' };
      const nearestStation = getStationsOnLine('1').find((s) => s.id === '1-002')!;
      const result = updateRouteFromPosition(storedRoute, nearestStation, '1-003');
      expect(result).not.toBeNull();
      expect(result?.type).toBe('direct');
      if (result?.type === 'direct') {
        expect(result.stops).toBe(1);
      }
    });

    it('현재 역과 목적지가 다른 노선이면 null을 반환한다', () => {
      const storedRoute: DirectRoute = { type: 'direct', stops: 3, line: '1' };
      // 2호선 강남, 목적지는 1호선 시청
      const gangnam2 = getStationsOnLine('2').find((s) => s.name === '강남')!;
      const result = updateRouteFromPosition(storedRoute, gangnam2, '1-033');
      expect(result).toBeNull();
    });

    it('같은 노선이지만 nearestStation ID가 유효하지 않으면 null을 반환한다', () => {
      const storedRoute: DirectRoute = { type: 'direct', stops: 2, line: '1' };
      const fakeStation = { id: 'invalid-id', name: '가짜역', line: '1' as const, lineColor: '#00288C', lat: 0, lng: 0 };
      const result = updateRouteFromPosition(storedRoute, fakeStation, '1-003');
      expect(result).toBeNull();
    });
  });

  // ── TransferRoute ──
  describe('TransferRoute', () => {
    // fromLine: '2', toLine: '3', transferName: '교대'
    // 교대(2호선): 2-023, 교대(3호선): 3-032
    // 목적지: 3호선 양재 3-034
    const storedTransferRoute: TransferRoute = {
      type: 'transfer',
      transferName: '교대',
      fromLine: '2',
      toLine: '3',
      stopsToTransfer: 1,
      stopsFromTransfer: 2,
    };

    it('fromLine에 있으면 환승역까지 남은 정거장으로 stopsToTransfer를 업데이트한다', () => {
      // 강남(2-022)에서 교대(2-023)까지 1 stop
      const gangnam2 = getStationsOnLine('2').find((s) => s.name === '강남')!;
      const result = updateRouteFromPosition(storedTransferRoute, gangnam2, '3-034');
      expect(result).not.toBeNull();
      expect(result?.type).toBe('transfer');
      if (result?.type === 'transfer') {
        expect(result.stopsToTransfer).toBe(1);
        expect(result.fromLine).toBe('2');
        expect(result.toLine).toBe('3');
      }
    });

    it('fromLine에 있지만 transferName이 해당 노선에 존재하지 않으면 null을 반환한다', () => {
      const invalidRoute: TransferRoute = {
        type: 'transfer',
        transferName: '존재하지않는환승역',
        fromLine: '2',
        toLine: '3',
        stopsToTransfer: 1,
        stopsFromTransfer: 2,
      };
      const gangnam2 = getStationsOnLine('2').find((s) => s.name === '강남')!;
      const result = updateRouteFromPosition(invalidRoute, gangnam2, '3-034');
      expect(result).toBeNull();
    });

    it('fromLine에 있고 transferName은 있지만 nearestStation ID가 유효하지 않으면 null을 반환한다', () => {
      // nearestStation의 id가 유효하지 않으면 getRemainingStops가 null을 반환
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '교대',
        fromLine: '2',
        toLine: '3',
        stopsToTransfer: 1,
        stopsFromTransfer: 2,
      };
      const fakeStation = { id: 'invalid-id', name: '가짜역', line: '2' as const, lineColor: '#009D3E', lat: 0, lng: 0 };
      const result = updateRouteFromPosition(route, fakeStation, '3-034');
      expect(result).toBeNull();
    });

    it('toLine에 있으면 stopsToTransfer=0, 목적지까지 stopsFromTransfer를 업데이트한다', () => {
      // 교대(3-032)에서 양재(3-034)까지 2 stops
      const gyodae3 = getStationsOnLine('3').find((s) => s.name === '교대')!;
      const result = updateRouteFromPosition(storedTransferRoute, gyodae3, '3-034');
      expect(result).not.toBeNull();
      expect(result?.type).toBe('transfer');
      if (result?.type === 'transfer') {
        expect(result.stopsToTransfer).toBe(0);
        expect(result.stopsFromTransfer).toBe(2);
      }
    });

    it('toLine에 있지만 destinationId가 다른 노선이면 null을 반환한다', () => {
      // 교대(3호선)에 있지만 목적지가 1호선 역
      const gyodae3 = getStationsOnLine('3').find((s) => s.name === '교대')!;
      const result = updateRouteFromPosition(storedTransferRoute, gyodae3, '1-001');
      expect(result).toBeNull();
    });

    it('fromLine도 toLine도 아닌 노선이면 null을 반환한다', () => {
      // 7호선 장암 역
      const jangam7 = getStationsOnLine('7').find((s) => s.id === '7-001')!;
      const result = updateRouteFromPosition(storedTransferRoute, jangam7, '3-034');
      expect(result).toBeNull();
    });
  });

  // ── MultiTransferRoute ──
  describe('MultiTransferRoute', () => {
    // 8호선 → 2호선(잠실) → 1호선
    // t1: 8호선 → 2호선, transferName: '잠실'
    // t2: 2호선 → 1호선, transferName: '시청'
    const storedMultiRoute: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '잠실', fromLine: '8', toLine: '2', stopsToTransfer: 4 },
        { transferName: '시청', fromLine: '2', toLine: '1', stopsToTransfer: 10 },
      ],
      stopsAfterLastTransfer: 5,
    };

    it('t1.fromLine(8호선)에 있으면 t1.stopsToTransfer를 업데이트한다', () => {
      // 8호선 암사(8-001)에서 잠실(8호선 8-005)까지 4 stops
      const amsa8 = getStationsOnLine('8').find((s) => s.id === '8-001')!;
      const result = updateRouteFromPosition(storedMultiRoute, amsa8, '1-001');
      expect(result).not.toBeNull();
      expect(result?.type).toBe('multi-transfer');
      if (result?.type === 'multi-transfer') {
        expect(result.transfers[0].stopsToTransfer).toBe(4);
        expect(result.transfers[1].stopsToTransfer).toBe(10);
      }
    });

    it('t1.fromLine에 있지만 t1.transferName이 해당 노선에 없으면 null을 반환한다', () => {
      const invalidMultiRoute: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '존재하지않는역', fromLine: '8', toLine: '2', stopsToTransfer: 4 },
          { transferName: '시청', fromLine: '2', toLine: '1', stopsToTransfer: 10 },
        ],
        stopsAfterLastTransfer: 5,
      };
      const amsa8 = getStationsOnLine('8').find((s) => s.id === '8-001')!;
      const result = updateRouteFromPosition(invalidMultiRoute, amsa8, '1-001');
      expect(result).toBeNull();
    });

    it('t1.fromLine에 있고 transferName은 있지만 nearestStation ID가 유효하지 않으면 null을 반환한다', () => {
      const fakeStation = { id: 'invalid-id', name: '가짜역', line: '8' as const, lineColor: '#E6186C', lat: 0, lng: 0 };
      const result = updateRouteFromPosition(storedMultiRoute, fakeStation, '1-001');
      expect(result).toBeNull();
    });

    it('t1.toLine(2호선, 즉 t2.fromLine)에 있으면 t1=0, t2.stopsToTransfer를 업데이트한다', () => {
      // 2호선 잠실(2-016)에서 시청(2-001)까지의 stops
      const jamsil2 = getStationsOnLine('2').find((s) => s.name === '잠실')!;
      const result = updateRouteFromPosition(storedMultiRoute, jamsil2, '1-001');
      expect(result).not.toBeNull();
      expect(result?.type).toBe('multi-transfer');
      if (result?.type === 'multi-transfer') {
        expect(result.transfers[0].stopsToTransfer).toBe(0);
        expect(result.transfers[1].stopsToTransfer).toBeGreaterThan(0);
      }
    });

    it('t1.toLine에 있지만 t2.transferName이 해당 노선에 없으면 null을 반환한다', () => {
      const invalidMultiRoute: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '잠실', fromLine: '8', toLine: '2', stopsToTransfer: 4 },
          { transferName: '존재하지않는역', fromLine: '2', toLine: '1', stopsToTransfer: 10 },
        ],
        stopsAfterLastTransfer: 5,
      };
      const jamsil2 = getStationsOnLine('2').find((s) => s.name === '잠실')!;
      const result = updateRouteFromPosition(invalidMultiRoute, jamsil2, '1-001');
      expect(result).toBeNull();
    });

    it('t1.toLine에 있고 t2.transferName은 있지만 nearestStation ID가 유효하지 않으면 null을 반환한다', () => {
      const fakeStation = { id: 'invalid-id', name: '가짜역', line: '2' as const, lineColor: '#009D3E', lat: 0, lng: 0 };
      const result = updateRouteFromPosition(storedMultiRoute, fakeStation, '1-001');
      expect(result).toBeNull();
    });

    it('t2.toLine(1호선)에 있으면 both transfers=0, stopsAfterLastTransfer를 업데이트한다', () => {
      // 1호선 시청(1-033)에서 소요산(1-001)까지의 stops
      const city1 = getStationsOnLine('1').find((s) => s.name === '시청')!;
      const result = updateRouteFromPosition(storedMultiRoute, city1, '1-001');
      expect(result).not.toBeNull();
      expect(result?.type).toBe('multi-transfer');
      if (result?.type === 'multi-transfer') {
        expect(result.transfers[0].stopsToTransfer).toBe(0);
        expect(result.transfers[1].stopsToTransfer).toBe(0);
        expect(result.stopsAfterLastTransfer).toBeGreaterThan(0);
      }
    });

    it('t2.toLine에 있지만 destinationId가 다른 노선이면 null을 반환한다', () => {
      // 1호선 시청에 있지만 목적지가 2호선 역
      const city1 = getStationsOnLine('1').find((s) => s.name === '시청')!;
      const result = updateRouteFromPosition(storedMultiRoute, city1, '2-001');
      expect(result).toBeNull();
    });

    it('관련 없는 노선에 있으면 null을 반환한다', () => {
      // 7호선 장암 역
      const jangam7 = getStationsOnLine('7').find((s) => s.id === '7-001')!;
      const result = updateRouteFromPosition(storedMultiRoute, jangam7, '1-001');
      expect(result).toBeNull();
    });
  });
});

describe('isStationOnRoute', () => {
  const makeStation = (line: Station['line']): Station => ({
    id: 'X',
    name: 'X',
    line,
    lineColor: '#fff',
    lat: 0,
    lng: 0,
  });

  const transferRoute: TransferRoute = {
    type: 'transfer',
    transferName: '동대문',
    fromLine: '1',
    toLine: '4',
    stopsToTransfer: 3,
    stopsFromTransfer: 2,
  };

  const multiTransferRoute: MultiTransferRoute = {
    type: 'multi-transfer',
    transfers: [
      { transferName: '동대문', fromLine: '1', toLine: '4', stopsToTransfer: 2 },
      { transferName: '충무로', fromLine: '4', toLine: '3', stopsToTransfer: 3 },
    ],
    stopsAfterLastTransfer: 5,
  };

  it('direct route — station.line이 route.line과 일치하면 true', () => {
    const route: DirectRoute = { type: 'direct', stops: 3, line: '2' };
    expect(isStationOnRoute(makeStation('2'), route)).toBe(true);
  });

  it('direct route — station.line이 route.line과 다르면 false (#195 회귀 가드)', () => {
    const route: DirectRoute = { type: 'direct', stops: 3, line: '2' };
    expect(isStationOnRoute(makeStation('9'), route)).toBe(false);
  });

  it('transfer route — fromLine 일치 시 true', () => {
    expect(isStationOnRoute(makeStation('1'), transferRoute)).toBe(true);
  });

  it('transfer route — toLine 일치 시 true', () => {
    expect(isStationOnRoute(makeStation('4'), transferRoute)).toBe(true);
  });

  it('transfer route — 둘 다 아니면 false', () => {
    expect(isStationOnRoute(makeStation('7'), transferRoute)).toBe(false);
  });

  it('multi-transfer route — 환승 구간 어느 노선이든 일치 시 true', () => {
    expect(isStationOnRoute(makeStation('1'), multiTransferRoute)).toBe(true);
    expect(isStationOnRoute(makeStation('4'), multiTransferRoute)).toBe(true);
    expect(isStationOnRoute(makeStation('3'), multiTransferRoute)).toBe(true);
  });

  it('multi-transfer route — 어느 환승 구간에도 없으면 false', () => {
    expect(isStationOnRoute(makeStation('7'), multiTransferRoute)).toBe(false);
  });
});

describe('normalizeStationName', () => {
  it('후행 괄호 부제를 제거한다', () => {
    expect(normalizeStationName('상봉(시외버스터미널)')).toBe('상봉');
    expect(normalizeStationName('왕십리(성동구청)')).toBe('왕십리');
    expect(normalizeStationName('청량리(서울시립대입구)')).toBe('청량리');
  });

  it('괄호 없는 이름은 그대로 반환한다', () => {
    expect(normalizeStationName('용마산')).toBe('용마산');
    expect(normalizeStationName('상봉')).toBe('상봉');
  });

  it('괄호 앞 공백도 함께 제거한다', () => {
    expect(normalizeStationName('테스트 (부제)')).toBe('테스트');
  });

  it('역명이 모두 괄호로 시작하면 원본을 반환한다 (방어)', () => {
    expect(normalizeStationName('(부제)')).toBe('(부제)');
  });
});

describe('isSameStationName', () => {
  it('정확 일치', () => {
    expect(isSameStationName('상봉', '상봉')).toBe(true);
  });
  it('정규화 후 일치', () => {
    expect(isSameStationName('상봉', '상봉(시외버스터미널)')).toBe(true);
    expect(isSameStationName('왕십리(성동구청)', '왕십리')).toBe(true);
  });
  it('다른 역은 false', () => {
    expect(isSameStationName('상봉', '용마산')).toBe(false);
  });
});

describe('findStationByNameAndLine — 정규화 fallback', () => {
  it('정확 이름이 없으면 정규화 비교로 매칭한다', () => {
    // 경의중앙 상봉은 "상봉(시외버스터미널)"로 등록되어 있음
    const station = findStationByNameAndLine('상봉', 'gyeongui');
    expect(station).toBeDefined();
    expect(station?.id).toBe('gyeongui-039');
  });

  it('정확 이름이 있으면 그대로 반환한다', () => {
    expect(findStationByNameAndLine('상봉', '7')?.id).toBe('7-012');
  });

  it('정규화 후에도 매칭이 없으면 undefined', () => {
    expect(findStationByNameAndLine('존재하지않는역', '1')).toBeUndefined();
  });
});

describe('환승역 이름 표기 불일치 회귀 — #401', () => {
  it('용마산(7) → 중랑(경의중앙): 상봉 1회 환승 후보가 포함된다', () => {
    const candidates = findRoutes('7-015', 'gyeongui-038');
    const single = candidates.find((c) => c.transferCount === 1);
    expect(single).toBeDefined();
    expect((single!.route as TransferRoute).type).toBe('transfer');
    expect(normalizeStationName((single!.route as TransferRoute).transferName)).toBe('상봉');
  });

  it('용마산 → 중랑: 1회 환승이 2회 환승보다 빠르다 (또는 동등)', () => {
    const candidates = findRoutes('7-015', 'gyeongui-038');
    const single = candidates.find((c) => c.transferCount === 1);
    const multi = candidates.find((c) => c.transferCount === 2);
    expect(single).toBeDefined();
    if (multi) {
      expect(single!.travelMinutes).toBeLessThanOrEqual(multi.travelMinutes);
    }
  });

  // 괄호 부제가 붙은 다중 노선 환승역들 — 양방향 모두 1회 환승 후보가 잡혀야 함
  // (한쪽 노선만 정규화 키가 등록되는 비대칭 인덱스 문제 회귀 방지)
  it.each<[string, string, string]>([
    // [from id, to id, expected normalized transfer name]
    ['7-015', 'gyeongui-038', '상봉'],       // 7 → 경의중앙 (상봉 환승)
    ['gyeongui-038', '7-015', '상봉'],       // 역방향: 경의중앙 → 7
    ['3-034', 'sinbundang-012', '양재'],      // 3 → 신분당 자기환승은 candidate.line 비교에 의존
    ['sinbundang-012', '3-034', '양재'],      // 역방향
    ['4-022', 'gyeongui-029', '이촌'],        // 4 → 경의중앙
    ['gyeongui-029', '4-022', '이촌'],        // 역방향
  ])('정규화 환승 매칭 (양방향): %s → %s 는 %s 환승 후보를 갖는다', (fromId, toId, expectedName) => {
    const candidates = findRoutes(fromId, toId);
    const single = candidates.find((c) => c.transferCount === 1);
    expect(single).toBeDefined();
    expect(normalizeStationName((single!.route as TransferRoute).transferName)).toBe(expectedName);
  });
});

describe('getIntermediateStationNames', () => {
  it('returns empty array when current and destination are the same', () => {
    expect(getIntermediateStationNames('1-001', '1-001')).toEqual([]);
  });

  it('returns empty array for adjacent stations', () => {
    // 1-001(소요산) → 1-002(동두천): 사이에 역 없음
    expect(getIntermediateStationNames('1-001', '1-002')).toEqual([]);
  });

  it('returns intermediate station names in forward direction', () => {
    // 1-001(소요산) → 1-005(지행): 동두천, 보산, 동두천중앙
    expect(getIntermediateStationNames('1-001', '1-005')).toEqual([
      '동두천',
      '보산',
      '동두천중앙',
    ]);
  });

  it('returns intermediate station names in reverse direction', () => {
    // 1-005(지행) → 1-001(소요산): 동두천중앙, 보산, 동두천 (역순)
    expect(getIntermediateStationNames('1-005', '1-001')).toEqual([
      '동두천중앙',
      '보산',
      '동두천',
    ]);
  });

  it('returns null when stations are on different lines', () => {
    const line1 = getStationsOnLine('1')[0];
    const line2 = getStationsOnLine('2')[0];
    expect(getIntermediateStationNames(line1.id, line2.id)).toBeNull();
  });

  it('returns null for unknown station id', () => {
    expect(getIntermediateStationNames('1-001', 'unknown-id')).toBeNull();
    expect(getIntermediateStationNames('unknown-id', '1-001')).toBeNull();
  });
});
