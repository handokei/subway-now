import { routeToCoordinates } from '../routeToCoordinates';
import { findRoute } from '../stationRoute';
import stationsData from '../../data/stations.json';
import type { Station } from '../../types/station';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../testUtils/routeFixtures';

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
      const destination = allStations.find((s) => s.line === '5' && s.name === '광화문')!;
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
      const destination = allStations.find((s) => s.line === '5' && s.name === '광화문')!;
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
