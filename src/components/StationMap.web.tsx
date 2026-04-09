import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Station } from '../types/station';
import { haversine } from '../utils/haversine';
import { LINE_NAMES } from '../constants/lineColors';

interface StationMapProps {
  userLat: number;
  userLng: number;
  nearestStation: Station | null;
  nearbyStations: Station[];
}

export function StationMap({ userLat, userLng, nearestStation, nearbyStations }: StationMapProps) {
  if (nearbyStations.length === 0) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.emptyText}>주변 1km 내 지하철역이 없습니다.</Text>
      </View>
    );
  }

  const sorted = [...nearbyStations]
    .map((s) => ({
      station: s,
      distanceM: Math.round(haversine(userLat, userLng, s.lat, s.lng) * 1000),
    }))
    .sort((a, b) => a.distanceM - b.distanceM);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.header}>주변 지하철역 (1km 이내)</Text>
      {sorted.map(({ station, distanceM }) => (
        <View
          key={station.id}
          style={[styles.row, nearestStation?.id === station.id && styles.nearestRow]}
        >
          <View style={[styles.badge, { backgroundColor: station.lineColor }]}>
            <Text style={styles.badgeText}>{LINE_NAMES[station.line]}</Text>
          </View>
          <Text style={[styles.name, nearestStation?.id === station.id && styles.nearestName]}>
            {station.name}
          </Text>
          <Text style={styles.distance}>{distanceM}m</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  content: {
    padding: 20,
  },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1a1a2e',
    padding: 24,
  },
  emptyText: {
    color: '#8888aa',
    fontSize: 14,
    textAlign: 'center',
  },
  header: {
    fontSize: 12,
    color: '#8888aa',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16213e',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
    gap: 10,
  },
  nearestRow: {
    borderWidth: 1,
    borderColor: '#0052A4',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
  },
  name: {
    flex: 1,
    fontSize: 16,
    color: '#ffffff',
    fontWeight: '600',
  },
  nearestName: {
    color: '#6699ff',
  },
  distance: {
    fontSize: 13,
    color: '#8888aa',
  },
});
