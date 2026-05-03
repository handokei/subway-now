import React from 'react';
import { renderHook } from '@testing-library/react-native';
import * as RN from 'react-native';
import { ThemeProvider, useTheme } from '../ThemeContext';
import { lightColors, darkColors } from '../theme';
import { useAppStore } from '../../store/useAppStore';

const mockUseColorScheme = jest.spyOn(RN, 'useColorScheme');

describe('ThemeContext', () => {
  beforeEach(() => {
    mockUseColorScheme.mockReturnValue('light');
    useAppStore.setState({ themeMode: 'auto' });
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

    it('auto 모드 + 라이트 시스템일 때 lightColors를 제공한다', () => {
      mockUseColorScheme.mockReturnValue('light');
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.colors).toBe(lightColors);
      expect(result.current.isDark).toBe(false);
    });

    it('auto 모드 + 다크 시스템일 때 darkColors를 제공한다', () => {
      mockUseColorScheme.mockReturnValue('dark');
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.colors).toBe(darkColors);
      expect(result.current.isDark).toBe(true);
    });

    it('auto 모드 + scheme null일 때 lightColors를 제공한다', () => {
      mockUseColorScheme.mockReturnValue(null);
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.colors).toBe(lightColors);
      expect(result.current.isDark).toBe(false);
    });

    it('light 모드이면 시스템 다크여도 lightColors를 제공한다', () => {
      useAppStore.setState({ themeMode: 'light' });
      mockUseColorScheme.mockReturnValue('dark');
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.colors).toBe(lightColors);
      expect(result.current.isDark).toBe(false);
    });

    it('dark 모드이면 시스템 라이트여도 darkColors를 제공한다', () => {
      useAppStore.setState({ themeMode: 'dark' });
      mockUseColorScheme.mockReturnValue('light');
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.colors).toBe(darkColors);
      expect(result.current.isDark).toBe(true);
    });
  });
});
