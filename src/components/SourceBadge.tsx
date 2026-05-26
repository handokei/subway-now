import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, radius, withAlpha } from '../theme';
import type { FusionSource } from '../utils/pickFusedStation';

interface SourceBadgeProps {
  source: FusionSource;
  locationUncertain?: boolean;
  testID?: string;
}

type BadgeKey = 'positionTrain' | 'routeProgress' | 'gpsOnly' | 'uncertain';

// position/arrival은 모두 열차 데이터 기반이라 동일 그룹으로 묶는다.
// 사용자에겐 "데이터 출처의 신뢰도"가 의미 있고, 내부 fusion 알고리즘 구분은 의미 없음.
function resolveBadgeKey(source: FusionSource, locationUncertain: boolean): BadgeKey {
  if (locationUncertain) return 'uncertain';
  switch (source) {
    case 'position-train':
    case 'position':
    case 'arrival':
      return 'positionTrain';
    case 'route-progress':
      return 'routeProgress';
    case 'gps':
      return 'gpsOnly';
    /* istanbul ignore next -- FusionSource 유니온이 위 case와 동기화되므로 도달 불가. 새 값 추가 시 컴파일 타임에 잡힘 */
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

export function SourceBadge({ source, locationUncertain = false, testID }: SourceBadgeProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const key = resolveBadgeKey(source, locationUncertain);

  const palette: Record<BadgeKey, { bg: string; fg: string }> = {
    positionTrain: { bg: withAlpha(colors.success, 0.13), fg: colors.success },
    routeProgress: { bg: colors.hair, fg: colors.ink },
    gpsOnly: { bg: withAlpha(colors.warn, 0.13), fg: colors.warn },
    uncertain: { bg: colors.hair, fg: colors.muted },
  };
  const { bg, fg } = palette[key];

  return (
    <View style={[styles.badge, { backgroundColor: bg }]} testID={testID}>
      <Text style={[styles.label, { color: fg }]}>{t(`source.${key}`)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
});
