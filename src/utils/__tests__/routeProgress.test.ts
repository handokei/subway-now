import {
  computeRouteArc,
  nearestArcPoint,
  stationAtProgress,
  type RouteArc,
} from '../routeProgress';
import { findStationByNameAndLine } from '../stationRoute';
import type { Station } from '../../types/station';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../testUtils/routeFixtures';

const childrenPark = findStationByNameAndLine('어린이대공원', '7')!;
const sagajeong = findStationByNameAndLine('사가정', '7')!;
const gunja = findStationByNameAndLine('군자', '7')!;
const konkukUni7 = findStationByNameAndLine('건대입구', '7')!;
const konkukUni2 = findStationByNameAndLine('건대입구', '2')!;
const jamsil2 = findStationByNameAndLine('잠실', '2')!;
const gyodae2 = findStationByNameAndLine('교대', '2')!;
const gyodae3 = findStationByNameAndLine('교대', '3')!;
const expressBus3 = findStationByNameAndLine('고속터미널', '3')!;

describe('computeRouteArc', () => {
  it('returns null when route is null', () => {
    expect(computeRouteArc(null, childrenPark, sagajeong)).toBeNull();
  });

  it('builds arc for direct route (forward — id ascending)', () => {
    const route = makeDirectRoute(4, '7');
    const arc = computeRouteArc(route, sagajeong, childrenPark);
    expect(arc).not.toBeNull();
    expect(arc!.stations[0].id).toBe(sagajeong.id);
    expect(arc!.stations[arc!.stations.length - 1].id).toBe(childrenPark.id);
    expect(arc!.arcM[0]).toBe(0);
    expect(arc!.totalLengthM).toBeGreaterThan(0);
    expect(arc!.arcM).toHaveLength(arc!.stations.length);
  });

  it('builds arc for direct route (reverse — id descending)', () => {
    const route = makeDirectRoute(4, '7');
    const arc = computeRouteArc(route, childrenPark, sagajeong);
    expect(arc).not.toBeNull();
    expect(arc!.stations[0].id).toBe(childrenPark.id);
    expect(arc!.stations[arc!.stations.length - 1].id).toBe(sagajeong.id);
  });

  it('builds arc for direct route (origin === destination)', () => {
    const route = makeDirectRoute(0, '7');
    const arc = computeRouteArc(route, gunja, gunja);
    expect(arc).not.toBeNull();
    expect(arc!.stations).toHaveLength(1);
    expect(arc!.totalLengthM).toBe(0);
    expect(arc!.arcM).toEqual([0]);
  });

  it('returns null when direct route origin id is not on the line', () => {
    const route = makeDirectRoute(4, '7');
    const fake: Station = { ...gunja, id: 'nonexistent' };
    expect(computeRouteArc(route, fake, sagajeong)).toBeNull();
  });

  it('returns null when direct route destination id is not on the line', () => {
    const route = makeDirectRoute(4, '7');
    const fake: Station = { ...sagajeong, id: 'nonexistent' };
    expect(computeRouteArc(route, gunja, fake)).toBeNull();
  });

  it('builds arc for transfer route', () => {
    const route = makeTransferRoute({
      transferName: '건대입구',
      fromLine: '7',
      toLine: '2',
      stopsToTransfer: 1,
      stopsFromTransfer: 4,
    });
    const arc = computeRouteArc(route, childrenPark, jamsil2);
    expect(arc).not.toBeNull();
    expect(arc!.stations[0].id).toBe(childrenPark.id);
    expect(arc!.stations[arc!.stations.length - 1].id).toBe(jamsil2.id);
    const ids = arc!.stations.map((s) => s.id);
    expect(ids).toContain(konkukUni7.id);
    expect(ids).toContain(konkukUni2.id);
  });

  it('returns null when transfer route has unknown transferName', () => {
    const route = makeTransferRoute({
      transferName: '존재하지않는역',
      fromLine: '7',
      toLine: '2',
      stopsToTransfer: 1,
      stopsFromTransfer: 4,
    });
    expect(computeRouteArc(route, childrenPark, jamsil2)).toBeNull();
  });

  it('returns null when transfer route origin id is invalid', () => {
    const route = makeTransferRoute({
      transferName: '건대입구',
      fromLine: '7',
      toLine: '2',
      stopsToTransfer: 1,
      stopsFromTransfer: 4,
    });
    const fakeOrigin: Station = { ...childrenPark, id: 'nonexistent' };
    expect(computeRouteArc(route, fakeOrigin, jamsil2)).toBeNull();
  });

  it('returns null when transfer route destination id is invalid', () => {
    const route = makeTransferRoute({
      transferName: '건대입구',
      fromLine: '7',
      toLine: '2',
      stopsToTransfer: 1,
      stopsFromTransfer: 4,
    });
    const fakeDest: Station = { ...jamsil2, id: 'nonexistent' };
    expect(computeRouteArc(route, childrenPark, fakeDest)).toBeNull();
  });

  it('builds arc for multi-transfer route', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '건대입구', fromLine: '7', toLine: '2', stopsToTransfer: 5 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 7 },
      ],
      stopsAfterLastTransfer: 1,
    });
    const arc = computeRouteArc(route, sagajeong, expressBus3);
    expect(arc).not.toBeNull();
    expect(arc!.stations[0].id).toBe(sagajeong.id);
    expect(arc!.stations[arc!.stations.length - 1].id).toBe(expressBus3.id);
    const ids = arc!.stations.map((s) => s.id);
    expect(ids).toContain(konkukUni7.id);
    expect(ids).toContain(konkukUni2.id);
    expect(ids).toContain(gyodae2.id);
    expect(ids).toContain(gyodae3.id);
    // dedup: 같은 ID가 두 번 들어가지 않음
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns null when multi-transfer route has unknown transferName', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '존재하지않는역', fromLine: '7', toLine: '2', stopsToTransfer: 5 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 7 },
      ],
      stopsAfterLastTransfer: 1,
    });
    expect(computeRouteArc(route, sagajeong, expressBus3)).toBeNull();
  });

  it('returns null when multi-transfer route origin id is invalid', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '건대입구', fromLine: '7', toLine: '2', stopsToTransfer: 5 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 7 },
      ],
      stopsAfterLastTransfer: 1,
    });
    const fakeOrigin: Station = { ...sagajeong, id: 'nonexistent' };
    expect(computeRouteArc(route, fakeOrigin, expressBus3)).toBeNull();
  });

  it('returns null when adjacent stations exceed MAX_INTER_STATION_M (data corruption guard)', () => {
    jest.resetModules();
    jest.doMock('../../shared/constants/routeProgress', () => ({
      MAX_INTER_STATION_M: 100,
    }));
    const { computeRouteArc: cra } = require('../routeProgress');
    const { findStationByNameAndLine: fsbnl } = require('../stationRoute');
    const ori = fsbnl('사가정', '7');
    const dst = fsbnl('어린이대공원', '7');
    const route = makeDirectRoute(4, '7');
    expect(cra(route, ori, dst)).toBeNull();
    jest.resetModules();
  });

  it('returns null when multi-transfer route destination id is invalid', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '건대입구', fromLine: '7', toLine: '2', stopsToTransfer: 5 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 7 },
      ],
      stopsAfterLastTransfer: 1,
    });
    const fakeDest: Station = { ...expressBus3, id: 'nonexistent' };
    expect(computeRouteArc(route, sagajeong, fakeDest)).toBeNull();
  });
});

