import React, { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import type { Station } from '../types/station';
import { buildMapConfig } from '../utils/buildMapConfig';
import { useTheme } from '../theme';
import { LINE_NAMES } from '../constants/lineColors';

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
  const [mapReady, setMapReady] = useState(false);

  const mapConfig = useMemo(
    () => buildMapConfig({ userLat, userLng, nearestStation, nearbyStations }),
    [userLat, userLng, nearestStation?.id, nearbyStations],
  );

  return (
    <View style={styles.map}>
      <MapView
        provider={PROVIDER_DEFAULT}
        style={styles.map}
        initialRegion={{
          latitude: userLat,
          longitude: userLng,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }}
        onMapReady={() => setMapReady(true)}
        showsUserLocation
        testID="station-map"
      >
        {mapConfig.stations.map((station) => (
          <Marker
            key={station.id}
            coordinate={{ latitude: station.lat, longitude: station.lng }}
            title={station.name}
            description={LINE_NAMES[station.line]}
            pinColor={station.id === customOriginId ? colors.accent : station.isNearest ? colors.accent : station.lineColor}
            onPress={() => onStationPress?.(station)}
            testID={`marker-${station.id}`}
          />
        ))}
      </MapView>
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
});
