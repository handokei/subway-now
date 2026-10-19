import React from 'react';
import { Platform, StyleSheet, Text } from 'react-native';
import { screen } from '@testing-library/react-native';
import * as RN from 'react-native';
import { GlassCard } from '../GlassCard';
import { lightColors, darkColors, radius } from '../../theme';
import { renderWithTheme } from '../../../testUtils/renderWithTheme';

const mockUseColorScheme = jest.spyOn(RN, 'useColorScheme');
const originalOS = Platform.OS;

function setOS(os: string) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

describe('GlassCard', () => {
  beforeEach(() => {
    mockUseColorScheme.mockReturnValue('light');
    setOS('ios');
  });

  afterEach(() => {
    mockUseColorScheme.mockReset();
    setOS(originalOS);
  });

  it('children과 testID를 렌더링한다', () => {
    renderWithTheme(
      <GlassCard testID="glass">
        <Text>내용</Text>
      </GlassCard>,
    );
    expect(screen.getByText('내용')).toBeTruthy();
    expect(screen.getByTestId('glass')).toBeTruthy();
  });

  it('iOS: 투명 배경 + 기본 radius.lg + 테두리 glassBorder', () => {
    renderWithTheme(<GlassCard testID="glass"><Text>x</Text></GlassCard>);
    const flat = StyleSheet.flatten(screen.getByTestId('glass').props.style);
    expect(flat.backgroundColor).toBe('transparent');
    expect(flat.borderRadius).toBe(radius.lg);
    expect(flat.borderColor).toBe(lightColors.glassBorder);
    expect(flat.boxShadow).toContain('rgba(0,60,30,0.18)');
  });

  it('strong=true면 glassStrong 채움을 쓴다', () => {
    const { toJSON } = renderWithTheme(<GlassCard strong><Text>x</Text></GlassCard>);
    expect(JSON.stringify(toJSON())).toContain(lightColors.glassStrong);
  });

  it('strong 미지정이면 glass 채움을 쓴다', () => {
    const { toJSON } = renderWithTheme(<GlassCard><Text>x</Text></GlassCard>);
    const json = JSON.stringify(toJSON());
    expect(json).toContain(lightColors.glass);
    expect(json).not.toContain(lightColors.glassStrong);
  });

  it('r prop이 모서리에 반영된다', () => {
    renderWithTheme(<GlassCard testID="glass" r={10}><Text>x</Text></GlassCard>);
    expect(StyleSheet.flatten(screen.getByTestId('glass').props.style).borderRadius).toBe(10);
  });

  it('다크 모드: 다크 그림자와 glassBorder', () => {
    mockUseColorScheme.mockReturnValue('dark');
    renderWithTheme(<GlassCard testID="glass"><Text>x</Text></GlassCard>);
    const flat = StyleSheet.flatten(screen.getByTestId('glass').props.style);
    expect(flat.borderColor).toBe(darkColors.glassBorder);
    expect(flat.boxShadow).toContain('rgba(0,0,0,0.6)');
  });

  it('Android 라이트: blur 없이 진한 흰색 fallback 채움', () => {
    setOS('android');
    renderWithTheme(<GlassCard testID="glass"><Text>x</Text></GlassCard>);
    expect(StyleSheet.flatten(screen.getByTestId('glass').props.style).backgroundColor).toBe('rgba(255,255,255,0.86)');
  });

  it('Android 다크: 진한 어두운 fallback 채움', () => {
    setOS('android');
    mockUseColorScheme.mockReturnValue('dark');
    renderWithTheme(<GlassCard testID="glass"><Text>x</Text></GlassCard>);
    expect(StyleSheet.flatten(screen.getByTestId('glass').props.style).backgroundColor).toBe('rgba(24,28,26,0.92)');
  });

  it('커스텀 style을 병합한다', () => {
    renderWithTheme(<GlassCard testID="glass" style={{ marginTop: 7 }}><Text>x</Text></GlassCard>);
    expect(StyleSheet.flatten(screen.getByTestId('glass').props.style).marginTop).toBe(7);
  });
});