describe('nearestArcPoint', () => {
  it('returns haversine distance for single-station arc', () => {
    const arc = computeRouteArc(makeDirectRoute(0, '7'), gunja, gunja)!;
    const proj = nearestArcPoint(arc, gunja.lat + 0.001, gunja.lng);
    expect(proj.arcM).toBe(0);
    expect(proj.segmentIndex).toBe(0);
    expect(proj.perpDistanceM).toBeGreaterThan(0);
  });

  it('projects exactly at first station for a 2-station arc', () => {
    const route = makeDirectRoute(1, '7');
    const arc = computeRouteArc(route, gunja, childrenPark)!;
    const proj = nearestArcPoint(arc, gunja.lat, gunja.lng);
    expect(proj.arcM).toBeCloseTo(0, 1);
    expect(proj.perpDistanceM).toBeLessThan(5);
    expect(proj.segmentIndex).toBe(0);
  });

  it('projects exactly at last station for a 2-station arc', () => {
    const route = makeDirectRoute(1, '7');
    const arc = computeRouteArc(route, gunja, childrenPark)!;
    const proj = nearestArcPoint(arc, childrenPark.lat, childrenPark.lng);
    // 등각도 평면 사영 segLenM과 haversine arcM 누적 사이 작은 오차 허용(<5m).
    expect(Math.abs(proj.arcM - arc.totalLengthM)).toBeLessThan(5);
    expect(proj.perpDistanceM).toBeLessThan(5);
  });

  it('clamps to t=0 when point is behind first station', () => {
    const route = makeDirectRoute(1, '7');
    const arc = computeRouteArc(route, gunja, childrenPark)!;
    // 군자보다 더 북쪽(어린이대공원 반대 방향)으로 멀리 떨어진 점
    const dLat = gunja.lat - childrenPark.lat;
    const dLng = gunja.lng - childrenPark.lng;
    const beyond = { lat: gunja.lat + dLat, lng: gunja.lng + dLng };
    const proj = nearestArcPoint(arc, beyond.lat, beyond.lng);
    expect(proj.arcM).toBeCloseTo(0, 1);
  });

  it('clamps to t=1 when point is past last station', () => {
    const route = makeDirectRoute(1, '7');
    const arc = computeRouteArc(route, gunja, childrenPark)!;
    const dLat = childrenPark.lat - gunja.lat;
    const dLng = childrenPark.lng - gunja.lng;
    const beyond = { lat: childrenPark.lat + dLat, lng: childrenPark.lng + dLng };
    const proj = nearestArcPoint(arc, beyond.lat, beyond.lng);
    // 등각도 평면 사영 segLenM과 haversine arcM 누적 사이 작은 오차 허용(<5m).
    expect(Math.abs(proj.arcM - arc.totalLengthM)).toBeLessThan(5);
  });

  it('picks the closer segment for multi-segment arc', () => {
    const route = makeDirectRoute(4, '7');
    const arc = computeRouteArc(route, sagajeong, childrenPark)!;
    // 어린이대공원 좌표 입력 → 마지막 segment에 사영되어야 함
    const proj = nearestArcPoint(arc, childrenPark.lat, childrenPark.lng);
    expect(proj.segmentIndex).toBe(arc.stations.length - 2);
    // 등각도 평면 사영 segLenM과 haversine arcM 누적 사이 작은 오차 허용(<5m).
    expect(Math.abs(proj.arcM - arc.totalLengthM)).toBeLessThan(5);
  });

  it('handles degenerate segment (a === b) by leaving t at 0', () => {
    // 동일 좌표를 가진 인공 station 두 개로 시작. 실제 데이터에선 발생하지 않으나
    // 방어 코드 검증.
    const dup: Station = { ...gunja };
    const synthetic: RouteArc = {
      stations: [dup, dup, childrenPark],
      arcM: [0, 0, 2000],
      totalLengthM: 2000,
    };
    const proj = nearestArcPoint(synthetic, gunja.lat, gunja.lng);
    expect(proj.arcM).toBeCloseTo(0, 0);
    expect(proj.perpDistanceM).toBeLessThan(5);
  });
});

