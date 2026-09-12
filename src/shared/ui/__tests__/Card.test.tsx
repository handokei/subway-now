import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { screen } from '@testing-library/react-native';
import { Card } from '../Card';
import { lightColors, darkColors } from '../../theme';
import { renderWithTheme } from '../../../testUtils/renderWithTheme';
import * as RN from 'react-native';

const mockUseColorScheme = jest.spyOn(RN, 'useColorScheme');

describe('Card', () => {
  beforeEach(() => {
    mockUseColorScheme.mockReturnValue('light');
  });

  afterEach(() => {
    mockUseColorScheme.mockReset();
  });

  it('children을 렌더링한다', () => {
    renderWithTheme(
      <Card>
        <Text>카드 내용</Text>
      </Card>,
    );
    expect(screen.getByText('카드 내용')).toBeTruthy();
  });

  it('라이트 모드에서 배경색이 lightColors.card이다', () => {
    renderWithTheme(
      <Card testID="card">
        <Text>내용</Text>
      </Card>,
    );
    const flat = StyleSheet.flatten(screen.getByTestId('card').props.style);
    expect(flat.backgroundColor).toBe(lightColors.card);
  });

  it('다크 모드에서 배경색이 darkColors.card이다', () => {
    mockUseColorScheme.mockReturnValue('dark');
    renderWithTheme(
      <Card testID="card">
        <Text>내용</Text>
      </Card>,
    );
    const flat = StyleSheet.flatten(screen.getByTestId('card').props.style);
    expect(flat.backgroundColor).toBe(darkColors.card);
  });

  it('커스텀 style을 병합한다', () => {
    renderWithTheme(
      <Card testID="card" style={{ marginTop: 20 }}>
        <Text>내용</Text>
      </Card>,
    );
    const flat = StyleSheet.flatten(screen.getByTestId('card').props.style);
    expect(flat.marginTop).toBe(20);
  });
});
