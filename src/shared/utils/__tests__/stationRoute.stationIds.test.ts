// #3177 PR-1 — 경로 객체에 실제 하차 승강장 역 id를 싣는다. 실데이터(stations.json), mock 없음.
import { findRoute, getStationById, updateRouteFromPosition } from '../stationRoute';
import type { DirectRoute, MultiTransferRoute, TransferRoute } from '../stationRoute';

function station(id: string) {
  const s = getStationById(id);
  if (!s) throw new Error(`station not found: ${id}`);
  return s;
}

describe('route station ids (#3177)', () => {
  it('강남→사당(4): 환승역은 2호선 승강장 2-026, 목적지는 4-025', () => {
    const route = findRoute('2-022', '4-025') as TransferRoute;
    expect(route.type).toBe('transfer');
    expect(route.transferStationId).toBe('2-026');
    expect(route.destinationStationId).toBe('4-025');
  });

  it('종합운동장(9)→신당(6): 환승 하차역 [9-030, 2-006], 목적지 6-026', () => {
    const route = findRoute('9-030', '6-026') as MultiTransferRoute;
    expect(route.type).toBe('multi-transfer');
    expect(route.transfers.map((t) => t.transferStationId)).toEqual(['9-030', '2-006']);
    expect(route.destinationStationId).toBe('6-026');
  });

  it('직행: destinationStationId가 목적지 id', () => {
    const route = findRoute('2-022', '2-026') as DirectRoute;
    expect(route.type).toBe('direct');
    expect(route.destinationStationId).toBe('2-026');
  });

  describe('updateRouteFromPosition 이후 id 보존', () => {
    it('direct 재생성', () => {
      const stored = findRoute('2-022', '2-026')!;
      const next = updateRouteFromPosition(stored, station('2-023'), '2-026') as DirectRoute;
      expect(next.type).toBe('direct');
      expect(next.destinationStationId).toBe('2-026');
    });

    it('transfer: fromLine / toLine 두 분기 모두', () => {
      const stored = findRoute('2-022', '4-025')!;
      const onFrom = updateRouteFromPosition(stored, station('2-023'), '4-025') as TransferRoute;
      expect(onFrom.transferStationId).toBe('2-026');
      expect(onFrom.destinationStationId).toBe('4-025');
      const onTo = updateRouteFromPosition(stored, station('4-024'), '4-025') as TransferRoute;
      expect(onTo.transferStationId).toBe('2-026');
      expect(onTo.destinationStationId).toBe('4-025');
    });

    it('multi-transfer: 환승 구간 / 마지막 환승 이후 두 분기 모두', () => {
      const stored = findRoute('9-030', '6-026')!;
      const onFrom = updateRouteFromPosition(stored, station('9-029'), '6-026') as MultiTransferRoute;
      expect(onFrom.transfers.map((t) => t.transferStationId)).toEqual(['9-030', '2-006']);
      expect(onFrom.destinationStationId).toBe('6-026');
      const onLast = updateRouteFromPosition(stored, station('6-025'), '6-026') as MultiTransferRoute;
      expect(onLast.transfers.map((t) => t.transferStationId)).toEqual(['9-030', '2-006']);
      expect(onLast.destinationStationId).toBe('6-026');
    });
  });
});
