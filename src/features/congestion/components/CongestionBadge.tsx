import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing } from '../../../shared/theme';
import type { CongestionLevel } from '../../../shared/types/congestion';
import type { CongestionEntry } from '../../../shared/types/congestion';

interface CongestionBadgeProps {
  entry: CongestionEntry;
  testID?: string;
}

/**
 * 현재역 시간대 평균 혼잡도 인라인 배지.
 *
 * - 4단계 (low/medium/high/veryHigh)별 색상 + i18n 라벨.
 * - 보조 텍스트(`hint`)로 "지금 좌석 여유" 같은 차별화 문구 노출.
 * - 시간대 평균이라 실시간 X — `home.congestion.averageNote`로 명시.
 */
export function CongestionBadge({ entry, testID }: CongestionBadgeProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const tone = getLevelTone(entry.level, colors);
  return (
    <View
      style={[styles.container, { backgroundColor: tone.bg, borderColor: tone.border }]}
      accessibilityRole="text"
      accessibilityLabel={t('home.congestion.a11yLabel', {
        level: t(`home.congestion.level.${entry.level}`),
        raw: entry.raw,
      })}
      testID={testID}
    >
      <View style={[styles.dot, { backgroundColor: tone.dot }]} />
      <Text style={[typography.mono, { color: tone.text, fontWeight: '700' }]}>
        {t(`home.congestion.level.${entry.level}`)}
      </Text>
      <Text style={[typography.bodySm, { color: tone.text, marginLeft: 4 }]}>
        {t(`home.congestion.hint.${entry.level}`)}
      </Text>
    </View>
  );
}

interface LevelTone {
  bg: string;
  border: string;
  dot: string;
  text: string;
}

interface ThemeColorsLike {
  success: string;
  ink: string;
  muted: string;
  warn: string;
  accent: string;
  hair: string;
}

/**
 * 단계별 색 톤 매핑. 색상은 useTheme()의 의미색을 재사용해 다크/라이트 자동 대응.
 * 데이터 주도 — 단계 추가 시 entry 1줄만 추가하면 됨.
 */
export function getLevelTone(level: CongestionLevel, colors: ThemeColorsLike): LevelTone {
  const tones: Record<CongestionLevel, LevelTone> = {
    low: { bg: colors.hair, border: colors.hair, dot: colors.success, text: colors.success },
    medium: { bg: colors.hair, border: colors.hair, dot: colors.muted, text: colors.muted },
    high: { bg: colors.hair, border: colors.hair, dot: colors.warn, text: colors.warn },
    veryHigh: { bg: colors.hair, border: colors.hair, dot: colors.accent, text: colors.accent },
  };
  return tones[level];
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
