import { useEffect } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppStore } from '../../src/store/useAppStore';
import { LINE_NAMES } from '../../src/constants/lineColors';
import { Station } from '../../src/types/station';

export default function FavoritesScreen() {
  const { favorites, removeFavorite, loadFavorites } = useAppStore();

  useEffect(() => {
    loadFavorites();
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.header}>즐겨찾기</Text>
        {favorites.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>⭐</Text>
            <Text style={styles.emptyTitle}>즐겨찾기가 없습니다</Text>
            <Text style={styles.emptySubtitle}>
              현재 역 화면에서 역을 즐겨찾기에{'\n'}추가할 수 있습니다.
            </Text>
          </View>
        ) : (
          favorites.map((station: Station) => (
            <FavoriteCard key={station.id} station={station} onRemove={() => removeFavorite(station.id)} />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function FavoriteCard({
  station,
  onRemove,
}: {
  station: Station;
  onRemove: () => void;
}) {
  return (
    <View style={[styles.card, { borderLeftColor: station.lineColor }]}>
      <View style={styles.cardInfo}>
        <View style={[styles.badge, { backgroundColor: station.lineColor }]}>
          <Text style={styles.badgeText}>{LINE_NAMES[station.line]}</Text>
        </View>
        <Text style={styles.stationName}>{station.name}</Text>
      </View>
      <TouchableOpacity style={styles.removeButton} onPress={onRemove}>
        <Text style={styles.removeText}>삭제</Text>
      </TouchableOpacity>
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
    marginBottom: 20,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
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
    padding: 16,
    borderLeftWidth: 5,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardInfo: {
    flex: 1,
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
});
