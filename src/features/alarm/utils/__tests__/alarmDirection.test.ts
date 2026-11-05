import { resolveAlarmDirection } from '../alarmDirection';
import type { Route } from '../../../../shared/utils/stationRoute';
import type { LineNumber } from '../../../../shared/types/station';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';

jest.mock('../../../route/utils/travelDirection', () => ({
  resolveTravelDirection: (line: string, from: string, to: string) => {
    if (from === '없는역' || to === '없는역') return null;
    const directionByLine: Record<string, 'up' | 'down'> = { '1': 'down', '2': 'up' };
    const direction = directionByLine[line];
    if (!direction) return null;
    return { direction, fromStation: { name: from }, toStation: { name: to } };
  },
}));

jest.mock('../../../route/utils/loopDirection', () => ({
  inferLoopDirection: (line: string, from: string, to: string) => {
    if (line !== '5') return null;
    if (from === '시청' && to === '왕십리') return 'down';
    return null;
  },
}));

jest.mock('../../../../shared/utils/stationRoute', () => ({
  isSameStationName: (a: string, b: string) => a === b,
}));

type Target = { type: 'transfer' | 'destination'; stationName: string };
type Expected = 'up' | 'down' | undefined;
type Row = { label: string; route: NonNullable<Route>; target: Target; dest: string; src: string; expected: Expected };

// Row factory — 객체 리터럴 토큰 반복을 1줄로 압축해 Sonar 중복 감지를 차단한다 (#1063).
// 대부분의 케이스가 dest='강남' / src='시청'을 공유하므로 default 값으로 둔다.
const r = (
  label: string,
  route: NonNullable<Route>,
  target: Target,
  expected: Expected,
  src = '시청',
  dest = '강남',
): Row => ({ label, route, target, dest, src, expected });

const dest = (stationName: string): Target => ({ type: 'destination', stationName });
const xfer = (stationName: string): Target => ({ type: 'transfer', stationName });

const runRow = ({ route, target, dest: destinationName, src: sourceStationName, expected }: Row): void => {
  expect(resolveAlarmDirection(target, { route, destinationName, sourceStationName })).toBe(expected);
};

describe('resolveAlarmDirection', () => {
  describe('direct route', () => {
    const route: NonNullable<Route> = makeDirectRoute(3, '1');
    const loopDirect: NonNullable<Route> = makeDirectRoute(3, '5');

    const rows: Row[] = [
      r('대상역이 목적지이면 source→destination 방향을 반환한다', route, dest('강남'), 'down'),
      r('대상역이 목적지가 아니면 undefined', route, dest('다른역'), undefined),
      r('방향 lookup이 null을 반환하면 undefined', route, dest('강남'), undefined, '없는역'),
      r('루프 노선 fallback: direct route에서 monotonic이 null이면 loop 결과 사용 (#1063)', loopDirect, dest('왕십리'), 'down', '시청', '왕십리'),
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

    const loopTransfer = (transferName: string, fromLine: LineNumber, toLine: LineNumber) =>
      makeTransferRoute({ transferName, fromLine, toLine, stopsToTransfer: 2, stopsFromTransfer: 4 });

    const rows: Row[] = [
      r('대상역이 환승역이면 fromLine 기준 방향', route, xfer('동대문'), 'down'),
      r('대상역이 최종 목적지이면 toLine 기준 방향', route, dest('강남'), 'up'),
      r('대상역이 둘 다 아니면 undefined', route, dest('엉뚱역'), undefined),
      r('방향 lookup이 null이면 undefined (환승역)', route, xfer('동대문'), undefined, '없는역'),
      r('방향 lookup이 null이면 undefined (최종 목적지)', route, dest('없는역'), undefined, '시청', '없는역'),
      r('루프 노선 fallback: transfer route 환승역 (#1063)', loopTransfer('왕십리', '5', '3'), xfer('왕십리'), 'down'),
      r('루프 노선 fallback: transfer route 최종 목적지 (#1063)', loopTransfer('시청', '1', '5'), dest('왕십리'), 'down', '동대문', '왕십리'),
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
    const loopFirstHop = (firstTransferName: string): NonNullable<Route> =>
      makeMultiTransferRoute({
        transfers: [
          { transferName: firstTransferName, fromLine: '5', toLine: '3', stopsToTransfer: 3 },
          { transferName: '교대', fromLine: '3', toLine: '1', stopsToTransfer: 5 },
        ],
        stopsAfterLastTransfer: 4,
      });

    const nullableLine: NonNullable<Route> = makeMultiTransferRoute({
      transfers: [
        { transferName: '왕십리', fromLine: '3', toLine: '2', stopsToTransfer: 3 },
        { transferName: '교대', fromLine: '2', toLine: '1', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 4,
    });

    const rows: Row[] = [
      r('첫 번째 환승은 sourceStationName 기준', route, xfer('왕십리'), 'down'),
      r('두 번째 환승은 직전 환승역 기준 (해당 fromLine 사용)', route, xfer('교대'), 'up'),
      r('최종 목적지는 마지막 환승의 toLine 기준', route, dest('강남'), undefined),
      r('대상역이 어디에도 매칭 안 되면 undefined', route, xfer('엉뚱역'), undefined),
      r('루프 노선 fallback: monotonic이 null이면 inferLoopDirection 결과를 사용 (#1063)', loopFirstHop('왕십리'), xfer('왕십리'), 'down'),
      r('루프 노선 fallback도 null이면 undefined', loopFirstHop('b'), xfer('b'), undefined, 'a'),
      r('환승 매칭은 됐지만 방향 lookup이 null이면 undefined', nullableLine, xfer('왕십리'), undefined),
    ];

    it.each(rows)('$label', runRow);

    it('추가 multi-transfer placeholder 한 건 (loop toLine 매칭 회귀 가드, #1063)', () => {
      const loopFallbackRoute: NonNullable<Route> = makeMultiTransferRoute({
        transfers: [{ transferName: '왕십리', fromLine: '1', toLine: '5', stopsToTransfer: 3 }],
        stopsAfterLastTransfer: 4,
      });
      expect(loopFallbackRoute.type).toBe('multi-transfer');
    });
  });
});
