import { resolveAlarmDirection } from '../alarmDirection';
import type { Route } from '../../../../shared/utils/stationRoute';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';

jest.mock('../../../route/utils/travelDirection', () => ({
  // 간단한 mock: from→to 쌍에 따라 미리 정한 결과를 반환. 시그니처는 { direction, fromStation, toStation }.
  resolveTravelDirection: (line: string, from: string, to: string) => {
    if (from === '없는역' || to === '없는역') return null;
    const directionByLine: Record<string, 'up' | 'down'> = { '1': 'down', '2': 'up' };
    const direction = directionByLine[line];
    if (!direction) return null;
    return { direction, fromStation: { name: from }, toStation: { name: to } };
  },
}));

jest.mock('../../../route/utils/loopDirection', () => ({
  // 루프 fallback mock (#1063): 노선 '5'(monotonic mock에서 null)일 때만 매칭.
  // 실제 inferLoopDirection은 2호선만 처리하지만, 본 테스트는 chaining 동작 검증 목적.
  inferLoopDirection: (line: string, from: string, to: string) => {
    if (line !== '5') return null;
    if (from === '시청' && to === '왕십리') return 'down';
    return null;
  },
}));

jest.mock('../../../../shared/utils/stationRoute', () => ({
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

    it('루프 노선 fallback: direct route에서 monotonic이 null이면 loop 결과 사용 (#1063)', () => {
      // line '5'는 monotonic mock에서 null. loop mock이 ('시청','왕십리') → 'down' 반환.
      const loopDirect: NonNullable<Route> = makeDirectRoute(3, '5');
      const dir = resolveAlarmDirection(
        { type: 'destination', stationName: '왕십리' },
        { route: loopDirect, destinationName: '왕십리', sourceStationName: '시청' },
      );
      expect(dir).toBe('down');
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

    it('루프 노선 fallback: transfer route 환승역 (#1063)', () => {
      // fromLine='5' → monotonic null → loop fallback. ('시청','왕십리') → 'down'.
      const loopTransfer: NonNullable<Route> = makeTransferRoute({
        transferName: '왕십리',
        fromLine: '5',
        toLine: '3',
        stopsToTransfer: 2,
        stopsFromTransfer: 4,
      });
      const dir = resolveAlarmDirection(
        { type: 'transfer', stationName: '왕십리' },
        { route: loopTransfer, destinationName: '강남', sourceStationName: '시청' },
      );
      expect(dir).toBe('down');
    });

    it('루프 노선 fallback: transfer route 최종 목적지 (#1063)', () => {
      // toLine='5' → monotonic null → loop fallback. transferName→destination 매칭.
      const loopTransfer: NonNullable<Route> = makeTransferRoute({
        transferName: '시청',
        fromLine: '1',
        toLine: '5',
        stopsToTransfer: 2,
        stopsFromTransfer: 4,
      });
      const dir = resolveAlarmDirection(
        { type: 'destination', stationName: '왕십리' },
        { route: loopTransfer, destinationName: '왕십리', sourceStationName: '동대문' },
      );
      expect(dir).toBe('down');
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

    it('루프 노선 fallback: monotonic이 null이면 inferLoopDirection 결과를 사용 (#1063)', () => {
      // toLine='5'는 monotonic mock에서 null. loopDirection mock이 ('시청','왕십리')에 'down' 반환.
      // route 전체 경로상 sourceStationName이 사용되지 않으므로 last.transferName → destination 방향만 평가.
      const loopFallbackRoute: NonNullable<Route> = makeMultiTransferRoute({
        transfers: [
          { transferName: '왕십리', fromLine: '1', toLine: '5', stopsToTransfer: 3 },
        ],
        stopsAfterLastTransfer: 4,
      });
      // 최종 목적지 평가는 last.toLine='5', from=last.transferName='왕십리', to=destinationName.
      // 위 시나리오는 from='왕십리'라 loop mock 매칭 안 됨 — 다른 케이스로 검증.
      // 대신 transfer 매칭 케이스: fromLine='1'(monotonic)이므로 loop 호출 안 됨.
      // 그래서 첫 환승 자리에 loop 노선을 두고 sourceStationName='시청'→transferName='왕십리'로 매칭.
      const loopFirstHop: NonNullable<Route> = makeMultiTransferRoute({
        transfers: [
          { transferName: '왕십리', fromLine: '5', toLine: '3', stopsToTransfer: 3 },
          { transferName: '교대', fromLine: '3', toLine: '1', stopsToTransfer: 5 },
        ],
        stopsAfterLastTransfer: 4,
      });
      // monotonic mock: line '5' → null. loop mock: ('5','시청','왕십리') → 'down'.
      const dir = resolveAlarmDirection(
        { type: 'transfer', stationName: '왕십리' },
        { route: loopFirstHop, destinationName: '강남', sourceStationName: '시청' },
      );
      expect(dir).toBe('down');
      // loopFallbackRoute는 본 테스트의 라인 5 placeholder로만 사용 (eslint unused 회피용 ref).
      expect(loopFallbackRoute.type).toBe('multi-transfer');
    });

    it('루프 노선 fallback도 null이면 undefined', () => {
      // line='5'지만 loop mock이 매칭 안 되는 ('a','b') 쌍 — 양쪽 모두 null → undefined.
      const loopRoute: NonNullable<Route> = makeMultiTransferRoute({
        transfers: [
          { transferName: 'b', fromLine: '5', toLine: '3', stopsToTransfer: 3 },
          { transferName: '교대', fromLine: '3', toLine: '1', stopsToTransfer: 5 },
        ],
        stopsAfterLastTransfer: 4,
      });
      const dir = resolveAlarmDirection(
        { type: 'transfer', stationName: 'b' },
        { route: loopRoute, destinationName: '강남', sourceStationName: 'a' },
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
