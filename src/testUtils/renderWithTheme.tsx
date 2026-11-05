import React from 'react';
import { render, type RenderOptions } from '@testing-library/react-native';
import { ThemeProvider } from '../shared/theme';

/**
 * ThemeProvider로 래핑하여 렌더링하는 테스트 유틸리티.
 * useTheme() 의존 컴포넌트 테스트 시 사용.
 *
 * 다크모드 테스트: jest.spyOn(RN, 'useColorScheme').mockReturnValue('dark') 후 호출.
 */
export function renderWithTheme(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
) {
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <ThemeProvider>{children}</ThemeProvider>
  );
  return render(ui, { wrapper: Wrapper, ...options });
}
