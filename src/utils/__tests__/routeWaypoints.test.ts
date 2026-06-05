import { routeToWaypoints } from '../routeWaypoints';
import type { Route } from '../stationRoute';
import { getStationsOnLine } from '../stationRoute';
import type { AlarmWaypoint } from '../../features/alarm/api/alarmBackend';
import type { LineNumber, Station } from '../../types/station';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../testUtils/routeFixtures';

function stationById(line: LineNumber, id: string): Station {
  const found = getStationsOnLine(line).find((s) => s.id === id);
  if (!found) throw new Error(`fixture station missing: ${id}`);
  return found;
}

const wp = (
  stationName: string,
  line: LineNumber,
  kind: AlarmWaypoint['kind'],
): AlarmWaypoint => ({ stationName, line, kind });

describe('routeToWaypoints', () => {
  it('direct: 도착역 단일 waypoint (route.line)', () => {
    const route = makeDirectRoute(5, '2');
    expect(routeToWaypoints(route, '강남')).toEqual([
      { stationName: '강남', line: '2', kind: 'destination' },
    ]);
  });

  it('transfer: 환승역(fromLine) + 도착역(toLine)', () => {
    const route = makeTransferRoute({
      transferName: '신도림',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 3,
      stopsFromTransfer: 4,
    });
    expect(routeToWaypoints(route, '강남')).toEqual([
      { stationName: '신도림', line: '1', kind: 'transfer' },
      { stationName: '강남', line: '2', kind: 'destination' },
    ]);
  });

  it('transfer에서 목적지가 환승역과 같으면 destination 1개로 축약 (fromLine)', () => {
    const route = makeTransferRoute({
      transferName: '신도림',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 3,
      stopsFromTransfer: 0,
    });
    expect(routeToWaypoints(route, '신도림')).toEqual([
      { stationName: '신도림', line: '1', kind: 'destination' },
    ]);
  });

  it('multi-transfer: 각 환승 + 마지막 toLine으로 도착역 append', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '신도림', fromLine: '1', toLine: '2', stopsToTransfer: 2 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 2,
    });
    expect(routeToWaypoints(route, '경복궁')).toEqual([
      { stationName: '신도림', line: '1', kind: 'transfer' },
      { stationName: '교대', line: '2', kind: 'transfer' },
      { stationName: '경복궁', line: '3', kind: 'destination' },
    ]);
  });

  it('multi-transfer: 마지막 환승역이 곧 목적지면 그 환승역을 destination으로 마킹', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '신도림', fromLine: '1', toLine: '2', stopsToTransfer: 2 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 0,
    });
    expect(routeToWaypoints(route, '교대')).toEqual([
      { stationName: '신도림', line: '1', kind: 'transfer' },
      { stationName: '교대', line: '2', kind: 'destination' },
    ]);
  });

  // 환승역 표기가 노선별로 다른 경우(예: 7호선 "상봉" vs 경의중앙 "상봉(시외버스터미널)").
  // 같은 역이므로 destination 단일화로 축약되어야 한다 (== 비교는 거짓 → 분리되는 회귀 방지).
  it('transfer: transferName과 destinationName의 노선별 표기가 달라도 같은 역으로 축약', () => {
    const result = routeToWaypoints(
      makeTransferRoute({ transferName: '상봉', fromLine: '7', toLine: 'gyeongui', stopsToTransfer: 3, stopsFromTransfer: 0 }),
      '상봉(시외버스터미널)',
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'destination', stationName: '상봉(시외버스터미널)', line: '7' });
  });

  // #416: currentStation이 주어지면 중간역을 intermediate waypoint로 포함시킨다.
  describe('#416 intermediate 펼침', () => {
    interface ExpandCase {
      name: string;
      route: NonNullable<Route>;
      destinationName: string;
      origin: { line: LineNumber; id: string };
      expected: AlarmWaypoint[];
    }

    const cases: ExpandCase[] = [
      {
        name: 'direct: 출발→도착 사이 중간역을 intermediate로 포함',
        // 1-001(소요산) → 1-005(지행): 사이에 동두천/보산/동두천중앙
        route: makeDirectRoute(4, '1'),
        destinationName: '지행',
        origin: { line: '1', id: '1-001' },
        expected: [
          wp('동두천', '1', 'intermediate'),
          wp('보산', '1', 'intermediate'),
          wp('동두천중앙', '1', 'intermediate'),
          wp('지행', '1', 'destination'),
        ],
      },
      {
        name: 'transfer: 환승 전/후 중간역을 모두 펼친다',
        // 1-038(대방) → 신도림(1↔2 환승) → 2-035(문래)
        route: makeTransferRoute({
          transferName: '신도림',
          fromLine: '1',
          toLine: '2',
          stopsToTransfer: 3,
          stopsFromTransfer: 1,
        }),
        destinationName: '문래',
        origin: { line: '1', id: '1-038' },
        expected: [
          wp('신길', '1', 'intermediate'),
          wp('영등포', '1', 'intermediate'),
          wp('신도림', '1', 'transfer'),
          wp('문래', '2', 'destination'),
        ],
      },
      {
        name: 'transfer 환승역=목적지: 출발→환승 중간역만 펼치고 destination 1개로 축약',
        route: makeTransferRoute({
          transferName: '신도림',
          fromLine: '1',
          toLine: '2',
          stopsToTransfer: 3,
          stopsFromTransfer: 0,
        }),
        destinationName: '신도림',
        origin: { line: '1', id: '1-038' },
        expected: [
          wp('신길', '1', 'intermediate'),
          wp('영등포', '1', 'intermediate'),
          wp('신도림', '1', 'destination'),
        ],
      },
      {
        name: 'currentStation의 line이 route와 안 맞으면 intermediates 펼침 없이 기존 동작',
        route: makeDirectRoute(5, '2'),
        destinationName: '강남',
        origin: { line: '1', id: '1-001' },
        expected: [wp('강남', '2', 'destination')],
      },
    ];

    it.each(cases)('$name', ({ route, destinationName, origin, expected }) => {
      const station = stationById(origin.line, origin.id);
      expect(routeToWaypoints(route, destinationName, station)).toEqual(expected);
    });

    it('multi-transfer: 각 segment 사이의 중간역을 모두 펼친다', () => {
      // origin=1-039(신길) → 신도림(1→2) → 교대 (마지막 환승이 목적지)
      const route = makeMultiTransferRoute({
        transfers: [
          { transferName: '신도림', fromLine: '1', toLine: '2', stopsToTransfer: 2 },
          { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 11 },
        ],
        stopsAfterLastTransfer: 0,
      });
      const result = routeToWaypoints(route, '교대', stationById('1', '1-039'));
      // 1호선 pre intermediates [영등포] + transfer 신도림 + ... + destination 교대
      expect(result[0]).toEqual(wp('영등포', '1', 'intermediate'));
      expect(result[1]).toEqual(wp('신도림', '1', 'transfer'));
      expect(result[result.length - 1]).toEqual(wp('교대', '2', 'destination'));
      expect(result.filter((w) => w.kind === 'intermediate').length).toBeGreaterThan(0);
    });

    it('currentStation=null은 기존 동작과 동일 (하위 호환)', () => {
      const route = makeTransferRoute({
        transferName: '신도림',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 3,
        stopsFromTransfer: 4,
      });
      expect(routeToWaypoints(route, '강남', null)).toEqual(routeToWaypoints(route, '강남'));
    });
  });
});
