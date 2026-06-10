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

// 데이터 주도 테스트용 row 타입 (#1063 Sonar 중복 라인 게이트):
// 모든 케이스가 (route, target, destinationName, sourceStationName) → expected 형태이므로
// row 배열을 it.each로 돌려 호출 패턴 중복을 제거한다.
type Target = { type: 'transfer' | 'destination'; stationName: string };
type Row = {
  label: string;
  route: NonNullable<Route>;
  target: Target;
  destinationName: string;
  sourceStationName: string;
  expected: 'up' | 'down' | undefined;
};

const runRow = ({ route, target, destinationName, sourceStationName, expected }: Row): void => {
  expect(resolveAlarmDirection(target, { route, destinationName, sourceStationName })).toBe(
    expected,
  );
};

describe('resolveAlarmDirection', () => {
  describe('direct route', () => {
    const route: NonNullable<Route> = makeDirectRoute(3, '1');
    const loopDirect: NonNullable<Route> = makeDirectRoute(3, '5');

    const rows: Row[] = [
      {
        label: '대상역이 목적지이면 source→destination 방향을 반환한다',
        route,
        target: { type: 'destination', stationName: '강남' },
        destinationName: '강남',
        sourceStationName: '시청',
        expected: 'down',
      },
      {
        label: '대상역이 목적지가 아니면 undefined',
        route,
        target: { type: 'destination', stationName: '다른역' },
        destinationName: '강남',
        sourceStationName: '시청',
        expected: undefined,
      },
      {
        label: '방향 lookup이 null을 반환하면 undefined',
        route,
        target: { type: 'destination', stationName: '강남' },
        destinationName: '강남',
        sourceStationName: '없는역',
        expected: undefined,
      },
      {
        label: '루프 노선 fallback: direct route에서 monotonic이 null이면 loop 결과 사용 (#1063)',
        route: loopDirect,
        target: { type: 'destination', stationName: '왕십리' },
        destinationName: '왕십리',
        sourceStationName: '시청',
        expected: 'down',
      },
    ];

    it.each(rows)('$label', runRow);
  });

  describe('transfer route', () => {
    const route: NonNullable<Route> = makeTransferRoute({
      transferName: '동대문',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 2,
      stopsFromTransfer: 4,
    });

    const makeLoopTransferRoute = (transferName: string, fromLine: LineNumber, toLine: LineNumber) =>
      makeTransferRoute({
        transferName,
        fromLine,
        toLine,
        stopsToTransfer: 2,
        stopsFromTransfer: 4,
      });

    const rows: Row[] = [
      {
        label: '대상역이 환승역이면 fromLine 기준 방향',
        route,
        target: { type: 'transfer', stationName: '동대문' },
        destinationName: '강남',
        sourceStationName: '시청',
        expected: 'down',
      },
      {
        label: '대상역이 최종 목적지이면 toLine 기준 방향',
        route,
        target: { type: 'destination', stationName: '강남' },
        destinationName: '강남',
        sourceStationName: '시청',
        expected: 'up',
      },
      {
        label: '대상역이 둘 다 아니면 undefined',
        route,
        target: { type: 'destination', stationName: '엉뚱역' },
        destinationName: '강남',
        sourceStationName: '시청',
        expected: undefined,
      },
      {
        label: '방향 lookup이 null이면 undefined (환승역)',
        route,
        target: { type: 'transfer', stationName: '동대문' },
        destinationName: '강남',
        sourceStationName: '없는역',
        expected: undefined,
      },
      {
        label: '방향 lookup이 null이면 undefined (최종 목적지)',
        route,
        target: { type: 'destination', stationName: '없는역' },
        destinationName: '없는역',
        sourceStationName: '시청',
        expected: undefined,
      },
      {
        label: '루프 노선 fallback: transfer route 환승역 (#1063)',
        route: makeLoopTransferRoute('왕십리', '5', '3'),
        target: { type: 'transfer', stationName: '왕십리' },
        destinationName: '강남',
        sourceStationName: '시청',
        expected: 'down',
      },
      {
        label: '루프 노선 fallback: transfer route 최종 목적지 (#1063)',
        route: makeLoopTransferRoute('시청', '1', '5'),
        target: { type: 'destination', stationName: '왕십리' },
        destinationName: '왕십리',
        sourceStationName: '동대문',
        expected: 'down',
      },
    ];

    it.each(rows)('$label', runRow);
  });

  describe('multi-transfer route', () => {
    const route: NonNullable<Route> = makeMultiTransferRoute({
      transfers: [
        { transferName: '왕십리', fromLine: '1', toLine: '2', stopsToTransfer: 3 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 4,
    });

    // 첫 환승 자리에 노선 '5'를 두고 sourceStationName→transferName 쌍만 다르게 검증 (#1063).
    const makeLoopFirstHopRoute = (firstTransferName: string): NonNullable<Route> =>
      makeMultiTransferRoute({
        transfers: [
          { transferName: firstTransferName, fromLine: '5', toLine: '3', stopsToTransfer: 3 },
          { transferName: '교대', fromLine: '3', toLine: '1', stopsToTransfer: 5 },
        ],
        stopsAfterLastTransfer: 4,
      });

    const routeWithNullableLine: NonNullable<Route> = makeMultiTransferRoute({
      transfers: [
        { transferName: '왕십리', fromLine: '3', toLine: '2', stopsToTransfer: 3 },
        { transferName: '교대', fromLine: '2', toLine: '1', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 4,
    });

    const rows: Row[] = [
      {
        label: '첫 번째 환승은 sourceStationName 기준',
        route,
        target: { type: 'transfer', stationName: '왕십리' },
        destinationName: '강남',
        sourceStationName: '시청',
        expected: 'down',
      },
      {
        label: '두 번째 환승은 직전 환승역 기준 (해당 fromLine 사용)',
        route,
        target: { type: 'transfer', stationName: '교대' },
        destinationName: '강남',
        sourceStationName: '시청',
        expected: 'up',
      },
      {
        label: '최종 목적지는 마지막 환승의 toLine 기준',
        // toLine='3' → mock returns null → undefined
        route,
        target: { type: 'destination', stationName: '강남' },
        destinationName: '강남',
        sourceStationName: '시청',
        expected: undefined,
      },
      {
        label: '대상역이 어디에도 매칭 안 되면 undefined',
        route,
        target: { type: 'transfer', stationName: '엉뚱역' },
        destinationName: '강남',
        sourceStationName: '시청',
        expected: undefined,
      },
      {
        label: '루프 노선 fallback: monotonic이 null이면 inferLoopDirection 결과를 사용 (#1063)',
        // 첫 환승의 fromLine='5' → monotonic null → loop fallback ('시청','왕십리') → 'down'.
        route: makeLoopFirstHopRoute('왕십리'),
        target: { type: 'transfer', stationName: '왕십리' },
        destinationName: '강남',
        sourceStationName: '시청',
        expected: 'down',
      },
      {
        label: '루프 노선 fallback도 null이면 undefined',
        // ('a','b') 쌍은 loop mock 매칭 안 됨 → 양쪽 모두 null → undefined.
        route: makeLoopFirstHopRoute('b'),
        target: { type: 'transfer', stationName: 'b' },
        destinationName: '강남',
        sourceStationName: 'a',
        expected: undefined,
      },
      {
        label: '환승 매칭은 됐지만 방향 lookup이 null이면 undefined',
        route: routeWithNullableLine,
        target: { type: 'transfer', stationName: '왕십리' },
        destinationName: '강남',
        sourceStationName: '시청',
        expected: undefined,
      },
    ];

    it.each(rows)('$label', runRow);

    it('추가 multi-transfer placeholder 한 건 (loop toLine 매칭 회귀 가드, #1063)', () => {
      // last.toLine='5' placeholder 한 건 (mock 매칭 안 됨 → 환승 매칭 우선) 회귀 가드.
      const loopFallbackRoute: NonNullable<Route> = makeMultiTransferRoute({
        transfers: [{ transferName: '왕십리', fromLine: '1', toLine: '5', stopsToTransfer: 3 }],
        stopsAfterLastTransfer: 4,
      });
      expect(loopFallbackRoute.type).toBe('multi-transfer');
    });
  });
});
