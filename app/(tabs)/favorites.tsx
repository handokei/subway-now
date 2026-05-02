import { useEffect, useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../../src/store/useAppStore';
import { LINE_NAMES } from '../../src/constants/lineColors';
import { Station } from '../../src/types/station';
import { useArrivalInfo } from '../../src/hooks/useArrivalInfo';
import { useArrivalCountdown } from '../../src/hooks/useArrivalCountdown';
import { formatArrivalTime } from '../../src/utils/formatTime';
import { useTheme, type ThemeColors } from '../../src/theme';
import stationsData from '../../src/data/stations.json';

const allStations = stationsData as Station[];

export default function FavoritesScreen() {
  const favorites = useAppStore((s) => s.favorites);
  const addFavorite = useAppStore((s) => s.addFavorite);
  const removeFavorite = useAppStore((s) => s.removeFavorite);
  const loadFavorites = useAppStore((s) => s.loadFavorites);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { colors } = useTheme();

  useEffect(() => {
    loadFavorites();
  }, []);

  const selectedStation = useMemo(
    () => favorites.find((f) => f.id === selectedId) ?? null,
    [favorites, selectedId],
  );
  const { arrival: rawArrival } = useArrivalInfo(selectedStation?.name ?? null);
  const arrival = useArrivalCountdown(rawArrival);

  const searchResults = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    return allStations.filter((s) => s.name.includes(trimmed)).slice(0, 20);
  }, [query]);

  const isSearching = query.trim().length > 0;

  const handleToggleSelect = (id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={[styles.header, { color: colors.muted }]}>즐겨찾기</Text>

        <TextInput
          style={[styles.searchInput, { backgroundColor: colors.card, color: colors.ink, borderColor: colors.hair }]}
          placeholder="역 이름 검색..."
          placeholderTextColor={colors.muted}
          value={query}
          onChangeText={setQuery}
          testID="favorites-search-input"
        />

        {isSearching ? (
          searchResults.length === 0 ? (
            <View style={styles.empty}>
              <Text style={[styles.emptyTitle, { color: colors.ink }]}>검색 결과가 없습니다</Text>
            </View>
          ) : (
            searchResults.map((station) => (
              <SearchResultCard
                key={station.id}
                station={station}
                already={favorites.some((f) => f.id === station.id)}
                onAdd={() => addFavorite(station)}
                colors={colors}
              />
            ))
          )
        ) : favorites.length === 0 ? (
          <View style={styles.empty} testID="favorites-empty">
            <Text style={styles.emptyIcon}>⭐</Text>
            <Text style={[styles.emptyTitle, { color: colors.ink }]}>즐겨찾기가 없습니다</Text>
            <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
              위 검색창에서 역을 검색해 즐겨찾기에{'\n'}추가할 수 있습니다.
            </Text>
          </View>
        ) : (
          favorites.map((station: Station) => (
            <FavoriteCard
              key={station.id}
              station={station}
              isExpanded={station.id === selectedId}
              arrival={station.id === selectedId ? arrival : null}
              onToggle={() => handleToggleSelect(station.id)}
              onRemove={() => {
                if (selectedId === station.id) setSelectedId(null);
                removeFavorite(station.id);
              }}
              colors={colors}
            />
          ))
        )}
      </ScrollView>
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
        <Text style={[styles.stationName, { color: colors.ink }]}>{station.name}</Text>
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
  station,
  isExpanded,
  arrival,
  onToggle,
  onRemove,
  colors,
}: {
  station: Station;
  isExpanded: boolean;
  arrival: { up: { destination: string; arrivalSeconds: number; statusMessage: string }[]; down: { destination: string; arrivalSeconds: number; statusMessage: string }[] } | null;
  onToggle: () => void;
  onRemove: () => void;
  colors: ThemeColors;
}) {
  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderLeftColor: station.lineColor }]}>
      <TouchableOpacity style={styles.cardMain} onPress={onToggle} activeOpacity={0.7}>
        <View style={styles.cardInfo}>
          <View style={[styles.badge, { backgroundColor: station.lineColor }]}>
            <Text style={styles.badgeText}>{LINE_NAMES[station.line]}</Text>
          </View>
          <Text style={[styles.stationName, { color: colors.ink }]}>{station.name}</Text>
        </View>
        <View style={styles.cardActions}>
          <Text style={[styles.expandIcon, { color: colors.muted }]}>{isExpanded ? '▲' : '▼'}</Text>
          <TouchableOpacity style={[styles.removeButton, { backgroundColor: colors.card }]} onPress={onRemove} testID={`favorite-remove-${station.id}`}>
            <Text style={styles.removeText}>삭제</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>

      {isExpanded && (
        <View style={[styles.arrivalSection, { borderTopColor: colors.hair }]}>
          {arrival ? (
            <>
              {arrival.up.length > 0 && (
                <ArrivalRow label="상행" items={arrival.up} colors={colors} />
              )}
              {arrival.down.length > 0 && (
                <ArrivalRow label="하행" items={arrival.down} colors={colors} />
              )}
              {arrival.up.length === 0 && arrival.down.length === 0 && (
                <Text style={[styles.noArrival, { color: colors.muted }]}>도착 정보 없음</Text>
              )}
            </>
          ) : (
            <Text style={[styles.noArrival, { color: colors.muted }]}>불러오는 중...</Text>
          )}
        </View>
      )}
    </View>
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
    fontSize: 14,
    marginBottom: 16,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  searchInput: {
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
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
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
  },
  card: {
    borderRadius: 12,
    borderLeftWidth: 5,
    marginBottom: 12,
    overflow: 'hidden',
  },
  cardMain: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
  },
  cardInfo: {
    flex: 1,
  },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  expandIcon: {
    fontSize: 12,
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
    fontSize: 12,
    fontWeight: '700',
  },
  stationName: {
    fontSize: 20,
    fontWeight: '700',
  },
  removeButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  removeText: {
    color: '#ff6b6b',
    fontSize: 13,
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
    fontSize: 18,
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
    fontSize: 14,
    fontWeight: '600',
  },
  arrivalItem: {
    fontSize: 14,
    textAlign: 'right',
  },
  statusMessage: {
    fontSize: 11,
    textAlign: 'right',
    marginTop: 1,
    marginBottom: 2,
  },
  noArrival: {
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 4,
  },
});
