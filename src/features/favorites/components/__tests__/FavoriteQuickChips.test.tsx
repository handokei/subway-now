import React from 'react';
import { fireEvent, within } from '@testing-library/react-native';
import { FavoriteQuickChips } from '../FavoriteQuickChips';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import { findStationByNameAndLine } from '../../../../shared/utils/stationLookup';
import type { FavoriteEntry } from '../../../../shared/types/station';

const gangnam = findStationByNameAndLine('강남', '2')!;
const seoul = findStationByNameAndLine('서울역', '1')!;
const hongdae = findStationByNameAndLine('홍대입구', '2')!;

const favorites: FavoriteEntry[] = [
  { station: gangnam, role: 'general' },
  { station: hongdae, role: 'work' },
  { station: seoul, role: 'home' },
];

describe('FavoriteQuickChips', () => {
  it('즐겨찾기가 0개면 섹션 전체를 렌더하지 않는다', () => {
    const { queryByTestId } = renderWithTheme(
      <FavoriteQuickChips favorites={[]} onSelect={jest.fn()} onAdd={jest.fn()} />,
    );
    expect(queryByTestId('home-favorite-chips')).toBeNull();
    expect(queryByTestId('home-favorite-add-chip')).toBeNull();
  });

  it('섹션 라벨과 역명 칩을 렌더한다', () => {
    const { getByText, getByTestId } = renderWithTheme(
      <FavoriteQuickChips favorites={favorites} onSelect={jest.fn()} onAdd={jest.fn()} />,
    );
    expect(getByText('바로 출발')).toBeTruthy();
    expect(getByTestId('home-favorite-chips')).toBeTruthy();
    expect(getByText(canonicalStationName('강남', '2'))).toBeTruthy();
  });

  it('home → work → general 순서로 칩을 배치한다', () => {
    const { getAllByTestId } = renderWithTheme(
      <FavoriteQuickChips favorites={favorites} onSelect={jest.fn()} onAdd={jest.fn()} />,
    );
    const ids = getAllByTestId(/^home-favorite-chip-/).map((n) => n.props.testID);
    expect(ids).toEqual([
      `home-favorite-chip-${seoul.id}`,
      `home-favorite-chip-${hongdae.id}`,
      `home-favorite-chip-${gangnam.id}`,
    ]);
  });

  it('집/회사는 i18n 라벨, general은 라벨 없이 역명만 보인다', () => {
    const { getByText, getByTestId } = renderWithTheme(
      <FavoriteQuickChips favorites={favorites} onSelect={jest.fn()} onAdd={jest.fn()} />,
    );
    expect(getByText('집')).toBeTruthy();
    expect(getByText('회사')).toBeTruthy();
    const generalChip = within(getByTestId(`home-favorite-chip-${gangnam.id}`));
    expect(generalChip.getByText(canonicalStationName('강남', '2'))).toBeTruthy();
    expect(generalChip.queryByText('집')).toBeNull();
    expect(generalChip.queryByText('회사')).toBeNull();
  });

  it('사용자 지정 label이 있으면 역명 대신 label을 표시한다 (DestinationPicker와 동일)', () => {
    const { getByText, queryByText } = renderWithTheme(
      <FavoriteQuickChips
        favorites={[{ station: gangnam, role: 'general', label: '헬스장' }]}
        onSelect={jest.fn()}
        onAdd={jest.fn()}
      />,
    );
    expect(getByText('헬스장')).toBeTruthy();
    expect(queryByText(canonicalStationName('강남', '2'))).toBeNull();
  });

  it('칩에 accessibilityLabel/Hint를 달고 이모지 아이콘은 스크린리더에서 숨긴다', () => {
    const { getByTestId, getByText } = renderWithTheme(
      <FavoriteQuickChips favorites={favorites} onSelect={jest.fn()} onAdd={jest.fn()} />,
    );
    const generalChip = getByTestId(`home-favorite-chip-${gangnam.id}`);
    expect(generalChip.props.accessibilityLabel).toBe(canonicalStationName('강남', '2'));
    expect(generalChip.props.accessibilityHint).toBe('탭하여 이 역을 목적지로 선택');
    const homeChip = getByTestId(`home-favorite-chip-${seoul.id}`);
    expect(homeChip.props.accessibilityLabel).toBe(`집 ${canonicalStationName('서울역', '1')}`);
    expect(getByText('🏠', { includeHiddenElements: true }).props.accessibilityElementsHidden).toBe(true);
  });

  it('칩 탭 시 해당 station으로 onSelect를 호출한다', () => {
    const onSelect = jest.fn();
    const { getByTestId } = renderWithTheme(
      <FavoriteQuickChips favorites={favorites} onSelect={onSelect} onAdd={jest.fn()} />,
    );
    fireEvent.press(getByTestId(`home-favorite-chip-${hongdae.id}`));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(hongdae);
  });

  it("'+ 추가' 칩 탭 시 onAdd를 호출한다", () => {
    const onAdd = jest.fn();
    const onSelect = jest.fn();
    const { getByTestId } = renderWithTheme(
      <FavoriteQuickChips favorites={favorites} onSelect={onSelect} onAdd={onAdd} />,
    );
    fireEvent.press(getByTestId('home-favorite-add-chip'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
