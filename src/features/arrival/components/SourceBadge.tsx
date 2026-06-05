/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, radius, withAlpha } from '../../../shared/theme';
import type { FusionSource } from '../../../shared/types/fusion';
import {
  resolveNotificationSource,
  notificationSourceI18nKey,
  shouldDiscloseNotificationSource,
  type NotificationSource,
} from '../../alarm/utils/notificationSource';

interface SourceBadgeProps {
  source: FusionSource;
  locationUncertain?: boolean;
  testID?: string;
}

// 자백 대상 source만 팔레트 정의 — positionTrain/routeProgress는 표시 안 함.
type DiscloseKey = Extract<NotificationSource, 'gpsOnly' | 'uncertain'>;

export function SourceBadge({ source, locationUncertain = false, testID }: SourceBadgeProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const key = resolveNotificationSource(source, locationUncertain);

  // 정상 신뢰 케이스(positionTrain/routeProgress)는 라벨이 사용자에게 노이즈 → 표시 안 함.
  if (!shouldDiscloseNotificationSource(key)) return null;
  // shouldDiscloseNotificationSource 가드 통과 후엔 key가 DiscloseKey로 좁혀짐.
  const discloseKey = key as DiscloseKey;

  const palette: Record<DiscloseKey, { bg: string; fg: string }> = {
    gpsOnly: { bg: withAlpha(colors.warn, 0.13), fg: colors.warn },
    uncertain: { bg: colors.hair, fg: colors.muted },
  };
  const { bg, fg } = palette[discloseKey];

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
