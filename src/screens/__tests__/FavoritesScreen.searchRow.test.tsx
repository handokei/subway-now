import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent } from '@testing-library/react-native';
import FavoritesScreen from '../FavoritesScreen';
import { renderWithTheme } from '../../testUtils/renderWithTheme';
import stationsData from '../../data/stations.json';
import type { Station } from '../../shared/types/station';

jest.mock('../../features/arrival/hooks/useArrivalInfo', () => ({
  useArrivalInfo: () => ({ arrival: null }),
}));
jest.mock('../../features/arrival/hooks/useArrivalCountdown', () => ({
  useArrivalCountdown: () => null,
}));
jest.mock('../../features/favorites/store/useFavoritesStore', () => {
  const state = {
    favorites: [],
    addFavorite: jest.fn(),
    removeFavorite: jest.fn(),
    setFavoriteLabel: jest.fn(),
    setSlotFavorite: jest.fn(),
    loadFavorites: jest.fn(),
  };
  return { useFavoritesStore: (sel: (s: typeof state) => unknown) => sel(state) };
});

const [sample] = stationsData as Station[];

// #3094: 즐겨찾기 추가 검색 결과 행 — card(borderRadius+overflow:hidden) 안에 padding 있는 row 래퍼가 있어야
// 호선 배지·추가 버튼이 둥근 모서리에 잘리지 않는다 (슬롯 picker 행의 cardRow와 동일 정합).
describe('FavoritesScreen 검색 결과 행 (#3094)', () => {
  it('결과 행은 padding 있는 가로 row 래퍼 안에 배지와 추가 버튼을 둔다', () => {
    const { getByTestId } = renderWithTheme(<FavoritesScreen />);
    fireEvent.changeText(getByTestId('favorites-search-input'), sample.name);
    const row = getByTestId(`favorite-search-row-${sample.id}`);
    const style = StyleSheet.flatten(row.props.style);
    expect(style.flexDirection).toBe('row');
    expect(style.paddingHorizontal).toBeGreaterThan(0);
    expect(style.paddingVertical).toBeGreaterThan(0);
    expect(getByTestId(`favorite-add-${sample.id}`)).toBeTruthy();
  });
});
