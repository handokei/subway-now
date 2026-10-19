import React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { useTheme, radius } from '../theme';

interface Props {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 지도처럼 배경이 복잡한 곳 */
  strong?: boolean;
  /** 카드 모서리 (기본 radius.lg = 26) */
  r?: number;
  intensity?: number;
  testID?: string;
}

/**
 * Line Glass 카드: BlurView + 반투명 채움 + 1px 테두리 + 상단 하이라이트.
 * Android는 BlurView 성능/품질 이슈가 있어 채움만 진하게(fallback).
 */
export function GlassCard({ children, style, strong, r = radius.lg, intensity = 40, testID }: Props) {
  const { colors, isDark } = useTheme();
  const fill = strong ? colors.glassStrong : colors.glass;
  const useBlur = Platform.OS === 'ios';
  return (
    <View
      testID={testID}
      style={[
        styles.wrap,
        {
          borderRadius: r,
          borderColor: colors.glassBorder,
          backgroundColor: useBlur ? 'transparent' : (isDark ? 'rgba(24,28,26,0.92)' : 'rgba(255,255,255,0.86)'),
          boxShadow: isDark
            ? '0 20px 40px -20px rgba(0,0,0,0.6)'
            : '0 10px 30px -14px rgba(0,60,30,0.18)',
        },
        style,
      ]}
    >
      {useBlur && (
        <BlurView intensity={intensity} tint={colors.blurTint} style={[StyleSheet.absoluteFill, { borderRadius: r }]} />
      )}
      {useBlur && <View style={[StyleSheet.absoluteFill, { backgroundColor: fill, borderRadius: r }]} />}
      <View style={[styles.highlight, { backgroundColor: colors.glassHighlight, left: r * 0.6, right: r * 0.6 }]} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderWidth: StyleSheet.hairlineWidth * 2, overflow: 'hidden', padding: 20 },
  highlight: { position: 'absolute', top: 0, height: 1 },
});
