import { routeToCoordinates } from '../routeToCoordinates';
import { findRoute } from '../../../../shared/utils/stationRoute';
import stationsData from '../../../../data/stations.json';
import type { Station } from '../../../../shared/types/station';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';

const allStations = stationsData as Station[];
const byId = (id: string) => allStations.find((s) => s.id === id)!;

describe('routeToCoordinates', () => {
  it('route가 null이면 null을 반환한다', () => {
    const origin = byId('2-022');
    const destination = byId('2-019');
    expect(routeToCoordinates(null, origin, destination)).toBeNull();
  });

  describe('direct route (동일 노선)', () => {
    const origin = byId('2-022'); // 강남
    const destination = byId('2-019'); // 삼성
    const route = findRoute(origin.id, destination.id);

    it('출발/도착 사이 모든 역 좌표를 path에 포함한다', () => {
      const result = routeToCoordinates(route, origin, destination);
      expect(result).not.toBeNull();
      expect(result!.path.length).toBeGreaterThanOrEqual(2);
      expect(result!.path[0]).toEqual({ latitude: origin.lat, longitude: origin.lng });
      const last = result!.path[result!.path.length - 1];
      expect(last).toEqual({ latitude: destination.lat, longitude: destination.lng });
    });

    it('keyStations은 origin과 destination 두 개', () => {
      const result = routeToCoordinates(route, origin, destination);
      expect(result!.keyStations).toEqual([
        { station: origin, role: 'origin' },
        { station: destination, role: 'destination' },
      ]);
    });
  });

  describe('transfer route (단일 환승)', () => {
    const origin = byId('2-022'); // 강남
    const destination = byId('6-020'); // 녹사평
    const route = findRoute(origin.id, destination.id);

    it('출발 → 환승역 → 도착 좌표 시퀀스를 생성한다', () => {
      const result = routeToCoordinates(route, origin, destination);
      expect(result).not.toBeNull();
      expect(result!.path[0]).toEqual({ latitude: origin.lat, longitude: origin.lng });
      const last = result!.path[result!.path.length - 1];
      expect(last).toEqual({ latitude: destination.lat, longitude: destination.lng });
    });

    it('keyStations에 transfer 역이 포함된다', () => {
      const result = routeToCoordinates(route, origin, destination);
      const roles = result!.keyStations.map((k) => k.role);
      expect(roles).toEqual(['origin', 'transfer', 'destination']);
    });
  });

  it('두 세그먼트 경계에서 환승역 좌표가 중복되지 않는다', () => {
    const origin = byId('2-022');
    const destination = byId('6-020');
    const route = findRoute(origin.id, destination.id);
    const result = routeToCoordinates(route, origin, destination)!;
    const stringified = result.path.map((p) => `${p.latitude},${p.longitude}`);
    const unique = new Set(stringified);
    expect(unique.size).toBe(stringified.length);
  });

  describe('역방향 (toIdx < fromIdx)', () => {
    it('인덱스가 큰 역에서 작은 역으로 가는 직통도 좌표를 생성한다', () => {
      const origin = byId('2-019'); // 삼성 (idx 큼)
      const destination = byId('2-022'); // 강남 (idx 작음)
      const route = findRoute(origin.id, destination.id);
      const result = routeToCoordinates(route, origin, destination)!;
      expect(result.path[0]).toEqual({ latitude: origin.lat, longitude: origin.lng });
      expect(result.path[result.path.length - 1]).toEqual({
        latitude: destination.lat,
        longitude: destination.lng,
      });
    });
  });

  describe('multi-transfer route (2회 환승)', () => {
    it('transfers 배열의 각 환승역이 keyStations에 순서대로 포함된다', () => {
      const route = makeMultiTransferRoute({
        transfers: [
          { transferName: '사당', fromLine: '2', toLine: '4', stopsToTransfer: 4 },
          { transferName: '동대문역사문화공원', fromLine: '4', toLine: '5', stopsToTransfer: 4 },
        ],
        stopsAfterLastTransfer: 3,
      });
      const origin = byId('2-022'); // 강남
      // 5호선에서 임의의 역
      const destination = allStations.find((s) => s.line === '5' && s.name === '광화문(세종문화회관)')!;
      const result = routeToCoordinates(route, origin, destination);
      expect(result).not.toBeNull();
      const roles = result!.keyStations.map((k) => k.role);
      expect(roles).toEqual(['origin', 'transfer', 'transfer', 'destination']);
      const names = result!.keyStations.map((k) => k.station.name);
      expect(names).toEqual([origin.name, '사당', '동대문역사문화공원', destination.name]);
    });
  });

  describe('잘못된 입력으로 인한 null 반환', () => {
    it('transfer 환승역 이름을 찾을 수 없으면 null', () => {
      const route = makeTransferRoute({
        transferName: '존재하지않는역',
        fromLine: '2',
        toLine: '6',
        stopsToTransfer: 1,
        stopsFromTransfer: 1,
      });
      const origin = byId('2-022');
      const destination = byId('6-020');
      expect(routeToCoordinates(route, origin, destination)).toBeNull();
    });

    it('multi-transfer 환승역 이름을 찾을 수 없으면 null', () => {
      const route = makeMultiTransferRoute({
        transfers: [
          { transferName: '존재하지않는역', fromLine: '2', toLine: '4', stopsToTransfer: 1 },
          { transferName: '동대문역사문화공원', fromLine: '4', toLine: '5', stopsToTransfer: 1 },
        ],
        stopsAfterLastTransfer: 1,
      });
      const origin = byId('2-022');
      const destination = allStations.find((s) => s.line === '5' && s.name === '광화문(세종문화회관)')!;
      expect(routeToCoordinates(route, origin, destination)).toBeNull();
    });

    it('direct route인데 origin이 노선과 불일치하여 슬라이스 실패 시 null', () => {
      const route = makeDirectRoute(1, '2');
      const origin = byId('6-020'); // 6호선 역을 2호선 direct에 넣음 → name이 2호선에 없음
      const destination = byId('2-022');
      expect(routeToCoordinates(route, origin, destination)).toBeNull();
    });
  });
});

