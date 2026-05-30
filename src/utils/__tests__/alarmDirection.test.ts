import { resolveAlarmDirection } from '../alarmDirection';
import type { Route } from '../stationRoute';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../testUtils/routeFixtures';

jest.mock('../travelDirection', () => ({
  // 간단한 mock: from→to 쌍에 따라 미리 정한 결과를 반환. 시그니처는 { direction, fromStation, toStation }.
  resolveTravelDirection: (line: string, from: string, to: string) => {
    if (from === '없는역' || to === '없는역') return null;
    const directionByLine: Record<string, 'up' | 'down'> = { '1': 'down', '2': 'up' };
    const direction = directionByLine[line];
    if (!direction) return null;
    return { direction, fromStation: { name: from }, toStation: { name: to } };
  },
}));

jest.mock('../stationRoute', () => ({
  isSameStationName: (a: string, b: string) => a === b,
}));

describe('resolveAlarmDirection', () => {
  describe('direct route', () => {
    const route: NonNullable<Route> = makeDirectRoute(3, '1');

    it('대상역이 목적지이면 source→destination 방향을 반환한다', () => {
      const dir = resolveAlarmDirection(
        { type: 'destination', stationName: '강남' },
        { route, destinationName: '강남', sourceStationName: '시청' },
      );
      expect(dir).toBe('down');
    });

    it('대상역이 목적지가 아니면 undefined', () => {
      const dir = resolveAlarmDirection(
        { type: 'destination', stationName: '다른역' },
        { route, destinationName: '강남', sourceStationName: '시청' },
      );
      expect(dir).toBeUndefined();
    });

    it('방향 lookup이 null을 반환하면 undefined', () => {
      const dir = resolveAlarmDirection(
        { type: 'destination', stationName: '강남' },
        { route, destinationName: '강남', sourceStationName: '없는역' },
      );
      expect(dir).toBeUndefined();
    });
  });

  describe('transfer route', () => {
    const route: NonNullable<Route> = makeTransferRoute({
      transferName: '동대문',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 2,
      stopsFromTransfer: 4,
    });

    it('대상역이 환승역이면 fromLine 기준 방향', () => {
      const dir = resolveAlarmDirection(
        { type: 'transfer', stationName: '동대문' },
        { route, destinationName: '강남', sourceStationName: '시청' },
      );
      expect(dir).toBe('down');
    });

    it('대상역이 최종 목적지이면 toLine 기준 방향', () => {
      const dir = resolveAlarmDirection(
        { type: 'destination', stationName: '강남' },
        { route, destinationName: '강남', sourceStationName: '시청' },
      );
      expect(dir).toBe('up');
    });

    it('대상역이 둘 다 아니면 undefined', () => {
      const dir = resolveAlarmDirection(
        { type: 'destination', stationName: '엉뚱역' },
        { route, destinationName: '강남', sourceStationName: '시청' },
      );
      expect(dir).toBeUndefined();
    });

    it('방향 lookup이 null이면 undefined (환승역)', () => {
      const dir = resolveAlarmDirection(
        { type: 'transfer', stationName: '동대문' },
        { route, destinationName: '강남', sourceStationName: '없는역' },
      );
      expect(dir).toBeUndefined();
    });

    it('방향 lookup이 null이면 undefined (최종 목적지)', () => {
      const dir = resolveAlarmDirection(
        { type: 'destination', stationName: '없는역' },
        { route, destinationName: '없는역', sourceStationName: '시청' },
      );
      expect(dir).toBeUndefined();
    });
  });

  describe('multi-transfer route', () => {
    const route: NonNullable<Route> = makeMultiTransferRoute({
      transfers: [
        { transferName: '왕십리', fromLine: '1', toLine: '2', stopsToTransfer: 3 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 4,
    });

    it('첫 번째 환승은 sourceStationName 기준', () => {
      const dir = resolveAlarmDirection(
        { type: 'transfer', stationName: '왕십리' },
        { route, destinationName: '강남', sourceStationName: '시청' },
      );
      expect(dir).toBe('down');
    });

    it('두 번째 환승은 직전 환승역 기준 (해당 fromLine 사용)', () => {
      const dir = resolveAlarmDirection(
        { type: 'transfer', stationName: '교대' },
        { route, destinationName: '강남', sourceStationName: '시청' },
      );
      expect(dir).toBe('up');
    });

    it('최종 목적지는 마지막 환승의 toLine 기준', () => {
      const dir = resolveAlarmDirection(
        { type: 'destination', stationName: '강남' },
        { route, destinationName: '강남', sourceStationName: '시청' },
      );
      // toLine='3' → mock returns null → undefined
      expect(dir).toBeUndefined();
    });

    it('대상역이 어디에도 매칭 안 되면 undefined', () => {
      const dir = resolveAlarmDirection(
        { type: 'transfer', stationName: '엉뚱역' },
        { route, destinationName: '강남', sourceStationName: '시청' },
      );
      expect(dir).toBeUndefined();
    });

    it('환승 매칭은 됐지만 방향 lookup이 null이면 undefined', () => {
      const routeWithNullableLine: NonNullable<Route> = makeMultiTransferRoute({
        transfers: [
          { transferName: '왕십리', fromLine: '3', toLine: '2', stopsToTransfer: 3 },
          { transferName: '교대', fromLine: '2', toLine: '1', stopsToTransfer: 5 },
        ],
        stopsAfterLastTransfer: 4,
      });
      const dir = resolveAlarmDirection(
        { type: 'transfer', stationName: '왕십리' },
        { route: routeWithNullableLine, destinationName: '강남', sourceStationName: '시청' },
      );
      expect(dir).toBeUndefined();
    });
  });
});
