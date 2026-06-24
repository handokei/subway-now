import { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useFavoritesStore } from '../features/favorites/store/useFavoritesStore';
import { LINE_NAMES } from '../shared/constants/lineColors';
import {
  FAVORITE_SLOT_ICONS,
  FAVORITE_SLOT_ROLES,
  isFavoriteSlotRole,
  type FavoriteEntry,
  type FavoriteSlotRole,
  type Station,
} from '../shared/types/station';
import { useArrivalInfo } from '../features/arrival/hooks/useArrivalInfo';
import { useArrivalCountdown } from '../features/arrival/hooks/useArrivalCountdown';
import { formatArrivalTime } from '../shared/utils/formatTime';
import { getStationDisplayName, matchesStationQuery } from '../shared/utils/stationDisplay';
import { useTheme, typography, type ThemeColors } from '../shared/theme';
import stationsData from '../data/stations.json';
import { ArrivalSourceNotice } from '../features/arrival/components/ArrivalSourceNotice';
import type { StationArrival } from '../features/arrival/api/arrivalApi';

const allStations = stationsData as Station[];

export default function FavoritesScreen() {
  const favorites = useFavoritesStore((s) => s.favorites);
  const addFavorite = useFavoritesStore((s) => s.addFavorite);
  const removeFavorite = useFavoritesStore((s) => s.removeFavorite);
  const setFavoriteLabel = useFavoritesStore((s) => s.setFavoriteLabel);
  const setSlotFavorite = useFavoritesStore((s) => s.setSlotFavorite);
  const loadFavorites = useFavoritesStore((s) => s.loadFavorites);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [slotPicker, setSlotPicker] = useState<FavoriteSlotRole | null>(null);
  const { colors } = useTheme();
  const { t } = useTranslation();

  useEffect(() => {
    loadFavorites();
  }, []);

  const selectedStation = useMemo(
    () => favorites.find(({ station }) => station.id === selectedId)?.station ?? null,
    [favorites, selectedId],
  );
  const slotByRole = useMemo(() => {
    const map = new Map<FavoriteSlotRole, FavoriteEntry>();
    favorites.forEach((entry) => {
      if (isFavoriteSlotRole(entry.role)) {
        map.set(entry.role, entry);
      }
    });
    return map;
  }, [favorites]);
  const generalFavorites = useMemo(
    () => favorites.filter((entry) => entry.role === 'general'),
    [favorites],
  );
  const { arrival: rawArrival } = useArrivalInfo(
    selectedStation?.name ?? null,
    selectedStation?.line ?? null,
  );
  const arrival = useArrivalCountdown(rawArrival);

  const searchResults = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const lower = trimmed.toLowerCase();
    return allStations.filter((s) => matchesStationQuery(s, trimmed, lower)).slice(0, 20);
  }, [query]);

  const isSearching = query.trim().length > 0;

  const handleToggleSelect = (id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={[styles.header, { color: colors.muted }]}>{t('favorites.title')}</Text>

        <TextInput
          style={[styles.searchInput, { backgroundColor: colors.card, color: colors.ink, borderColor: colors.hair }]}
          placeholder={t('favorites.searchPlaceholder')}
          placeholderTextColor={colors.muted}
          value={query}
          onChangeText={setQuery}
          testID="favorites-search-input"
        />

        {isSearching ? (
          searchResults.length === 0 ? (
            <View style={styles.empty}>
              <Text style={[styles.emptyTitle, { color: colors.ink }]}>{t('favorites.noSearchResults')}</Text>
            </View>
          ) : (
            searchResults.map((station) => (
              <SearchResultCard
                key={station.id}
                station={station}
                already={favorites.some((f) => f.station.id === station.id)}
                onAdd={() => addFavorite(station)}
                colors={colors}
              />
            ))
          )
        ) : (
          <>
            <View style={styles.slotRow}>
              {FAVORITE_SLOT_ROLES.map((role) => (
                <SlotCard
                  key={role}
                  role={role}
                  entry={slotByRole.get(role) ?? null}
                  onAssign={() => setSlotPicker(role)}
                  onClear={() => setSlotFavorite(role, null)}
                  colors={colors}
                />
              ))}
            </View>
            {generalFavorites.length === 0 ? (
              <View style={styles.empty} testID="favorites-empty">
                <Text style={styles.emptyIcon} allowFontScaling={false}>⭐</Text>
                <Text style={[styles.emptyTitle, { color: colors.ink }]}>{t('favorites.empty')}</Text>
                <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
                  {t('favorites.emptyDescription')}
                </Text>
              </View>
            ) : (
              generalFavorites.map((entry: FavoriteEntry) => {
                const { id } = entry.station;
                return (
                  <FavoriteCard
                    key={id}
                    entry={entry}
                    isExpanded={id === selectedId}
                    arrival={id === selectedId ? arrival : null}
                    onToggle={() => handleToggleSelect(id)}
                    onRemove={() => {
                      if (selectedId === id) setSelectedId(null);
                      removeFavorite(id);
                    }}
                    onSaveLabel={(label) => setFavoriteLabel(id, label)}
                    colors={colors}
                  />
                );
              })
            )}
          </>
        )}
      </ScrollView>
      <SlotPickerModal
        role={slotPicker}
        onClose={() => setSlotPicker(null)}
        onPick={(station) => {
          if (slotPicker) {
            setSlotFavorite(slotPicker, station);
          }
          setSlotPicker(null);
        }}
        colors={colors}
      />
    </SafeAreaView>
  );
}

