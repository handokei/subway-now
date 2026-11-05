import React from 'react';
import { fireEvent, within } from '@testing-library/react-native';
import { RecentDestinationList } from '../RecentDestinationList';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import { findStationByNameAndLine } from '../../../../shared/utils/stationLookup';
import type { FavoriteEntry } from '../../../../shared/types/station';

const gangnam = findStationByNameAndLine('강남', '2')!;
const hongdae = findStationByNameAndLine('홍대입구', '2')!;
const seoul = findStationByNameAndLine('서울역', '1')!;

const fav = (station: FavoriteEntry['station']): FavoriteEntry => ({ station, role: 'general' });
const markerId = (id: string) => `recent-destination-favorite-marker-${id}`;

describe('RecentDestinationList', () => {
  it('최근 목적지가 0개면 렌더하지 않는다', () => {
    const { queryByTestId } = renderWithTheme(
      <RecentDestinationList recents={[]} favorites={[fav(gangnam)]} onSelect={jest.fn()} onRemove={jest.fn()} />,
    );
    expect(queryByTestId('recent-destinations-list')).toBeNull();
  });

  it('즐겨찾기 역을 포함한 최근 3개가 전부 렌더된다 (dedup 필터 없음)', () => {
    const recents = [gangnam, hongdae, seoul];
    const { getByTestId, getByText } = renderWithTheme(
      <RecentDestinationList
        recents={recents}
        favorites={[fav(gangnam), fav(hongdae)]}
        onSelect={jest.fn()}
        onRemove={jest.fn()}
      />,
    );
    for (const { id } of recents) {
      expect(getByTestId(`recent-destination-button-${id}`)).toBeTruthy();
    }
    expect(getByText(canonicalStationName('강남', '2'))).toBeTruthy();
    expect(getByText(canonicalStationName('홍대입구', '2'))).toBeTruthy();
  });

  it('즐겨찾기 소속 행에만 ★ 마커가 있고 a11y label을 가진다', () => {
    const { getByTestId, queryByTestId } = renderWithTheme(
      <RecentDestinationList
        recents={[gangnam, hongdae]}
        favorites={[fav(gangnam)]}
        onSelect={jest.fn()}
        onRemove={jest.fn()}
      />,
    );
    const marker = getByTestId(markerId(gangnam.id));
    expect(marker.props.accessibilityLabel).toBe('즐겨찾기');
    expect(within(getByTestId(`recent-destination-button-${gangnam.id}`)).getByText('★')).toBeTruthy();
    expect(queryByTestId(markerId(hongdae.id))).toBeNull();
  });

  it('역명이 같아도 노선(id)이 다르면 ★가 없다', () => {
    const seoul4 = findStationByNameAndLine('서울역', '4')!;
    const { getByTestId, queryByTestId } = renderWithTheme(
      <RecentDestinationList
        recents={[seoul, seoul4]}
        favorites={[fav(seoul)]}
        onSelect={jest.fn()}
        onRemove={jest.fn()}
      />,
    );
    expect(getByTestId(markerId(seoul.id))).toBeTruthy();
    expect(queryByTestId(markerId(seoul4.id))).toBeNull();
  });

  it('행 탭은 onSelect(station), ✕ 탭은 onRemove(id)', () => {
    const onSelect = jest.fn();
    const onRemove = jest.fn();
    const { getByTestId } = renderWithTheme(
      <RecentDestinationList recents={[gangnam]} favorites={[]} onSelect={onSelect} onRemove={onRemove} />,
    );
    fireEvent.press(getByTestId(`recent-destination-button-${gangnam.id}`));
    expect(onSelect).toHaveBeenCalledWith(gangnam);
    fireEvent.press(getByTestId(`recent-destination-delete-${gangnam.id}`));
    expect(onRemove).toHaveBeenCalledWith(gangnam.id);
  });
});
