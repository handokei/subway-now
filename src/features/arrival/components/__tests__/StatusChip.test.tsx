import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';
import * as RN from 'react-native';
import { StatusChip } from '../StatusChip';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { lightColors, darkColors } from '../../../../shared/theme';
import { StyleSheet } from 'react-native';

const mockUseColorScheme = jest.spyOn(RN, 'useColorScheme');

describe('StatusChip', () => {
  const onClear = jest.fn();

  beforeEach(() => {
    mockUseColorScheme.mockReturnValue('light');
    onClear.mockReset();
  });

  afterEach(() => {
    mockUseColorScheme.mockReset();
  });

  it('label을 렌더링한다', () => {
    renderWithTheme(
      <StatusChip label="도착역" name="강남" onClear={onClear} testID="chip-clear" />,
    );
    expect(screen.getByText('도착역')).toBeTruthy();
  });

  it('name을 렌더링한다', () => {
    renderWithTheme(
      <StatusChip label="도착역" name="강남" onClear={onClear} testID="chip-clear" />,
    );
    expect(screen.getByText('강남')).toBeTruthy();
  });

  it('닫기 버튼(✕)을 렌더링한다', () => {
    renderWithTheme(
      <StatusChip label="도착역" name="강남" onClear={onClear} testID="chip-clear" />,
    );
    expect(screen.getByText('✕')).toBeTruthy();
  });

  it('testID가 닫기 버튼에 적용된다', () => {
    renderWithTheme(
      <StatusChip label="도착역" name="강남" onClear={onClear} testID="chip-clear" />,
    );
    expect(screen.getByTestId('chip-clear')).toBeTruthy();
  });

  it('닫기 버튼 클릭 시 onClear를 호출한다', () => {
    renderWithTheme(
      <StatusChip label="도착역" name="강남" onClear={onClear} testID="chip-clear" />,
    );
    fireEvent.press(screen.getByTestId('chip-clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('라이트 모드에서 label 색상이 lightColors.accent이다', () => {
    renderWithTheme(
      <StatusChip label="도착역" name="강남" onClear={onClear} testID="chip-clear" />,
    );
    const flat = StyleSheet.flatten(screen.getByText('도착역').props.style);
    expect(flat.color).toBe(lightColors.accent);
  });

  it('라이트 모드에서 name 색상이 lightColors.ink이다', () => {
    renderWithTheme(
      <StatusChip label="도착역" name="강남" onClear={onClear} testID="chip-clear" />,
    );
    const flat = StyleSheet.flatten(screen.getByText('강남').props.style);
    expect(flat.color).toBe(lightColors.ink);
  });

  it('다크 모드에서 label 색상이 darkColors.accent이다', () => {
    mockUseColorScheme.mockReturnValue('dark');
    renderWithTheme(
      <StatusChip label="도착역" name="강남" onClear={onClear} testID="chip-clear" />,
    );
    const flat = StyleSheet.flatten(screen.getByText('도착역').props.style);
    expect(flat.color).toBe(darkColors.accent);
  });

  it('다크 모드에서 name 색상이 darkColors.ink이다', () => {
    mockUseColorScheme.mockReturnValue('dark');
    renderWithTheme(
      <StatusChip label="도착역" name="강남" onClear={onClear} testID="chip-clear" />,
    );
    const flat = StyleSheet.flatten(screen.getByText('강남').props.style);
    expect(flat.color).toBe(darkColors.ink);
  });

  it('다크 모드에서 닫기 버튼 색상이 darkColors.muted이다', () => {
    mockUseColorScheme.mockReturnValue('dark');
    renderWithTheme(
      <StatusChip label="도착역" name="강남" onClear={onClear} testID="chip-clear" />,
    );
    const flat = StyleSheet.flatten(screen.getByText('✕').props.style);
    expect(flat.color).toBe(darkColors.muted);
  });

  it('name에 numberOfLines={1}이 적용된다', () => {
    renderWithTheme(
      <StatusChip label="도착역" name="긴역이름이들어가는경우테스트" onClear={onClear} testID="chip-clear" />,
    );
    expect(screen.getByText('긴역이름이들어가는경우테스트').props.numberOfLines).toBe(1);
  });
});