function SearchResultCard({
  station,
  already,
  onAdd,
  colors,
}: {
  station: Station;
  already: boolean;
  onAdd: () => void;
  colors: ThemeColors;
}) {
  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderLeftColor: station.lineColor }]}>
      <View style={styles.cardInfo}>
        <View style={[styles.badge, { backgroundColor: station.lineColor }]}>
          <Text style={styles.badgeText}>{LINE_NAMES[station.line]}</Text>
        </View>
        <Text style={[styles.stationName, { color: colors.ink }]}>{getStationDisplayName(station)}</Text>
      </View>
      <TouchableOpacity
        style={[styles.addButton, { backgroundColor: colors.accent }, already && { backgroundColor: colors.hair }]}
        onPress={onAdd}
        disabled={already}
        testID={`favorite-add-${station.id}`}
      >
        <Text style={[styles.addButtonText, { color: already ? colors.muted : colors.onAccent }]}>{already ? '✓' : '+'}</Text>
      </TouchableOpacity>
    </View>
  );
}

function FavoriteCard({
  entry,
  isExpanded,
  arrival,
  onToggle,
  onRemove,
  onSaveLabel,
  colors,
}: {
  entry: FavoriteEntry;
  isExpanded: boolean;
  arrival: StationArrival | null;
  onToggle: () => void;
  onRemove: () => void;
  onSaveLabel: (label?: string) => void;
  colors: ThemeColors;
}) {
  const { t } = useTranslation();
  const { station, label } = entry;
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(label ?? '');
  const showRows = arrival != null && arrival.source !== 'closed';
  const emptyArrival =
    showRows && arrival.up.length === 0 && arrival.down.length === 0;
  const stationDisplay = getStationDisplayName(station);
  const handleSave = () => {
    const trimmed = draftLabel.trim();
    onSaveLabel(trimmed === '' ? undefined : trimmed);
    setEditing(false);
  };
  const handleCancel = () => {
    setDraftLabel(label ?? '');
    setEditing(false);
  };
  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderLeftColor: station.lineColor }]}>
      {/* Remove 버튼을 onToggle TouchableOpacity 밖 sibling으로 배치.
          중첩 TouchableOpacity는 iOS에서 부모 a11y 흡수로 자식 testID가 maestro에서 안 잡혔다. */}
      <View style={styles.cardRow}>
        <TouchableOpacity style={styles.cardMain} onPress={onToggle} activeOpacity={0.7}>
          <View style={styles.cardInfo}>
            <View style={[styles.badge, { backgroundColor: station.lineColor }]}>
              <Text style={styles.badgeText}>{LINE_NAMES[station.line]}</Text>
            </View>
            <Text style={[styles.stationName, { color: colors.ink }]}>
              {label ?? stationDisplay}
            </Text>
            {label != null && (
              <Text style={[styles.subStationName, { color: colors.muted }]}>{stationDisplay}</Text>
            )}
          </View>
          <Text style={[styles.expandIcon, { color: colors.muted }]}>{isExpanded ? '▲' : '▼'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.removeButton, { backgroundColor: colors.card }]} onPress={onRemove} testID={`favorite-remove-${station.id}`}>
          <Text style={[styles.removeText, { color: colors.danger }]}>{t('favorites.remove')}</Text>
        </TouchableOpacity>
      </View>

      {isExpanded && (
        <View style={[styles.arrivalSection, { borderTopColor: colors.hair }]}>
          <View style={styles.labelEditor}>
            {editing ? (
              <>
                <TextInput
                  style={[styles.labelInput, { backgroundColor: colors.bg, color: colors.ink, borderColor: colors.hair }]}
                  value={draftLabel}
                  onChangeText={setDraftLabel}
                  placeholder={t('favorites.labelPlaceholder')}
                  placeholderTextColor={colors.muted}
                  autoFocus
                  testID={`favorite-label-input-${station.id}`}
                />
                <TouchableOpacity
                  style={[styles.labelButton, { backgroundColor: colors.accent }]}
                  onPress={handleSave}
                  testID={`favorite-label-save-${station.id}`}
                >
                  <Text style={[styles.labelButtonText, { color: colors.onAccent }]}>{t('favorites.saveLabel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.labelButton, { backgroundColor: colors.card, borderColor: colors.hair, borderWidth: 1 }]}
                  onPress={handleCancel}
                  testID={`favorite-label-cancel-${station.id}`}
                >
                  <Text style={[styles.labelButtonText, { color: colors.ink }]}>{t('common.cancel')}</Text>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity
                style={[styles.labelButton, { backgroundColor: colors.card, borderColor: colors.hair, borderWidth: 1 }]}
                onPress={() => {
                  setDraftLabel(label ?? '');
                  setEditing(true);
                }}
                testID={`favorite-label-edit-${station.id}`}
              >
                <Text style={[styles.labelButtonText, { color: colors.ink }]}>
                  {label != null ? t('favorites.editLabel') : t('favorites.addLabel')}
                </Text>
              </TouchableOpacity>
            )}
          </View>
          {arrival == null && (
            <Text style={[styles.noArrival, { color: colors.muted }]}>{t('home.loading')}</Text>
          )}
          <ArrivalSourceNotice arrival={arrival} />
          {showRows && arrival.up.length > 0 && (
            <ArrivalRow label={t('arrival.upbound')} items={arrival.up} colors={colors} />
          )}
          {showRows && arrival.down.length > 0 && (
            <ArrivalRow label={t('arrival.downbound')} items={arrival.down} colors={colors} />
          )}
          {emptyArrival && (
            <Text style={[styles.noArrival, { color: colors.muted }]}>{t('home.noArrivalInfo')}</Text>
          )}
        </View>
      )}
    </View>
  );
}