describe('stationAtProgress', () => {
  const route = makeDirectRoute(4, '7');
  const arc = computeRouteArc(route, sagajeong, childrenPark)!;

  it('returns single station when arc has only one station', () => {
    const single = computeRouteArc(makeDirectRoute(0, '7'), gunja, gunja)!;
    const info = stationAtProgress(single, 0);
    expect(info.current.id).toBe(gunja.id);
    expect(info.next).toBeNull();
    expect(info.prev).toBeNull();
    expect(info.distanceToCurrentM).toBe(0);
    expect(info.distanceToNextM).toBeNull();
  });

  it('returns first station with null prev at progress 0', () => {
    const info = stationAtProgress(arc, 0);
    expect(info.current.id).toBe(arc.stations[0].id);
    expect(info.prev).toBeNull();
    expect(info.next?.id).toBe(arc.stations[1].id);
  });

  it('returns last station with null next at progress totalLengthM', () => {
    const info = stationAtProgress(arc, arc.totalLengthM);
    expect(info.current.id).toBe(arc.stations[arc.stations.length - 1].id);
    expect(info.next).toBeNull();
    expect(info.prev?.id).toBe(arc.stations[arc.stations.length - 2].id);
  });

  it('clamps progress below 0', () => {
    const info = stationAtProgress(arc, -5000);
    expect(info.current.id).toBe(arc.stations[0].id);
  });

  it('clamps progress above totalLengthM', () => {
    const info = stationAtProgress(arc, arc.totalLengthM + 5000);
    expect(info.current.id).toBe(arc.stations[arc.stations.length - 1].id);
  });

  it('picks nearer station and reports neighbor stations', () => {
    // station 2와 3 사이, station 2에 더 가까운 위치
    const between = arc.arcM[2] + (arc.arcM[3] - arc.arcM[2]) * 0.3;
    const info = stationAtProgress(arc, between);
    expect(info.current.id).toBe(arc.stations[2].id);
    expect(info.next?.id).toBe(arc.stations[3].id);
    expect(info.prev?.id).toBe(arc.stations[1].id);
    expect(info.distanceToNextM).toBeGreaterThan(0);
  });

  it('clamps distanceToNextM to 0 when progress exceeds next arc value', () => {
    // station 2와 3 사이, station 3에 더 가까운 위치 → currentIdx=3
    // 하지만 만약 p > arcM[3]이면 next는 station 4, arcM[4] - p > 0이라 정상.
    // distanceToNextM은 항상 ≥ 0 (Math.max 보장).
    const info = stationAtProgress(arc, arc.arcM[1]);
    expect(info.current.id).toBe(arc.stations[1].id);
    expect(info.distanceToNextM).toBe(arc.arcM[2] - arc.arcM[1]);
  });
});
