import { resolveAlarmDirection } from '../alarmDirection';
import type { Route } from '../../../../shared/utils/stationRoute';
import type { LineNumber } from '../../../../shared/types/station';
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

// 공통 호출 헬퍼 (#1063 Sonar 중복 라인 게이트):
// 모든 케이스가 (event, { route, destinationName, sourceStationName }) 형태로
// resolveAlarmDirection을 호출하므로 위임 형태로 줄인다.
type Target = { type: 'transfer' | 'destination'; stationName: string };
const callResolve = (
  route: NonNullable<Route>,
  target: Target,
  destinationName: string,
  sourceStationName: string,
) =>
  resolveAlarmDirection(target, {
    route,
    destinationName,
    sourceStationName,
  });

describe('resolveAlarmDirection', () => {
  describe('direct route', () => {
    const route: NonNullable<Route> = makeDirectRoute(3, '1');

    it('대상역이 목적지이면 source→destination 방향을 반환한다', () => {
      expect(callResolve(route, { type: 'destination', stationName: '강남' }, '강남', '시청')).toBe(
        'down',
      );
    });

    it('대상역이 목적지가 아니면 undefined', () => {
      expect(
        callResolve(route, { type: 'destination', stationName: '다른역' }, '강남', '시청'),
      ).toBeUndefined();
    });

    it('방향 lookup이 null을 반환하면 undefined', () => {
      expect(
        callResolve(route, { type: 'destination', stationName: '강남' }, '강남', '없는역'),
      ).toBeUndefined();
    });

    it('루프 노선 fallback: direct route에서 monotonic이 null이면 loop 결과 사용 (#1063)', () => {
      // line '5'는 monotonic mock에서 null. loop mock이 ('시청','왕십리') → 'down' 반환.
      const loopDirect: NonNullable<Route> = makeDirectRoute(3, '5');
      expect(
        callResolve(loopDirect, { type: 'destination', stationName: '왕십리' }, '왕십리', '시청'),
      ).toBe('down');
    });
  });

  // 루프 fallback 시나리오를 공통 헬퍼로 추출 (#1063 Sonar 중복 라인 게이트).
  // 단순 transfer route + (target, source, destination) 조합만 다르므로 위임 형태로 줄인다.
  const expectLoopTransferDir = (params: {
    transferName: string;
    fromLine: LineNumber;
    toLine: LineNumber;
    target: Target;
    destinationName: string;
    sourceStationName: string;
    expected: 'up' | 'down' | undefined;
  }): void => {
    const route: NonNullable<Route> = makeTransferRoute({
      transferName: params.transferName,
      fromLine: params.fromLine,
      toLine: params.toLine,
      stopsToTransfer: 2,
      stopsFromTransfer: 4,
    });
    expect(
      callResolve(route, params.target, params.destinationName, params.sourceStationName),
    ).toBe(params.expected);
  };

  describe('transfer route', () => {
    const route: NonNullable<Route> = makeTransferRoute({
      transferName: '동대문',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 2,
      stopsFromTransfer: 4,
    });

    it('대상역이 환승역이면 fromLine 기준 방향', () => {
      expect(callResolve(route, { type: 'transfer', stationName: '동대문' }, '강남', '시청')).toBe(
        'down',
      );
    });

    it('대상역이 최종 목적지이면 toLine 기준 방향', () => {
      expect(
        callResolve(route, { type: 'destination', stationName: '강남' }, '강남', '시청'),
      ).toBe('up');
    });

    it('대상역이 둘 다 아니면 undefined', () => {
      expect(
        callResolve(route, { type: 'destination', stationName: '엉뚱역' }, '강남', '시청'),
      ).toBeUndefined();
    });

    it('방향 lookup이 null이면 undefined (환승역)', () => {
      expect(
        callResolve(route, { type: 'transfer', stationName: '동대문' }, '강남', '없는역'),
      ).toBeUndefined();
    });

    it('방향 lookup이 null이면 undefined (최종 목적지)', () => {
      expect(
        callResolve(route, { type: 'destination', stationName: '없는역' }, '없는역', '시청'),
      ).toBeUndefined();
    });

    it('루프 노선 fallback: transfer route 환승역 (#1063)', () => {
      // fromLine='5' → monotonic null → loop fallback. ('시청','왕십리') → 'down'.
      expectLoopTransferDir({
        transferName: '왕십리',
        fromLine: '5',
        toLine: '3',
        target: { type: 'transfer', stationName: '왕십리' },
        destinationName: '강남',
        sourceStationName: '시청',
        expected: 'down',
      });
    });

    it('루프 노선 fallback: transfer route 최종 목적지 (#1063)', () => {
      // toLine='5' → monotonic null → loop fallback. transferName→destination 매칭.
      expectLoopTransferDir({
        transferName: '시청',
        fromLine: '1',
        toLine: '5',
        target: { type: 'destination', stationName: '왕십리' },
        destinationName: '왕십리',
        sourceStationName: '동대문',
        expected: 'down',
      });
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
      expect(callResolve(route, { type: 'transfer', stationName: '왕십리' }, '강남', '시청')).toBe(
        'down',
      );
    });

    it('두 번째 환승은 직전 환승역 기준 (해당 fromLine 사용)', () => {
      expect(callResolve(route, { type: 'transfer', stationName: '교대' }, '강남', '시청')).toBe(
        'up',
      );
    });

    it('최종 목적지는 마지막 환승의 toLine 기준', () => {
      // toLine='3' → mock returns null → undefined
      expect(
        callResolve(route, { type: 'destination', stationName: '강남' }, '강남', '시청'),
      ).toBeUndefined();
    });

    it('대상역이 어디에도 매칭 안 되면 undefined', () => {
      expect(
        callResolve(route, { type: 'transfer', stationName: '엉뚱역' }, '강남', '시청'),
      ).toBeUndefined();
    });

    // multi-transfer 루프 fallback 시나리오 공통 헬퍼 (#1063 Sonar 중복 라인 게이트).
    // 첫 환승 자리에 노선 '5'를 두고 sourceStationName→transferName 쌍만 다르게 검증.
    const makeLoopFirstHopRoute = (firstTransferName: string): NonNullable<Route> =>
      makeMultiTransferRoute({
        transfers: [
          { transferName: firstTransferName, fromLine: '5', toLine: '3', stopsToTransfer: 3 },
          { transferName: '교대', fromLine: '3', toLine: '1', stopsToTransfer: 5 },
        ],
        stopsAfterLastTransfer: 4,
      });

    it('루프 노선 fallback: monotonic이 null이면 inferLoopDirection 결과를 사용 (#1063)', () => {
      // 첫 환승의 fromLine='5' → monotonic null → loop fallback ('시청','왕십리') → 'down'.
      // 추가로 last.toLine='5' placeholder 한 건도 같이 검증 (mock 매칭 안 됨 → 환승 매칭 우선).
      const loopFallbackRoute: NonNullable<Route> = makeMultiTransferRoute({
        transfers: [{ transferName: '왕십리', fromLine: '1', toLine: '5', stopsToTransfer: 3 }],
        stopsAfterLastTransfer: 4,
      });
      expect(loopFallbackRoute.type).toBe('multi-transfer');
      expect(
        callResolve(
          makeLoopFirstHopRoute('왕십리'),
          { type: 'transfer', stationName: '왕십리' },
          '강남',
          '시청',
        ),
      ).toBe('down');
    });

    it('루프 노선 fallback도 null이면 undefined', () => {
      // ('a','b') 쌍은 loop mock 매칭 안 됨 → 양쪽 모두 null → undefined.
      expect(
        callResolve(
          makeLoopFirstHopRoute('b'),
          { type: 'transfer', stationName: 'b' },
          '강남',
          'a',
        ),
      ).toBeUndefined();
    });

    it('환승 매칭은 됐지만 방향 lookup이 null이면 undefined', () => {
      const routeWithNullableLine: NonNullable<Route> = makeMultiTransferRoute({
        transfers: [
          { transferName: '왕십리', fromLine: '3', toLine: '2', stopsToTransfer: 3 },
          { transferName: '교대', fromLine: '2', toLine: '1', stopsToTransfer: 5 },
        ],
        stopsAfterLastTransfer: 4,
      });
      expect(
        callResolve(
          routeWithNullableLine,
          { type: 'transfer', stationName: '왕십리' },
          '강남',
          '시청',
        ),
      ).toBeUndefined();
    });
  });
});