function SlotCard({
  role,
  entry,
  onAssign,
  onClear,
  colors,
}: {
  role: FavoriteSlotRole;
  entry: FavoriteEntry | null;
  onAssign: () => void;
  onClear: () => void;
  colors: ThemeColors;
}) {
  const { t } = useTranslation();
  const label = t(`favorites.${role}`);
  if (!entry) {
    return (
      <TouchableOpacity
        style={[styles.slotCard, { backgroundColor: colors.card, borderColor: colors.hair }]}
        onPress={onAssign}
        testID={`slot-assign-${role}`}
      >
        <Text style={styles.slotIcon}>{FAVORITE_SLOT_ICONS[role]}</Text>
        <Text style={[styles.slotLabel, { color: colors.ink }]}>{label}</Text>
        <Text style={[styles.slotHint, { color: colors.muted }]}>{t('favorites.slotAssignHint')}</Text>
      </TouchableOpacity>
    );
  }
  const { station } = entry;
  return (
    <View style={[styles.slotCard, { backgroundColor: colors.card, borderColor: colors.hair, borderLeftColor: station.lineColor, borderLeftWidth: 4 }]}>
      <TouchableOpacity style={styles.slotMain} onPress={onAssign} testID={`slot-change-${role}`}>
        <Text style={styles.slotIcon}>{FAVORITE_SLOT_ICONS[role]}</Text>
        <Text style={[styles.slotLabel, { color: colors.ink }]}>{label}</Text>
        <Text style={[styles.slotStation, { color: colors.muted }]} numberOfLines={1}>
          {getStationDisplayName(station)}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onClear} testID={`slot-clear-${role}`} style={styles.slotClear}>
        <Text style={[styles.slotClearText, { color: colors.danger }]}>×</Text>
      </TouchableOpacity>
    </View>
  );
}

