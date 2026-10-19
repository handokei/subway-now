import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { fireEvent, screen, act } from '@testing-library/react-native';
import * as RN from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { GlassTabBar, GLASS_TAB_BAR_CLEARANCE, GLASS_SCREEN_BOTTOM_PADDING } from '../GlassTabBar';
import { useLineTintStore } from '../../theme/store/useLineTintStore';
import { lineTint, lightColors, darkColors } from '../../theme';
import { renderWithTheme } from '../../../testUtils/renderWithTheme';

let mockBottomInset = 34;
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: mockBottomInset }),
}));

const mockUseColorScheme = jest.spyOn(RN, 'useColorScheme');

function makeProps(opts: { index?: number; prevented?: boolean; titles?: (string | undefined)[] } = {}) {
  const { index = 0, prevented = false, titles = ['현재', '지도', undefined] } = opts;
  const routes = titles.map((_, i) => ({ key: `k${i}`, name: `route${i}` }));
  const descriptors: Record<string, unknown> = {};
  routes.forEach((r, i) => {
    descriptors[r.key] = { options: { title: titles[i], tabBarButtonTestID: `tab-${i}` } };
  });
  const navigation = {
    emit: jest.fn(() => ({ defaultPrevented: prevented })),
    navigate: jest.fn(),
  };
  const props = { state: { index, routes }, descriptors, navigation } as unknown as BottomTabBarProps;
  return { props, navigation };
}

describe('GlassTabBar', () => {
  beforeEach(() => {
    mockUseColorScheme.mockReturnValue('light');
    mockBottomInset = 34;
    useLineTintStore.setState({ line: null });
  });

  afterEach(() => {
    mockUseColorScheme.mockReset();
  });

  it('title을 라벨로, title이 없으면 route.name을 라벨로 렌더링한다', () => {
    renderWithTheme(<GlassTabBar {...makeProps().props} />);
    expect(screen.getByText('현재')).toBeTruthy();
    expect(screen.getByText('지도')).toBeTruthy();
    expect(screen.getByText('route2')).toBeTruthy();
  });

  it('접근성: tab role + selected 상태 + testID', () => {
    renderWithTheme(<GlassTabBar {...makeProps({ index: 1 }).props} />);
    expect(screen.getByTestId('tab-1').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('tab-0').props.accessibilityState).toEqual({ selected: false });
    expect(screen.getByTestId('tab-0').props.accessibilityRole).toBe('tab');
    expect(screen.getByTestId('tab-0').props.accessibilityLabel).toBe('현재');
  });

  it('활성 탭은 현재 노선 틴트 배경 + 굵은 라벨, 비활성은 muted', () => {
    useLineTintStore.setState({ line: '1' });
    renderWithTheme(<GlassTabBar {...makeProps({ index: 0 }).props} />);
    const tint = lineTint('1', false);
    const active = StyleSheet.flatten(screen.getByTestId('tab-0').props.style);
    expect(active.backgroundColor).toBe(tint.tabActiveBg);
    const activeLabel = StyleSheet.flatten(screen.getByText('현재').props.style);
    expect(activeLabel.color).toBe(tint.text);
    expect(activeLabel.fontWeight).toBe('700');
    const inactiveLabel = StyleSheet.flatten(screen.getByText('지도').props.style);
    expect(inactiveLabel.color).toBe(lightColors.muted);
    expect(inactiveLabel.fontWeight).toBe('500');
  });

  it('store 노선이 바뀌면 활성 탭 색이 따라간다', () => {
    renderWithTheme(<GlassTabBar {...makeProps({ index: 0 }).props} />);
    act(() => useLineTintStore.getState().setLine('5'));
    expect(StyleSheet.flatten(screen.getByTestId('tab-0').props.style).backgroundColor).toBe(lineTint('5', false).tabActiveBg);
  });

  it('다크 모드: 비활성 라벨은 다크 muted', () => {
    mockUseColorScheme.mockReturnValue('dark');
    renderWithTheme(<GlassTabBar {...makeProps().props} />);
    expect(StyleSheet.flatten(screen.getByText('지도').props.style).color).toBe(darkColors.muted);
  });

  it('비활성 탭 press: tabPress emit 후 navigate', () => {
    const { props, navigation } = makeProps({ index: 0 });
    renderWithTheme(<GlassTabBar {...props} />);
    fireEvent.press(screen.getByTestId('tab-1'));
    expect(navigation.emit).toHaveBeenCalledWith({ type: 'tabPress', target: 'k1', canPreventDefault: true });
    expect(navigation.navigate).toHaveBeenCalledWith('route1');
  });

  it('이미 활성 탭 press: emit만 하고 navigate 안 함', () => {
    const { props, navigation } = makeProps({ index: 0 });
    renderWithTheme(<GlassTabBar {...props} />);
    fireEvent.press(screen.getByTestId('tab-0'));
    expect(navigation.emit).toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('tabPress가 preventDefault되면 navigate 안 함', () => {
    const { props, navigation } = makeProps({ index: 0, prevented: true });
    renderWithTheme(<GlassTabBar {...props} />);
    fireEvent.press(screen.getByTestId('tab-1'));
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('하단 inset이 12보다 크면 inset, 작으면 12', () => {
    const first = renderWithTheme(<GlassTabBar {...makeProps().props} />);
    expect(JSON.stringify(first.toJSON())).toContain('"bottom":34');
    first.unmount();
    mockBottomInset = 0;
    const second = renderWithTheme(<GlassTabBar {...makeProps().props} />);
    expect(JSON.stringify(second.toJSON())).toContain('"bottom":12');
  });

  describe('플랫폼/그림자/상수', () => {
    const originalOS = Platform.OS;
    afterEach(() => {
      Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
    });

    it('iOS: glassBar 채움 + legacy shadow(구아키 호환, boxShadow 없음)', () => {
      const { toJSON } = renderWithTheme(<GlassTabBar {...makeProps().props} />);
      const json = JSON.stringify(toJSON());
      expect(json).toContain(lightColors.glassBar);
      expect(json).toContain('"shadowRadius":15');
      expect(json).not.toContain('boxShadow');
    });

    it('Android: blur 없이 glassFallback 채움', () => {
      Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
      const { toJSON } = renderWithTheme(<GlassTabBar {...makeProps().props} />);
      const json = JSON.stringify(toJSON());
      expect(json).toContain(lightColors.glassFallback);
      expect(json).not.toContain(lightColors.glassBar);
    });

    it('콘텐츠 여백 상수는 탭바 클리어런스보다 크다(화면 결합 지점 단일화)', () => {
      expect(GLASS_SCREEN_BOTTOM_PADDING).toBeGreaterThan(GLASS_TAB_BAR_CLEARANCE);
    });
  });
});