// #3076 특성 테스트 — stale route(2호선) + 타노선 customOrigin(7호선 논현)이면 null.
// HomeScreen route 재계산 가드가 customOrigin 축을 못 보면 이 조합이 지도에 그대로 주입된다(증상 모드 A).
describe('routeToCoordinates stale route + 타노선 origin (#3076 characterization)', () => {
  it('2호선 direct route에 7호선 출발역을 주면 null (지도 폴리라인 미렌더)', () => {
    const staleRoute = findRoute(byId('2-022').id, byId('2-019').id);
    expect(routeToCoordinates(staleRoute, byId('7-024'), byId('2-019'))).toBeNull();
  });
});

// #3086 sliceLine 방향 재도출 — id 정렬 idx 대소(toIdx>=fromIdx)로 방향을 정하면
// 2호선 closed loop seam(시청 idx0 <-> 충정로 idx42)과 지선(까치산/신설동)에서 오경로가 그려진다.
describe('routeToCoordinates 2호선 seam/지선 (#3086)', () => {
  const stationOn2 = (base: string): Station => {
    const name = canonicalStationName(base, '2');
    return allStations.find((s) => s.line === '2' && s.name === name)!;
  };
  const coords = (stations: Station[]) => stations.map((s) => ({ latitude: s.lat, longitude: s.lng }));
  const pathOf = (from: Station, to: Station) =>
    routeToCoordinates(makeDirectRoute(1, '2'), from, to)!.path;

  it('시청 -> 충정로 (seam 1 hop): 정확히 두 역만 잇는다', () => {
    const [from, to] = [stationOn2('시청'), stationOn2('충정로')];
    expect(pathOf(from, to)).toEqual(coords([from, to]));
  });

  it('충정로 -> 시청 (seam 역방향 1 hop): 정확히 두 역만 잇는다', () => {
    const [from, to] = [stationOn2('충정로'), stationOn2('시청')];
    expect(pathOf(from, to)).toEqual(coords([from, to]));
  });

  it('아현 -> 을지로입구 (seam 통과): 충정로, 시청을 거쳐 wrap 한다', () => {
    const stations = ['아현', '충정로', '시청', '을지로입구'].map(stationOn2);
    expect(pathOf(stations[0], stations[3])).toEqual(coords(stations));
  });

  it('신도림 -> 까치산 (지선): 본선 전체를 훑지 않고 두 역만 잇는다', () => {
    const [from, to] = [stationOn2('신도림'), stationOn2('까치산')];
    expect(pathOf(from, to)).toEqual(coords([from, to]));
  });

  it('신설동 -> 성수 (지선 -> 본선): 본선 전체를 훑지 않고 두 역만 잇는다', () => {
    const [from, to] = [stationOn2('신설동'), stationOn2('성수')];
    expect(pathOf(from, to)).toEqual(coords([from, to]));
  });

  it('본선 일반 구간(강남 -> 삼성)은 기존대로 중간역을 모두 포함한다', () => {
    const stations = ['강남', '역삼', '선릉', '삼성'].map(stationOn2);
    expect(pathOf(stations[0], stations[3])).toEqual(coords(stations));
  });
});
