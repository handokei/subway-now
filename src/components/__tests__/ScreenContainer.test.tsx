import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { screen } from '@testing-library/react-native';
import { ScreenContainer } from '../ScreenContainer';
import { lightColors, darkColors } from '../../theme';
import { renderWithTheme } from '../../testUtils/renderWithTheme';
import * as RN from 'react-native';

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return { SafeAreaView: View };
});

const mockUseColorScheme = jest.spyOn(RN, 'useColorScheme');

describe('ScreenContainer', () => {
  beforeEach(() => {
    mockUseColorScheme.mockReturnValue('light');
  });

  afterEach(() => {
    mockUseColorScheme.mockReset();
  });

  it('children을 렌더링한다', () => {
    renderWithTheme(
      <ScreenContainer>
        <Text>테스트</Text>
      </ScreenContainer>,
    );
    expect(screen.getByText('테스트')).toBeTruthy();
  });

  it('라이트 모드에서 배경색이 lightColors.bg이다', () => {
    renderWithTheme(
      <ScreenContainer testID="screen">
        <Text>내용</Text>
      </ScreenContainer>,
    );
    const flat = StyleSheet.flatten(screen.getByTestId('screen').props.style);
    expect(flat.backgroundColor).toBe(lightColors.bg);
  });

  it('다크 모드에서 배경색이 darkColors.bg이다', () => {
    mockUseColorScheme.mockReturnValue('dark');
    renderWithTheme(
      <ScreenContainer testID="screen">
        <Text>내용</Text>
      </ScreenContainer>,
    );
    const flat = StyleSheet.flatten(screen.getByTestId('screen').props.style);
    expect(flat.backgroundColor).toBe(darkColors.bg);
  });

  it('커스텀 style을 병합한다', () => {
    renderWithTheme(
      <ScreenContainer testID="screen" style={{ paddingTop: 10 }}>
        <Text>내용</Text>
      </ScreenContainer>,
    );
    const flat = StyleSheet.flatten(screen.getByTestId('screen').props.style);
    expect(flat.paddingTop).toBe(10);
  });
});
