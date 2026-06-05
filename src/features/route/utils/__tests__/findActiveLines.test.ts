import { findActiveLines } from '../findActiveLines';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';

describe('findActiveLines', () => {
  it('빈 후보 → 빈 배열', () => {
    expect(findActiveLines([])).toEqual([]);
  });

  it('호선 dedup, 거리순 보존', () => {
    const lines = findActiveLines([
      { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }, // line='2'
      { station: MOCK_STATIONS.gangnam, distanceKm: 0.2 }, // 같은 호선 → dedup
      { station: MOCK_STATIONS.chungmuro, distanceKm: 0.3 }, // line='3'
      { station: MOCK_STATIONS.yeouinaru, distanceKm: 0.4 }, // line='5'
    ]);
    expect(lines).toEqual(['2', '3', '5']);
  });

  it('단일 호선 → 1개만 반환', () => {
    expect(findActiveLines([{ station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }])).toEqual(['2']);
  });
});
