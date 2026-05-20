import { routeToWaypoints } from '../routeWaypoints';
import type {
  DirectRoute,
  TransferRoute,
  MultiTransferRoute,
} from '../stationRoute';
import { getStationsOnLine } from '../stationRoute';
import type { LineNumber, Station } from '../../types/station';

function stationById(line: LineNumber, id: string): Station {
  const found = getStationsOnLine(line).find((s) => s.id === id);
  if (!found) throw new Error(`fixture station missing: ${id}`);
  return found;
}

describe('routeToWaypoints', () => {
  it('direct: 도착역 단일 waypoint (route.line)', () => {
    const route: DirectRoute = { type: 'direct', stops: 5, line: '2' };
    expect(routeToWaypoints(route, '강남')).toEqual([
      { stationName: '강남', line: '2', kind: 'destination' },
    ]);
  });

  it('transfer: 환승역(fromLine) + 도착역(toLine)', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '신도림',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 3,
      stopsFromTransfer: 4,
    };
    expect(routeToWaypoints(route, '강남')).toEqual([
      { stationName: '신도림', line: '1', kind: 'transfer' },
      { stationName: '강남', line: '2', kind: 'destination' },
    ]);
  });

  it('transfer에서 목적지가 환승역과 같으면 destination 1개로 축약 (fromLine)', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '신도림',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 3,
      stopsFromTransfer: 0,
    };
    expect(routeToWaypoints(route, '신도림')).toEqual([
      { stationName: '신도림', line: '1', kind: 'destination' },
    ]);
  });

  it('multi-transfer: 각 환승 + 마지막 toLine으로 도착역 append', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '신도림', fromLine: '1', toLine: '2', stopsToTransfer: 2 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 2,
    };
    expect(routeToWaypoints(route, '경복궁')).toEqual([
      { stationName: '신도림', line: '1', kind: 'transfer' },
      { stationName: '교대', line: '2', kind: 'transfer' },
      { stationName: '경복궁', line: '3', kind: 'destination' },
    ]);
  });

  it('multi-transfer: 마지막 환승역이 곧 목적지면 그 환승역을 destination으로 마킹', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '신도림', fromLine: '1', toLine: '2', stopsToTransfer: 2 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 0,
    };
    expect(routeToWaypoints(route, '교대')).toEqual([
      { stationName: '신도림', line: '1', kind: 'transfer' },
      { stationName: '교대', line: '2', kind: 'destination' },
    ]);
  });

  // 환승역 표기가 노선별로 다른 경우(예: 7호선 "상봉" vs 경의중앙 "상봉(시외버스터미널)").
  // 같은 역이므로 destination 단일화로 축약되어야 한다 (== 비교는 거짓 → 분리되는 회귀 방지).
  it('transfer: transferName과 destinationName의 노선별 표기가 달라도 같은 역으로 축약', () => {
    const result = routeToWaypoints(
      { type: 'transfer', transferName: '상봉', fromLine: '7', toLine: 'gyeongui', stopsToTransfer: 3, stopsFromTransfer: 0 },
      '상봉(시외버스터미널)',
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'destination', stationName: '상봉(시외버스터미널)', line: '7' });
  });

  // #416: currentStation이 주어지면 중간역을 intermediate waypoint로 포함시킨다.
  describe('#416 intermediate 펼침', () => {
    it('direct: 출발→도착 사이 중간역을 intermediate로 포함', () => {
      // 1-001(소요산) → 1-005(지행): 사이에 동두천/보산/동두천중앙
      const route: DirectRoute = { type: 'direct', stops: 4, line: '1' };
      const origin = stationById('1', '1-001');
      const result = routeToWaypoints(route, '지행', origin);
      expect(result).toEqual([
        { stationName: '동두천', line: '1', kind: 'intermediate' },
        { stationName: '보산', line: '1', kind: 'intermediate' },
        { stationName: '동두천중앙', line: '1', kind: 'intermediate' },
        { stationName: '지행', line: '1', kind: 'destination' },
      ]);
    });

    it('transfer: 환승 전/후 중간역을 모두 펼친다', () => {
      // 1-038(대방) → 신도림(1↔2 환승) → 2-035(문래)
      // 환승 전 1호선: 신길/영등포 / 환승 후 2호선: 문래는 신도림 바로 다음 (intermediates 없음)
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '신도림',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 3,
        stopsFromTransfer: 1,
      };
      const origin = stationById('1', '1-038');
      const result = routeToWaypoints(route, '문래', origin);
      expect(result).toEqual([
        { stationName: '신길', line: '1', kind: 'intermediate' },
        { stationName: '영등포', line: '1', kind: 'intermediate' },
        { stationName: '신도림', line: '1', kind: 'transfer' },
        { stationName: '문래', line: '2', kind: 'destination' },
      ]);
    });

    it('transfer 환승역=목적지: 출발→환승 중간역만 펼치고 destination 1개로 축약', () => {
      // 1-038(대방) → 신도림(1) destination
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '신도림',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 3,
        stopsFromTransfer: 0,
      };
      const origin = stationById('1', '1-038');
      const result = routeToWaypoints(route, '신도림', origin);
      expect(result).toEqual([
        { stationName: '신길', line: '1', kind: 'intermediate' },
        { stationName: '영등포', line: '1', kind: 'intermediate' },
        { stationName: '신도림', line: '1', kind: 'destination' },
      ]);
    });

    it('multi-transfer: 각 segment 사이의 중간역을 모두 펼친다', () => {
      // origin=1-039(신길) → 신도림(1→2) → 문래(2) 두 번째 환승 → 3호선
      // (테스트 시나리오: 두 환승 모두 인접 segment, 첫 segment에 신도림 직전 영등포 intermediate)
      const route: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '신도림', fromLine: '1', toLine: '2', stopsToTransfer: 2 },
          { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 11 },
        ],
        stopsAfterLastTransfer: 0,
      };
      const origin = stationById('1', '1-039');
      const result = routeToWaypoints(route, '교대', origin);
      // 1호선: 신길→영등포→신도림 = pre intermediates [영등포]
      // 2호선: 신도림→문래→영등포구청→당산→...→교대 = post intermediates 포함
      expect(result[0]).toEqual({ stationName: '영등포', line: '1', kind: 'intermediate' });
      expect(result[1]).toEqual({ stationName: '신도림', line: '1', kind: 'transfer' });
      // 마지막은 destination=교대 (intermediate=False)
      expect(result[result.length - 1]).toEqual({
        stationName: '교대',
        line: '2',
        kind: 'destination',
      });
      // 모든 intermediate는 kind === 'intermediate'
      const intermediates = result.filter((w) => w.kind === 'intermediate');
      expect(intermediates.length).toBeGreaterThan(0);
    });

    it('currentStation의 line이 route와 안 맞으면 intermediates 펼침 없이 기존 동작', () => {
      // 출발이 1호선인데 route가 2호선 direct
      const route: DirectRoute = { type: 'direct', stops: 5, line: '2' };
      const origin = stationById('1', '1-001');
      expect(routeToWaypoints(route, '강남', origin)).toEqual([
        { stationName: '강남', line: '2', kind: 'destination' },
      ]);
    });

    it('currentStation=null은 기존 동작과 동일 (하위 호환)', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '신도림',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 3,
        stopsFromTransfer: 4,
      };
      expect(routeToWaypoints(route, '강남', null)).toEqual(routeToWaypoints(route, '강남'));
    });
  });
});
