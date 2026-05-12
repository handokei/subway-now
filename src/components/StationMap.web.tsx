import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Station } from '../types/station';
import { haversine } from '../utils/haversine';
import { LINE_NAMES } from '../constants/lineColors';
import { getStationDisplayName } from '../utils/stationDisplay';
import { useTheme } from '../theme';

interface StationMapProps {
  userLat: number;
  userLng: number;
  nearestStation: Station | null;
  nearbyStations: Station[];
}

export function StationMap({ userLat, userLng, nearestStation, nearbyStations }: StationMapProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  if (nearbyStations.length === 0) {
    return (
      <View style={[styles.fallback, { backgroundColor: colors.bg }]}>
        <Text style={[styles.emptyText, { color: colors.muted }]}>{t('map.noNearbyStations')}</Text>
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
    <ScrollView style={[styles.container, { backgroundColor: colors.bg }]} contentContainerStyle={styles.content}>
      <Text style={[styles.header, { color: colors.muted }]}>{t('map.nearbyStationsHeader')}</Text>
      {sorted.map(({ station, distanceM }) => {
        const isNearest = nearestStation?.id === station.id;
        return (
          <View
            key={station.id}
            style={[
              styles.row,
              { backgroundColor: colors.card },
              isNearest && { borderWidth: 1, borderColor: colors.accent },
            ]}
          >
            <View style={[styles.badge, { backgroundColor: station.lineColor }]}>
              <Text style={[styles.badgeText, { color: '#ffffff' }]}>{LINE_NAMES[station.line]}</Text>
            </View>
            <Text style={[styles.name, { color: isNearest ? colors.accent : colors.ink }]}>
              {getStationDisplayName(station)}
            </Text>
            <Text style={[styles.distance, { color: colors.muted }]}>{distanceM}m</Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 20,
  },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
  },
  header: {
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
    gap: 10,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  name: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
  },
  distance: {
    fontSize: 13,
  },
});
