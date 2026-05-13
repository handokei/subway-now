import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from 'react-native-maps';
import type { Route } from '../utils/stationRoute';
import type { Station } from '../types/station';
import { routeToCoordinates, type RouteStationRole } from '../utils/routeToCoordinates';
import { getStationDisplayName } from '../utils/stationDisplay';
import { useTheme } from '../theme';

interface RouteMapProps {
  route: Route;
  origin: Station;
  destination: Station;
}

const FIT_EDGE_PADDING = { top: 40, bottom: 40, left: 40, right: 40 };
const POLYLINE_WIDTH = 5;
const ROLE_MARKER_SIZE: Record<RouteStationRole, number> = {
  origin: 16,
  transfer: 14,
  destination: 16,
};

export function RouteMap({ route, origin, destination }: RouteMapProps) {
  const { colors } = useTheme();
  const [mapReady, setMapReady] = useState(false);
  const mapRef = useRef<MapView | null>(null);

  const coords = useMemo(
    () => routeToCoordinates(route, origin, destination),
    [route, origin.id, destination.id],
  );

  useEffect(() => {
    if (!mapReady || !coords || coords.path.length === 0) return;
    mapRef.current?.fitToCoordinates(coords.path, {
      edgePadding: FIT_EDGE_PADDING,
      animated: false,
    });
  }, [mapReady, coords]);

  if (!coords) return null;

  const polylineColor = colors.accent;

  return (
    <View style={styles.container} testID="route-map-container">
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={styles.map}
        initialRegion={{
          latitude: origin.lat,
          longitude: origin.lng,
          latitudeDelta: 0.1,
          longitudeDelta: 0.1,
        }}
        onMapReady={() => setMapReady(true)}
        testID="route-map"
      >
        <Polyline
          coordinates={coords.path}
          strokeColor={polylineColor}
          strokeWidth={POLYLINE_WIDTH}
          testID="route-polyline"
        />
        {coords.keyStations.map(({ station, role }) => (
          <Marker
            key={`${role}-${station.id}`}
            coordinate={{ latitude: station.lat, longitude: station.lng }}
            title={getStationDisplayName(station)}
            tracksViewChanges={false}
            anchor={{ x: 0.5, y: 0.5 }}
            testID={`route-marker-${role}-${station.id}`}
          >
            <View
              style={[
                styles.markerDot,
                {
                  width: ROLE_MARKER_SIZE[role],
                  height: ROLE_MARKER_SIZE[role],
                  borderRadius: ROLE_MARKER_SIZE[role] / 2,
                  backgroundColor: role === 'transfer' ? station.lineColor : colors.accent,
                },
              ]}
              testID={`route-marker-dot-${role}-${station.id}`}
            />
            <Text style={[styles.markerLabel, { color: colors.ink }]} numberOfLines={1}>
              {getStationDisplayName(station)}
            </Text>
          </Marker>
        ))}
      </MapView>
      {!mapReady && (
        <View style={styles.loading} testID="route-map-loading">
          <ActivityIndicator color={colors.muted} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: 220,
    overflow: 'hidden',
  },
  map: {
    flex: 1,
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerDot: {
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  markerLabel: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    maxWidth: 80,
  },
});
