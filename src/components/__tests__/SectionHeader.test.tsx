import React from 'react';
import { StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';
import { SectionHeader } from '../SectionHeader';
import { lightColors, darkColors } from '../../shared/theme';
import { renderWithTheme } from '../../testUtils/renderWithTheme';
import * as RN from 'react-native';

const mockUseColorScheme = jest.spyOn(RN, 'useColorScheme');

describe('SectionHeader', () => {
  beforeEach(() => {
    mockUseColorScheme.mockReturnValue('light');
  });

  afterEach(() => {
    mockUseColorScheme.mockReset();
  });

  it('라벨 텍스트를 렌더링한다', () => {
    renderWithTheme(<SectionHeader label="열차 도착 정보" />);
    expect(screen.getByText('열차 도착 정보')).toBeTruthy();
  });

  it('라이트 모드에서 색상이 lightColors.muted이다', () => {
    renderWithTheme(<SectionHeader label="섹션" />);
    const flat = StyleSheet.flatten(screen.getByText('섹션').props.style);
    expect(flat.color).toBe(lightColors.muted);
  });

  it('다크 모드에서 색상이 darkColors.muted이다', () => {
    mockUseColorScheme.mockReturnValue('dark');
    renderWithTheme(<SectionHeader label="섹션" />);
    const flat = StyleSheet.flatten(screen.getByText('섹션').props.style);
    expect(flat.color).toBe(darkColors.muted);
  });

  it('uppercase 스타일이 적용된다', () => {
    renderWithTheme(<SectionHeader label="섹션" />);
    const flat = StyleSheet.flatten(screen.getByText('섹션').props.style);
    expect(flat.textTransform).toBe('uppercase');
  });

  it('커스텀 style을 병합한다', () => {
    renderWithTheme(<SectionHeader label="섹션" style={{ fontSize: 18 }} />);
    const flat = StyleSheet.flatten(screen.getByText('섹션').props.style);
    expect(flat.fontSize).toBe(18);
  });
});
