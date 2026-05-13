import { routeToWaypoints } from '../routeWaypoints';
import type {
  DirectRoute,
  TransferRoute,
  MultiTransferRoute,
} from '../stationRoute';

describe('routeToWaypoints', () => {
  it('direct: 도착역 단일 waypoint (route.line)', () => {
    const route: DirectRoute = { type: 'direct', stops: 5, line: '2' };
    expect(routeToWaypoints(route, '강남')).toEqual([
      { stationName: '강남', line: '2', kind: 'destination' },
    ]);
  });

  it('transfer: 환승역(fromLine) + 도착역(toLine)', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '신도림',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 3,
      stopsFromTransfer: 4,
    };
    expect(routeToWaypoints(route, '강남')).toEqual([
      { stationName: '신도림', line: '1', kind: 'transfer' },
      { stationName: '강남', line: '2', kind: 'destination' },
    ]);
  });

  it('transfer에서 목적지가 환승역과 같으면 destination 1개로 축약 (fromLine)', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '신도림',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 3,
      stopsFromTransfer: 0,
    };
    expect(routeToWaypoints(route, '신도림')).toEqual([
      { stationName: '신도림', line: '1', kind: 'destination' },
    ]);
  });

  it('multi-transfer: 각 환승 + 마지막 toLine으로 도착역 append', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '신도림', fromLine: '1', toLine: '2', stopsToTransfer: 2 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 2,
    };
    expect(routeToWaypoints(route, '경복궁')).toEqual([
      { stationName: '신도림', line: '1', kind: 'transfer' },
      { stationName: '교대', line: '2', kind: 'transfer' },
      { stationName: '경복궁', line: '3', kind: 'destination' },
    ]);
  });

  it('multi-transfer: 마지막 환승역이 곧 목적지면 그 환승역을 destination으로 마킹', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '신도림', fromLine: '1', toLine: '2', stopsToTransfer: 2 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 0,
    };
    expect(routeToWaypoints(route, '교대')).toEqual([
      { stationName: '신도림', line: '1', kind: 'transfer' },
      { stationName: '교대', line: '2', kind: 'destination' },
    ]);
  });
});
