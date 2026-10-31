import { routeToWaypoints } from '../routeWaypoints';
import { findRoute, findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { findStationById } from '../../../../shared/utils/stationLookup';
import type { LineNumber } from '../../../../shared/types/station';
import { makeDirectRoute, makeTransferRoute } from '../../../../testUtils/routeFixtures';

// #3177 PR-10 — 서버에 등록하는 waypoint가 "실제로 내리는 승강장"의 역 id(stationId)를 싣는다.
// 목적지 id를 그대로 쓰면 틀린다: 강남→사당(4호선)은 2호선 사당(2-026)에서 내리고, 4-025(왼쪽 문)가 아니다.
const idOf = (name: string, line: LineNumber): string => {
  const station = findStationByNameAndLine(name, line);
  if (!station) throw new Error(`fixture station missing: ${name} ${line}`);
  return station.id;
};

const summarize = (waypoints: ReturnType<typeof routeToWaypoints>) =>
  waypoints.map(({ stationName, line, kind, stationId }) => ({ stationName, line, kind, stationId }));

describe('routeToWaypoints — stationId (#3177 PR-10)', () => {
  it('강남(2) → 사당(4-025): 환승역=목적지라 destination은 fromLine 쪽 2-026 (4-025 아님), 중간역은 2호선 id', () => {
    const origin = findStationByNameAndLine('강남', '2')!;
    const route = findRoute(origin.id, '4-025')!;
    const waypoints = routeToWaypoints(route, '사당', origin);
    expect(summarize(waypoints).at(-1)).toEqual({
      stationName: '사당',
      line: '2',
      kind: 'destination',
      stationId: '2-026',
    });
    const intermediates = waypoints.filter(({ kind }) => kind === 'intermediate');
    expect(intermediates.length).toBeGreaterThan(0);
    for (const { stationName, line, stationId } of intermediates) {
      expect(stationId).toBe(idOf(stationName, line as LineNumber));
    }
  });

  it('종합운동장(9) → 신당(6-026): 환승 waypoint 종합운동장은 9-030, 도착은 2호선 신당 2-006 (6-026 아님)', () => {
    const origin = findStationByNameAndLine('종합운동장', '9')!;
    const route = findRoute(origin.id, '6-026')!;
    const waypoints = routeToWaypoints(route, '신당', origin);
    const [transfer] = waypoints.filter(({ kind }) => kind === 'transfer');
    expect(transfer).toMatchObject({ stationName: '종합운동장', line: '9', stationId: '9-030' });
    expect(summarize(waypoints).at(-1)).toEqual({
      stationName: '신당',
      line: '2',
      kind: 'destination',
      stationId: '2-006',
    });
  });

  it('직행: destination은 route.destinationStationId', () => {
    const origin = findStationByNameAndLine('강남', '2')!;
    const route = findRoute(origin.id, idOf('잠실', '2'))!;
    expect(summarize(routeToWaypoints(route, '잠실', origin)).at(-1)).toEqual({
      stationName: '잠실',
      line: '2',
      kind: 'destination',
      stationId: idOf('잠실', '2'),
    });
  });

  it.each([
    ['교대', '3', '신논현', '9'],
    ['중곡', '7', '뚝섬', '2'],
    ['종합운동장', '9', '신당', '6'],
    ['강남', '2', '사당', '4'],
  ] as const)('%s(%s) → %s(%s): 모든 waypoint가 id를 갖고 그 id의 노선이 waypoint.line과 같다', (fromName, fromLine, toName, toLine) => {
    const origin = findStationByNameAndLine(fromName, fromLine)!;
    const route = findRoute(origin.id, idOf(toName, toLine))!;
    for (const waypoint of routeToWaypoints(route, toName, origin)) {
      const { stationId, line, stationName } = waypoint;
      expect(stationId).toBeDefined();
      const station = findStationById(stationId as string);
      expect(station?.line).toBe(line);
      expect(station?.name.startsWith(stationName.split('(')[0])).toBe(true);
    }
  });

  it('id가 없는 구 route(고정 fixture)는 이름으로 대체 조회하지 않는다 — transfer/destination의 stationId 부재, 중간역은 Station 객체 id', () => {
    const origin = findStationByNameAndLine('대방', '1')!;
    const route = makeTransferRoute({
      transferName: '신도림',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 3,
      stopsFromTransfer: 1,
    });
    const waypoints = routeToWaypoints(route, '문래', origin);
    const transfer = waypoints.find(({ kind }) => kind === 'transfer')!;
    const destination = waypoints.find(({ kind }) => kind === 'destination')!;
    expect(transfer).not.toHaveProperty('stationId');
    expect(destination).not.toHaveProperty('stationId');
    const intermediates = waypoints.filter(({ kind }) => kind === 'intermediate');
    expect(intermediates.map(({ stationId }) => stationId)).toEqual([idOf('신길', '1'), idOf('영등포', '1')]);
  });

  it('currentStation 없이(legacy) direct 구 route: id 없으면 stationId 키 자체가 없다', () => {
    const [destination] = routeToWaypoints(makeDirectRoute(5, '2'), '강남');
    expect(destination).not.toHaveProperty('stationId');
  });
});
