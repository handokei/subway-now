import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { lineTint, rgba } from '../theme/theme';
import { useLineTintStore } from '../theme/store/useLineTintStore';
import type { LineNumber } from '../types/station';

/**
 * 화면 뒤에 깔리는 노선색 글로우. SafeAreaView의 첫 자식으로 넣는다.
 * RN 0.81 `experimental_backgroundImage`(radial-gradient)로 blur 없이 부드러운 번짐을 만든다.
 * line prop을 넘기면 store 대신 그 노선을 쓴다(예: 지도 선택 카드).
 */
export function LineGlowBackground({ line, secondaryLine }: { line?: LineNumber | null; secondaryLine?: LineNumber | null }) {
  const { isDark } = useTheme();
  const storeLine = useLineTintStore((s) => s.line);
  const t = lineTint(line ?? storeLine, isDark);
  const t2 = secondaryLine ? lineTint(secondaryLine, isDark) : null;

  const glow = (color: string, style: ViewStyle) => (
    <View
      pointerEvents="none"
      style={[
        styles.blob,
        style,
        { experimental_backgroundImage: `radial-gradient(circle at center, ${color} 0%, transparent 70%)` },
      ]}
    />
  );

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {glow(t.glow, { width: 620, height: 620, left: -330, top: -330 })}
      {glow(t.glowSoft, { width: 460, height: 460, right: -250, top: 60 })}
      {t2 && glow(rgba(t2.base, isDark ? 0.3 : 0.35), { width: 520, height: 520, right: -280, top: 640 })}
    </View>
  );
}

const styles = StyleSheet.create({
  blob: { position: 'absolute', borderRadius: 9999 },
});
