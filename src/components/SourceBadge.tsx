import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, radius, withAlpha } from '../theme';
import type { FusionSource } from '../utils/pickFusedStation';
import {
  resolveNotificationSource,
  notificationSourceI18nKey,
  type NotificationSource,
} from '../utils/notificationSource';

interface SourceBadgeProps {
  source: FusionSource;
  locationUncertain?: boolean;
  testID?: string;
}

export function SourceBadge({ source, locationUncertain = false, testID }: SourceBadgeProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const key = resolveNotificationSource(source, locationUncertain);

  const palette: Record<NotificationSource, { bg: string; fg: string }> = {
    positionTrain: { bg: withAlpha(colors.success, 0.13), fg: colors.success },
    routeProgress: { bg: colors.hair, fg: colors.ink },
    gpsOnly: { bg: withAlpha(colors.warn, 0.13), fg: colors.warn },
    uncertain: { bg: colors.hair, fg: colors.muted },
  };
  const { bg, fg } = palette[key];

  return (
    <View style={[styles.badge, { backgroundColor: bg }]} testID={testID}>
      <Text style={[styles.label, { color: fg }]}>{t(notificationSourceI18nKey(key))}</Text>
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
