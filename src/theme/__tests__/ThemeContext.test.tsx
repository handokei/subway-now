import React from 'react';
import { renderHook } from '@testing-library/react-native';
import * as RN from 'react-native';
import { ThemeProvider, useTheme } from '../ThemeContext';
import { lightColors, darkColors } from '../theme';

const mockUseColorScheme = jest.spyOn(RN, 'useColorScheme');

describe('ThemeContext', () => {
  beforeEach(() => {
    mockUseColorScheme.mockReturnValue('light');
  });

  afterEach(() => {
    mockUseColorScheme.mockReset();
  });

  describe('useTheme (Provider 없이)', () => {
    it('기본값으로 lightColors를 반환한다', () => {
      const { result } = renderHook(() => useTheme());

      expect(result.current.colors).toBe(lightColors);
      expect(result.current.isDark).toBe(false);
    });

    it('시스템이 다크모드여도 Provider 없이는 lightColors 고정이다', () => {
      mockUseColorScheme.mockReturnValue('dark');
      const { result } = renderHook(() => useTheme());

      expect(result.current.colors).toBe(lightColors);
      expect(result.current.isDark).toBe(false);
    });
  });

  describe('ThemeProvider', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ThemeProvider>{children}</ThemeProvider>
    );

    it('라이트 모드일 때 lightColors를 제공한다', () => {
      mockUseColorScheme.mockReturnValue('light');
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.colors).toBe(lightColors);
      expect(result.current.isDark).toBe(false);
    });

    it('다크 모드일 때 darkColors를 제공한다', () => {
      mockUseColorScheme.mockReturnValue('dark');
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.colors).toBe(darkColors);
      expect(result.current.isDark).toBe(true);
    });

    it('scheme이 null일 때 lightColors를 제공한다', () => {
      mockUseColorScheme.mockReturnValue(null);
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.colors).toBe(lightColors);
      expect(result.current.isDark).toBe(false);
    });
  });
});
