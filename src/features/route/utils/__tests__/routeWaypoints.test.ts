import { readFileSync } from 'fs';
import { join } from 'path';
import { routeToWaypoints } from '../routeWaypoints';
import type { Route } from '../../../../shared/utils/stationRoute';
import {
  anchorRouteToCurrentStation,
  calculateStaticETA,
  findRoutes,
  findStationByNameAndLine,
  getStationsOnLine,
} from '../../../../shared/utils/stationRoute';
import type { AlarmWaypoint } from '../../../../shared/types/alarm';
import type { LineNumber, Station } from '../../../../shared/types/station';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';

function stationById(line: LineNumber, id: string): Station {
  const found = getStationsOnLine(line).find((s) => s.id === id);
  if (!found) throw new Error(`fixture station missing: ${id}`);
  return found;
}

// #2747 PR-6 — 기존 케이스는 waypoint 구조(이름/노선/kind)만 검증한다. remainingSecToDest는 아래 전용 describe에서 검증.
const structureOf = (...args: Parameters<typeof routeToWaypoints>): AlarmWaypoint[] =>
  routeToWaypoints(...args).map(({ remainingSecToDest: _stamped, ...structure }) => structure);

const wp = (
  stationName: string,
  line: LineNumber,
  kind: AlarmWaypoint['kind'],
): AlarmWaypoint => ({ stationName, line, kind });

describe('routeToWaypoints', () => {
  it('direct: 도착역 단일 waypoint (route.line)', () => {
    const route = makeDirectRoute(5, '2');
    expect(structureOf(route, '강남')).toEqual([
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
    expect(structureOf(route, '강남')).toEqual([
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
    expect(structureOf(route, '신도림')).toEqual([
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
    expect(structureOf(route, '경복궁')).toEqual([
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
    expect(structureOf(route, '교대')).toEqual([
      { stationName: '신도림', line: '1', kind: 'transfer' },
      { stationName: '교대', line: '2', kind: 'destination' },
    ]);
  });

  // 환승역 표기가 노선별로 다른 경우(예: 7호선 "상봉" vs 경의중앙 "상봉(시외버스터미널)").
  // 같은 역이므로 destination 단일화로 축약되어야 한다 (== 비교는 거짓 → 분리되는 회귀 방지).
  it('transfer: transferName과 destinationName의 노선별 표기가 달라도 같은 역으로 축약', () => {
    const result = structureOf(
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
      expect(structureOf(route, destinationName, station)).toEqual(expected);
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
      const result = structureOf(route, '교대', stationById('1', '1-039'));
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
      expect(structureOf(route, '강남', null)).toEqual(structureOf(route, '강남'));
    });
  });
});

// #2747 PR-6 (C1') — waypoint마다 "그 역에 정차해 있다고 볼 때 목적지까지 남은 초"를 stamp한다.
// backend LA push etaMinutes = (다음 waypoint ETA + wp.remainingSecToDest).
describe('routeToWaypoints — remainingSecToDest (#2747 PR-6)', () => {
  // backend `replay_20261028_trip179_la_eta_destination.test.ts`가 같은 파일을 읽는다(device<->backend 계약).
  const contract = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '../../../../../backend/alarm-worker/src/__tests__/fixtures/capture_20261028_trip179/device_waypoints.contract.json',
      ),
      'utf8',
    ),
  ) as { route: NonNullable<Route>; waypoints: AlarmWaypoint[] };

  const origin = findStationByNameAndLine('중곡', '7');
  const dest = findStationByNameAndLine('뚝섬', '2');

  it('계약: 10/28 trip 179 경로(중곡->건대입구 환승->뚝섬)의 등록 payload가 backend fixture와 일치한다', () => {
    const route = findRoutes(origin!.id, dest!.id)[0].route!;
    expect(route).toEqual(contract.route);
    expect(routeToWaypoints(route, '뚝섬', origin!)).toEqual(contract.waypoints);
  });

  it('값 = mirror writer와 같은 함수·같은 입력: calculateStaticETA(anchor(route, 그 역), {excludeOriginWait:true}) 분 x 60', () => {
    const route = findRoutes(origin!.id, dest!.id)[0].route!;
    const result = routeToWaypoints(route, '뚝섬', origin!);
    for (const { stationName, line, kind, remainingSecToDest } of result) {
      if (kind === 'destination') continue;
      const station = findStationByNameAndLine(stationName, line as LineNumber)!;
      const minutes = calculateStaticETA(anchorRouteToCurrentStation(route, station, dest!.id), {
        excludeOriginWait: true,
      });
      expect(remainingSecToDest).toBe(minutes! * 60);
    }
  });

  it('거부: 역을 찾을 수 없어 앵커링 불가한 waypoint는 필드를 생략한다 (도착 waypoint는 항상 0초)', () => {
    const route = makeTransferRoute({
      transferName: '없는환승역',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 3,
      stopsFromTransfer: 4,
    });
    expect(routeToWaypoints(route, '없는도착역')).toEqual([
      { stationName: '없는환승역', line: '1', kind: 'transfer' },
      { stationName: '없는도착역', line: '2', kind: 'destination', remainingSecToDest: 0 },
    ]);
  });

  it('도착 waypoint는 0초, 앞 waypoint일수록 같거나 크다 (목적지에 가까울수록 감소)', () => {
    const route = findRoutes(origin!.id, dest!.id)[0].route!;
    const secs = routeToWaypoints(route, '뚝섬', origin!).map((w) => w.remainingSecToDest!);
    expect(secs[secs.length - 1]).toBe(0);
    for (let i = 1; i < secs.length; i++) expect(secs[i]).toBeLessThanOrEqual(secs[i - 1]);
  });
});
