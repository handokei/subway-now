import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing, radiusGlass } from '../../../shared/theme';
import { SolidLineBadge } from '../../../shared/ui/SolidLineBadge';
import { FAVORITE_SLOT_ICONS, isFavoriteSlotRole } from '../../../shared/types/station';
import type { FavoriteEntry, Station } from '../../../shared/types/station';
import { getStationDisplayName } from '../../../shared/utils/stationDisplay';
import { sortFavoritesByRole } from '../../../shared/utils/sortFavoritesByRole';

interface Props {
  favorites: readonly FavoriteEntry[];
  onSelect: (station: Station) => void;
  onAdd: () => void;
}

/** 홈 목적지 미설정 블록의 '바로 출발' 즐겨찾기 칩 행. 즐겨찾기 0개면 미렌더. */
export function FavoriteQuickChips({ favorites, onSelect, onAdd }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const chips = useMemo(() => sortFavoritesByRole(favorites), [favorites]);

  if (chips.length === 0) return null;

  const chipSurface = { backgroundColor: colors.glass, borderColor: colors.glassBorder };

  return (
    <View style={styles.section} testID="home-favorite-chips">
      <Text style={[styles.label, { color: colors.muted }]}>{t('home.quickDeparture')}</Text>
      <View style={styles.row}>
        {chips.map(({ station, role, label }) => {
          const { id, line, lineColor } = station;
          const isSlot = isFavoriteSlotRole(role);
          const name = label ?? getStationDisplayName(station);
          const a11yLabel = isSlot ? `${t(`favorites.${role}`)} ${name}` : name;
          return (
            <TouchableOpacity
              key={id}
              style={[styles.chip, chipSurface]}
              onPress={() => onSelect(station)}
              testID={`home-favorite-chip-${id}`}
              accessibilityRole="button"
              accessibilityLabel={a11yLabel}
              accessibilityHint={t('a11y.route.favoriteChipHint')}
            >
              {isSlot && (
                <Text style={styles.icon} accessibilityElementsHidden importantForAccessibility="no">
                  {FAVORITE_SLOT_ICONS[role]}
                </Text>
              )}
              {isSlot && <Text style={[styles.roleText, { color: colors.muted }]}>{t(`favorites.${role}`)}</Text>}
              <Text style={[styles.name, { color: colors.ink }]}>{name}</Text>
              <SolidLineBadge line={line} color={lineColor} />
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity
          style={[styles.chip, chipSurface]}
          onPress={onAdd}
          testID="home-favorite-add-chip"
          accessibilityRole="button"
        >
          <Text style={[styles.name, { color: colors.muted }]}>{t('home.quickDepartureAdd')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: spacing.lg },
  label: { ...typography.micro, fontWeight: '600', letterSpacing: 0.5, marginBottom: 4, paddingHorizontal: spacing.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: radiusGlass.pill,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  icon: { fontSize: 14 },
  roleText: { ...typography.micro, fontWeight: '600' },
  name: { ...typography.micro, fontWeight: '600' },
});
