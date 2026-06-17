import { enumerateTransferStations } from '../transferStations';
import type { Station } from '../../../../shared/types/station';

function stn(id: string, name: string, line: Station['line'], lat = 0, lng = 0): Station {
  return { id, name, line, lineColor: '#000', lat, lng };
}

describe('enumerateTransferStations', () => {
  it('같은 name + 다른 line variants 있으면 group 반환', () => {
    const groups = enumerateTransferStations([
      stn('a', 'X', '1'),
      stn('b', 'X', '2'),
    ]);
    expect(groups).toEqual([
      {
        name: 'X',
        variants: [
          expect.objectContaining({ id: 'a', line: '1' }),
          expect.objectContaining({ id: 'b', line: '2' }),
        ],
      },
    ]);
  });

  it('단일 노선 역은 제외', () => {
    expect(enumerateTransferStations([stn('a', 'Solo', '1')])).toEqual([]);
  });

  it('빈 입력은 빈 배열', () => {
    expect(enumerateTransferStations([])).toEqual([]);
  });

  it('variant 쌍 거리가 maxPairDistanceKm를 초과하면 동명이역으로 제외', () => {
    // 1도 위경도 ≈ 111km — 명백히 임계 초과
    const groups = enumerateTransferStations([
      stn('a', 'X', '1', 37, 127),
      stn('b', 'X', '2', 38, 127),
    ]);
    expect(groups).toEqual([]);
  });

  it('maxPairDistanceKm 옵션으로 임계 조정', () => {
    const stations = [
      stn('a', 'X', '1', 37, 127),
      stn('b', 'X', '2', 37.005, 127), // 약 555m
    ];
    expect(enumerateTransferStations(stations, { maxPairDistanceKm: 0.3 })).toEqual([]);
    expect(enumerateTransferStations(stations, { maxPairDistanceKm: 1 })).toHaveLength(1);
  });

  it('3개 이상 variants도 모두 임계 내면 포함', () => {
    const groups = enumerateTransferStations([
      stn('a', 'X', '1', 37, 127),
      stn('b', 'X', '2', 37.0001, 127),
      stn('c', 'X', '3', 37.0002, 127),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].variants).toHaveLength(3);
  });

  it('3개 variants 중 한 쌍만 임계 초과해도 그룹 제외', () => {
    const groups = enumerateTransferStations([
      stn('a', 'X', '1', 37, 127),
      stn('b', 'X', '2', 37.0001, 127),
      stn('c', 'X', '3', 38, 127), // a와 ~111km
    ]);
    expect(groups).toEqual([]);
  });

  it('실제 stations.json — 76개 환승역 (양평 동명이역 제외) 모두 다른 line', () => {
    const groups = enumerateTransferStations();
    expect(groups).toHaveLength(76);
    for (const group of groups) {
      expect(group.variants.length).toBeGreaterThanOrEqual(2);
      const lines = new Set(group.variants.map((v) => v.line));
      expect(lines.size).toBe(group.variants.length);
    }
    expect(groups.find((g) => g.name === '양평')).toBeUndefined();
  });
});
