import { sortFavoritesByRole } from '../sortFavoritesByRole';
import { findStationByNameAndLine } from '../stationLookup';
import type { FavoriteEntry } from '../../types/station';

const gangnam = findStationByNameAndLine('강남', '2')!;
const seoul = findStationByNameAndLine('서울역', '1')!;
const hongdae = findStationByNameAndLine('홍대입구', '2')!;

describe('sortFavoritesByRole', () => {
  it('home → work → general 순으로 정렬한다', () => {
    const input: FavoriteEntry[] = [
      { station: gangnam, role: 'general' },
      { station: hongdae, role: 'work' },
      { station: seoul, role: 'home' },
    ];
    expect(sortFavoritesByRole(input).map((f) => f.role)).toEqual(['home', 'work', 'general']);
  });

  it('원본 배열을 변경하지 않는다', () => {
    const input: FavoriteEntry[] = [
      { station: gangnam, role: 'general' },
      { station: seoul, role: 'home' },
    ];
    sortFavoritesByRole(input);
    expect(input.map((f) => f.role)).toEqual(['general', 'home']);
  });

  it('빈 배열이면 빈 배열', () => {
    expect(sortFavoritesByRole([])).toEqual([]);
  });
});
