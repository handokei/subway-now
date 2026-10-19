import { excludeFavoriteStations } from '../excludeFavoriteStations';
import { findStationByNameAndLine } from '../../../../shared/utils/stationLookup';
import type { FavoriteEntry } from '../../../../shared/types/station';

const gangnam2 = findStationByNameAndLine('강남', '2')!;
const seoul1 = findStationByNameAndLine('서울역', '1')!;
const seoul4 = findStationByNameAndLine('서울역', '4')!;
const hongdae = findStationByNameAndLine('홍대입구', '2')!;

const fav = (station: FavoriteEntry['station']): FavoriteEntry => ({ station, role: 'general' });

describe('excludeFavoriteStations', () => {
  it('즐겨찾기와 id가 같은 역은 제외한다', () => {
    const result = excludeFavoriteStations([gangnam2, hongdae], [fav(gangnam2)]);
    expect(result).toEqual([hongdae]);
  });

  it('역명이 같아도 노선(id)이 다르면 유지한다', () => {
    expect(seoul1.id).not.toBe(seoul4.id);
    const result = excludeFavoriteStations([seoul1, seoul4], [fav(seoul1)]);
    expect(result).toEqual([seoul4]);
  });

  it('전부 겹치면 빈 배열', () => {
    expect(excludeFavoriteStations([gangnam2, hongdae], [fav(gangnam2), fav(hongdae)])).toEqual([]);
  });

  it('즐겨찾기가 없으면 원본 순서 그대로, 입력은 변경하지 않는다', () => {
    const input = [gangnam2, hongdae];
    expect(excludeFavoriteStations(input, [])).toEqual([gangnam2, hongdae]);
    expect(input).toEqual([gangnam2, hongdae]);
  });
});
