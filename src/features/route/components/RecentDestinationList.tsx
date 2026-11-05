import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing, radiusGlass } from '../../../shared/theme';
import { SolidLineBadge } from '../../../shared/ui/SolidLineBadge';
import type { FavoriteEntry, Station } from '../../../shared/types/station';
import { getStationDisplayName } from '../../../shared/utils/stationDisplay';

interface Props {
  recents: readonly Station[];
  favorites: readonly FavoriteEntry[];
  onSelect: (station: Station) => void;
  onRemove: (stationId: string) => void;
}

/** 홈 '이전 목적지' — 실제 최근 트립을 그대로 보여주고, 즐겨찾기 소속 역(id 기준)에는 ★를 붙인다. */
export function RecentDestinationList({ recents, favorites, onSelect, onRemove }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const favoriteIds = useMemo(() => new Set(favorites.map(({ station }) => station.id)), [favorites]);

  if (recents.length === 0) return null;

  return (
    <View testID="recent-destinations-list">
      <Text style={[styles.label, { color: colors.muted, paddingHorizontal: spacing.xs }]}>
        {t('home.previousDestination')}
      </Text>
      {recents.map((recent) => (
        <View
          key={recent.id}
          style={[styles.button, styles.itemRow, { backgroundColor: colors.glass, borderColor: colors.glassBorder }]}
        >
          <TouchableOpacity
            style={styles.tapArea}
            onPress={() => onSelect(recent)}
            testID={`recent-destination-button-${recent.id}`}
          >
            <View style={styles.row}>
              <View style={styles.nameGroup}>
                <Text style={[styles.name, { color: colors.ink }]}>{getStationDisplayName(recent)}</Text>
                {favoriteIds.has(recent.id) && (
                  <Text
                    style={[styles.star, { color: colors.accent }]}
                    accessibilityLabel={t('a11y.route.favoriteMarkerLabel')}
                    testID={`recent-destination-favorite-marker-${recent.id}`}
                  >
                    ★
                  </Text>
                )}
              </View>
              <SolidLineBadge line={recent.line} color={recent.lineColor} />
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.deleteButton}
            onPress={() => onRemove(recent.id)}
            accessibilityLabel={t('common.remove')}
            testID={`recent-destination-delete-${recent.id}`}
          >
            <Text style={[styles.deleteText, { color: colors.muted }]}>✕</Text>
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    borderWidth: 1,
    borderRadius: radiusGlass.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  tapArea: {
    flex: 1,
  },
  deleteButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginLeft: spacing.sm,
  },
  deleteText: {
    ...typography.bodyMd,
    fontWeight: '700',
  },
  label: {
    ...typography.micro,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  nameGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  name: {
    ...typography.bodyMd,
    fontWeight: '700',
  },
  star: {
    ...typography.micro,
  },
});
