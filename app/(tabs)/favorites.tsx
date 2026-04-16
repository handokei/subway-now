import { useEffect, useMemo, useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppStore } from '../../src/store/useAppStore';
import { LINE_NAMES } from '../../src/constants/lineColors';
import { Station } from '../../src/types/station';
import { useArrivalInfo } from '../../src/hooks/useArrivalInfo';
import stationsData from '../../src/data/stations.json';

const allStations = stationsData as Station[];

export default function FavoritesScreen() {
  const favorites = useAppStore((s) => s.favorites);
  const addFavorite = useAppStore((s) => s.addFavorite);
  const removeFavorite = useAppStore((s) => s.removeFavorite);
  const isFavorite = useAppStore((s) => s.isFavorite);
  const loadFavorites = useAppStore((s) => s.loadFavorites);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    loadFavorites();
  }, []);

  const selectedStation = useMemo(
    () => favorites.find((f) => f.id === selectedId) ?? null,
    [favorites, selectedId],
  );
  const { arrival } = useArrivalInfo(selectedStation?.name ?? null);

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
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.header}>즐겨찾기</Text>

        <TextInput
          style={styles.searchInput}
          placeholder="역 이름 검색..."
          placeholderTextColor="#8888aa"
          value={query}
          onChangeText={setQuery}
        />

        {isSearching ? (
          searchResults.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>검색 결과가 없습니다</Text>
            </View>
          ) : (
            searchResults.map((station) => (
              <SearchResultCard
                key={station.id}
                station={station}
                already={isFavorite(station.id)}
                onAdd={() => addFavorite(station)}
              />
            ))
          )
        ) : favorites.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>⭐</Text>
            <Text style={styles.emptyTitle}>즐겨찾기가 없습니다</Text>
            <Text style={styles.emptySubtitle}>
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
}: {
  station: Station;
  already: boolean;
  onAdd: () => void;
}) {
  return (
    <View style={[styles.card, { borderLeftColor: station.lineColor }]}>
      <View style={styles.cardInfo}>
        <View style={[styles.badge, { backgroundColor: station.lineColor }]}>
          <Text style={styles.badgeText}>{LINE_NAMES[station.line]}</Text>
        </View>
        <Text style={styles.stationName}>{station.name}</Text>
      </View>
      <TouchableOpacity
        style={[styles.addButton, already && styles.addButtonDisabled]}
        onPress={onAdd}
        disabled={already}
      >
        <Text style={styles.addButtonText}>{already ? '✓' : '+'}</Text>
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
}: {
  station: Station;
  isExpanded: boolean;
  arrival: { up: { destination: string; arrivalMinutes: number }[]; down: { destination: string; arrivalMinutes: number }[] } | null;
  onToggle: () => void;
  onRemove: () => void;
}) {
  return (
    <View style={[styles.card, { borderLeftColor: station.lineColor }]}>
      <TouchableOpacity style={styles.cardMain} onPress={onToggle} activeOpacity={0.7}>
        <View style={styles.cardInfo}>
          <View style={[styles.badge, { backgroundColor: station.lineColor }]}>
            <Text style={styles.badgeText}>{LINE_NAMES[station.line]}</Text>
          </View>
          <Text style={styles.stationName}>{station.name}</Text>
        </View>
        <View style={styles.cardActions}>
          <Text style={styles.expandIcon}>{isExpanded ? '▲' : '▼'}</Text>
          <TouchableOpacity style={styles.removeButton} onPress={onRemove}>
            <Text style={styles.removeText}>삭제</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>

      {isExpanded && (
        <View style={styles.arrivalSection}>
          {arrival ? (
            <>
              {arrival.up.length > 0 && (
                <ArrivalRow label="상행" items={arrival.up} />
              )}
              {arrival.down.length > 0 && (
                <ArrivalRow label="하행" items={arrival.down} />
              )}
              {arrival.up.length === 0 && arrival.down.length === 0 && (
                <Text style={styles.noArrival}>도착 정보 없음</Text>
              )}
            </>
          ) : (
            <Text style={styles.noArrival}>불러오는 중...</Text>
          )}
        </View>
      )}
    </View>
  );
}

function ArrivalRow({
  label,
  items,
}: {
  label: string;
  items: { destination: string; arrivalMinutes: number }[];
}) {
  return (
    <View style={styles.arrivalRow}>
      <Text style={styles.arrivalLabel}>{label}</Text>
      <View>
        {items.map((item, idx) => (
          <Text key={idx} style={styles.arrivalItem}>
            {item.destination ? `${item.destination} · ` : ''}
            {item.arrivalMinutes === 0 ? '곧 도착' : `${item.arrivalMinutes}분 후`}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  scroll: {
    padding: 24,
    flexGrow: 1,
  },
  header: {
    fontSize: 14,
    color: '#8888aa',
    marginBottom: 16,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  searchInput: {
    backgroundColor: '#16213e',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: '#ffffff',
    fontSize: 15,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#2a2a4a',
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
    color: '#ffffff',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#8888aa',
    textAlign: 'center',
    lineHeight: 22,
  },
  card: {
    backgroundColor: '#16213e',
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
    color: '#8888aa',
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
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  stationName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
  },
  removeButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#2a2a4a',
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
    backgroundColor: '#0052A4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonDisabled: {
    backgroundColor: '#2a2a4a',
  },
  addButtonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 20,
  },
  arrivalSection: {
    borderTopWidth: 1,
    borderTopColor: '#2a2a4a',
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
    color: '#aaaacc',
    fontWeight: '600',
  },
  arrivalItem: {
    fontSize: 14,
    color: '#ffffff',
    textAlign: 'right',
    marginBottom: 2,
  },
  noArrival: {
    fontSize: 13,
    color: '#8888aa',
    textAlign: 'center',
    paddingVertical: 4,
  },
});
