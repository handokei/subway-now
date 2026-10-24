import React from 'react';
import * as RN from 'react-native';
import { act } from '@testing-library/react-native';
import { LineGlowBackground } from '../LineGlowBackground';
import { useLineTintStore } from '../../theme/store/useLineTintStore';
import { lineTint, withAlpha } from '../../theme';
import { renderWithTheme } from '../../../testUtils/renderWithTheme';

const mockUseColorScheme = jest.spyOn(RN, 'useColorScheme');

describe('LineGlowBackground', () => {
  beforeEach(() => {
    mockUseColorScheme.mockReturnValue('light');
    useLineTintStore.setState({ line: null });
  });

  afterEach(() => {
    mockUseColorScheme.mockReset();
  });

  it('store/prop 모두 없으면 기본 노선색 글로우 2개를 그린다', () => {
    const { toJSON } = renderWithTheme(<LineGlowBackground />);
    const json = JSON.stringify(toJSON());
    expect(json).toContain(lineTint(null, false).glow);
    expect(json).toContain(lineTint(null, false).glowSoft);
  });

  it('store 노선이 반영된다', () => {
    useLineTintStore.setState({ line: '1' });
    const { toJSON } = renderWithTheme(<LineGlowBackground />);
    expect(JSON.stringify(toJSON())).toContain(lineTint('1', false).glow);
  });

  it('line prop이 store보다 우선한다', () => {
    useLineTintStore.setState({ line: '1' });
    const { toJSON } = renderWithTheme(<LineGlowBackground line="5" />);
    const json = JSON.stringify(toJSON());
    expect(json).toContain(lineTint('5', false).glow);
    expect(json).not.toContain(lineTint('1', false).glow);
  });

  it('store 변경 시 글로우가 따라간다', () => {
    const { toJSON } = renderWithTheme(<LineGlowBackground />);
    act(() => useLineTintStore.getState().setLine('3'));
    expect(JSON.stringify(toJSON())).toContain(lineTint('3', false).glow);
  });

  it('secondaryLine이 없으면 글로우는 2개다', () => {
    const { toJSON } = renderWithTheme(<LineGlowBackground />);
    expect(JSON.stringify(toJSON()).match(/"borderRadius":9999/g)?.length).toBe(2);
  });

  it('secondaryLine(라이트): 0.35 알파 3번째 글로우', () => {
    const { toJSON } = renderWithTheme(<LineGlowBackground line="2" secondaryLine="4" />);
    const json = JSON.stringify(toJSON());
    expect(json).toContain(withAlpha(lineTint('4', false).base, 0.35));
    expect(json.match(/"borderRadius":9999/g)?.length).toBe(3);
  });

  it('secondaryLine(다크): 0.3 알파 3번째 글로우', () => {
    mockUseColorScheme.mockReturnValue('dark');
    const { toJSON } = renderWithTheme(<LineGlowBackground line="2" secondaryLine="4" />);
    expect(JSON.stringify(toJSON())).toContain(withAlpha(lineTint('4', true).base, 0.3));
  });

  it('터치를 가로채지 않는다(pointerEvents none)', () => {
    const { toJSON } = renderWithTheme(<LineGlowBackground />);
    expect(JSON.stringify(toJSON())).toContain('"pointerEvents":"none"');
  });
});
