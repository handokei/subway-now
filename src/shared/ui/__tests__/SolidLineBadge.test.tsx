import React from 'react';
import { StyleSheet } from 'react-native';
import { renderWithTheme } from '../../../testUtils/renderWithTheme';
import { SolidLineBadge } from '../SolidLineBadge';
import { LINE_NAMES } from '../../constants/lineColors';

describe('SolidLineBadge', () => {
  it('노선 라벨을 표시하고 노선색 배경을 쓴다', () => {
    const { getByText, getByTestId } = renderWithTheme(
      <SolidLineBadge line="2" color="#009D3E" testID="badge" />,
    );
    expect(getByText(LINE_NAMES['2'])).toBeTruthy();
    expect(StyleSheet.flatten(getByTestId('badge').props.style).backgroundColor).toBe('#009D3E');
  });

  it('미등록 노선은 getLineLabel 폴백 라벨을 쓴다', () => {
    const { getByText } = renderWithTheme(<SolidLineBadge line="ZZ" color="#111111" />);
    expect(getByText('LINE ZZ')).toBeTruthy();
  });
});
