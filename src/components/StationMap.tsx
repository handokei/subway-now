import React, { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import ClusteredMapView from 'react-native-map-clustering';
import { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import type { Station } from '../types/station';
import { buildMapConfig } from '../utils/buildMapConfig';
import { useTheme } from '../theme';
import { LINE_NAMES } from '../constants/lineColors';
import { getStationDisplayName } from '../utils/stationDisplay';

interface StationMapProps {
  userLat: number;
  userLng: number;
  nearestStation: Station | null;
  nearbyStations: Station[];
  customOriginId?: string;
  onStationPress?: (station: Station) => void;
}

export function StationMap({
  userLat,
  userLng,
  nearestStation,
  nearbyStations,
  customOriginId,
  onStationPress,
}: StationMapProps) {
  const { colors } = useTheme();
  const { i18n } = useTranslation();
  const [mapReady, setMapReady] = useState(false);

  const mapConfig = useMemo(
    () => buildMapConfig({ userLat, userLng, nearestStation, nearbyStations }),
    [userLat, userLng, nearestStation?.id, nearbyStations],
  );

  return (
    <View style={styles.map}>
      <ClusteredMapView
        provider={PROVIDER_DEFAULT}
        style={styles.map}
        initialRegion={{
          latitude: userLat,
          longitude: userLng,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }}
        onMapReady={() => setMapReady(true)}
        showsUserLocation
        clusterColor={colors.accent}
        testID="station-map"
      >
        {mapConfig.stations.map((station) => {
          const isHighlighted = station.id === customOriginId || station.isNearest;
          const dotColor = isHighlighted ? colors.accent : station.lineColor;
          return (
            <Marker
              key={`${station.id}-${i18n.language}`}
              coordinate={{ latitude: station.lat, longitude: station.lng }}
              title={getStationDisplayName(station)}
              description={LINE_NAMES[station.line]}
              onPress={() => onStationPress?.(station)}
              tracksViewChanges={false}
              testID={`marker-${station.id}`}
            >
              <View style={styles.markerContainer}>
                <View
                  style={[
                    styles.markerDot,
                    { backgroundColor: dotColor, borderColor: colors.card },
                  ]}
                  testID={`dot-${station.id}`}
                />
                <Text
                  style={[styles.markerLabel, { color: colors.ink }]}
                  numberOfLines={1}
                >
                  {getStationDisplayName(station)}
                </Text>
              </View>
            </Marker>
          );
        })}
      </ClusteredMapView>
      {!mapReady && (
        <View style={styles.loading} testID="map-loading">
          <ActivityIndicator color={colors.muted} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    flex: 1,
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerContainer: {
    alignItems: 'center',
    maxWidth: 60,
  },
  markerDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1,
  },
  markerLabel: {
    fontSize: 9,
    fontWeight: '600',
    marginTop: 2,
    textAlign: 'center',
  },
});