function SlotPickerModal({
  role,
  onClose,
  onPick,
  colors,
}: {
  role: FavoriteSlotRole | null;
  onClose: () => void;
  onPick: (station: Station) => void;
  colors: ThemeColors;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (role == null) setQuery('');
  }, [role]);
  const results = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const lower = trimmed.toLowerCase();
    return allStations.filter((s) => matchesStationQuery(s, trimmed, lower)).slice(0, 20);
  }, [query]);
  const visible = role != null;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.slotModalHeader}>
          <Text style={[styles.slotModalTitle, { color: colors.ink }]}>
            {role ? t('favorites.slotPickerTitle', { label: t(`favorites.${role}`) }) : ''}
          </Text>
          <TouchableOpacity onPress={onClose} testID="slot-picker-close">
            <Text style={[styles.slotModalClose, { color: colors.accent }]}>{t('common.close')}</Text>
          </TouchableOpacity>
        </View>
        <TextInput
          style={[styles.searchInput, { backgroundColor: colors.card, color: colors.ink, borderColor: colors.hair, marginHorizontal: 24 }]}
          placeholder={t('favorites.searchPlaceholder')}
          placeholderTextColor={colors.muted}
          value={query}
          onChangeText={setQuery}
          autoFocus
          testID="slot-picker-search"
        />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 24 }}>
          {results.map((station) => (
            <TouchableOpacity
              key={station.id}
              style={[styles.card, { backgroundColor: colors.card, borderLeftColor: station.lineColor }]}
              onPress={() => onPick(station)}
              testID={`slot-picker-result-${station.id}`}
            >
              <View style={styles.cardRow}>
                <View style={styles.cardInfo}>
                  <View style={[styles.badge, { backgroundColor: station.lineColor }]}>
                    <Text style={styles.badgeText}>{LINE_NAMES[station.line]}</Text>
                  </View>
                  <Text style={[styles.stationName, { color: colors.ink }]}>
                    {getStationDisplayName(station)}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function ArrivalRow({
  label,
  items,
  colors,
}: {
  label: string;
  items: { destination: string; arrivalSeconds: number; statusMessage: string }[];
  colors: ThemeColors;
}) {
  return (
    <View style={styles.arrivalRow}>
      <Text style={[styles.arrivalLabel, { color: colors.subtle }]}>{label}</Text>
      <View>
        {items.map((item, idx) => (
          <View key={idx}>
            <Text style={[styles.arrivalItem, { color: colors.ink }]}>
              {item.destination ? `${item.destination} · ` : ''}
              {formatArrivalTime(item.arrivalSeconds)}
            </Text>
            {item.statusMessage !== '' && (
              <Text style={[styles.statusMessage, { color: colors.accent }]}>{item.statusMessage}</Text>
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    padding: 24,
    flexGrow: 1,
  },
  header: {
    ...typography.bodySm,
    marginBottom: 16,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  searchInput: {
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    ...typography.bodyBase,
    marginBottom: 16,
    borderWidth: 1,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
  },
  emptyIcon: {
    fontSize: 48, // emoji icon — allowFontScaling={false} applied at render
    marginBottom: 16,
  },
  emptyTitle: {
    ...typography.bodyLg,
    fontWeight: '700',
    marginBottom: 8,
  },
  emptySubtitle: {
    ...typography.bodySm,
    textAlign: 'center',
    lineHeight: 22,
  },
  card: {
    borderRadius: 12,
    borderLeftWidth: 5,
    marginBottom: 12,
    overflow: 'hidden',
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  cardMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardInfo: {
    flex: 1,
  },
  expandIcon: {
    ...typography.captionSm,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    marginBottom: 8,
  },
  badgeText: {
    color: '#ffffff', // 노선색(lineColor) 배경은 항상 진한색 — 흰 텍스트 유지
    ...typography.captionSm,
    fontWeight: '700',
  },
  stationName: {
    ...typography.titleXs,
    fontWeight: '700',
  },
  subStationName: {
    ...typography.caption,
    marginTop: 2,
  },
  labelEditor: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  labelInput: {
    flex: 1,
    minWidth: 120,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    ...typography.bodySm,
    borderWidth: 1,
  },
  labelButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  labelButtonText: {
    ...typography.caption,
    fontWeight: '600',
  },
  removeButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  removeText: {
    ...typography.caption,
    fontWeight: '600',
  },
  addButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonText: {
    ...typography.bodyLg,
    fontWeight: '700',
    lineHeight: 20,
  },
  arrivalSection: {
    borderTopWidth: 1,
    padding: 16,
  },
  arrivalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 6,
  },
  arrivalLabel: {
    ...typography.bodySm,
    fontWeight: '600',
  },
  arrivalItem: {
    ...typography.bodySm,
    textAlign: 'right',
  },
  statusMessage: {
    ...typography.micro,
    textAlign: 'right',
    marginTop: 1,
    marginBottom: 2,
  },
  noArrival: {
    ...typography.caption,
    textAlign: 'center',
    paddingVertical: 4,
  },
  slotRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  slotCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  slotMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  slotIcon: {
    ...typography.bodyLg,
  },
  slotLabel: {
    ...typography.bodyBase,
    fontWeight: '700',
  },
  slotHint: {
    ...typography.captionSm,
    flexShrink: 1,
  },
  slotStation: {
    ...typography.caption,
    flexShrink: 1,
  },
  slotClear: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  slotClearText: {
    ...typography.titleSm,
    fontWeight: '700',
    lineHeight: 24,
  },
  slotModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  slotModalTitle: {
    ...typography.bodyLg,
    fontWeight: '700',
  },
  slotModalClose: {
    ...typography.bodyMd,
  },
});
