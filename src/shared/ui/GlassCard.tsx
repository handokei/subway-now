import React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { useTheme, radiusGlass } from '../theme';
import { ShadowCaster } from './ShadowCaster';

interface Props {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 지도처럼 배경이 복잡한 곳 */
  strong?: boolean;
  /** 카드 모서리 (기본 radiusGlass.lg = 26) */
  r?: number;
  intensity?: number;
  testID?: string;
}

/**
 * Line Glass 카드: BlurView + 반투명 채움 + 1px 테두리 + 상단 하이라이트.
 * 그림자는 legacy shadow props(구아키 호환)라 overflow:hidden 뷰에서 잘리고, 반투명 뷰에 주면
 * 텍스트마다 번지므로 불투명 ShadowCaster sibling에만 준다. 글래스 채움·blur·테두리는 클리핑 레이어.
 * Android는 BlurView 성능/품질 이슈가 있어 채움만 진하게(fallback).
 */
export function GlassCard({ children, style, strong, r = radiusGlass.lg, intensity = 40, testID }: Props) {
  const { colors } = useTheme();
  const useBlur = Platform.OS === 'ios';
  const fill = useBlur ? (strong ? colors.glassStrong : colors.glass) : colors.glassFallback;
  return (
    <View
      testID={testID}
      style={[styles.wrap, { borderRadius: r }, style]}
    >
      <ShadowCaster kind="card" r={r} />
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.clip, { borderRadius: r, borderColor: colors.glassBorder, backgroundColor: fill }]}
      >
        {useBlur && <BlurView intensity={intensity} tint={colors.blurTint} style={StyleSheet.absoluteFill} />}
        <View style={[styles.highlight, { backgroundColor: colors.glassHighlight, left: r * 0.6, right: r * 0.6 }]} />
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 20 },
  clip: { borderWidth: StyleSheet.hairlineWidth * 2, overflow: 'hidden' },
  highlight: { position: 'absolute', top: 0, height: 1 },
});
