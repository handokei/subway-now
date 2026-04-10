import React from 'react';
import { StyleSheet, View } from 'react-native';
import { NaverMapMarkerOverlay, NaverMapView } from '@mj-studio/react-native-naver-map';
import { Station } from '../types/station';

interface StationMapProps {
  userLat: number;
  userLng: number;
  nearestStation: Station | null;
  nearbyStations: Station[];
  onStationPress?: (station: Station) => void;
}

export function StationMap({
  userLat,
  userLng,
  nearestStation,
  nearbyStations,
  onStationPress,
}: StationMapProps) {
  return (
    <NaverMapView
      style={styles.map}
      camera={{ latitude: userLat, longitude: userLng, zoom: 15 }}
      locationOverlay={{ isVisible: true, position: { latitude: userLat, longitude: userLng } }}
      isShowLocationButton={false}
      isShowCompass={false}
    >
      {nearbyStations.map((station) => {
        const isNearest = nearestStation?.id === station.id;
        const size = isNearest ? 36 : 24;
        return (
          <NaverMapMarkerOverlay
            key={station.id}
            latitude={station.lat}
            longitude={station.lng}
            width={size}
            height={size}
            anchor={{ x: 0.5, y: 0.5 }}
            caption={{ text: station.name, textSize: 11, color: '#ffffff', haloColor: '#000000' }}
            onTap={() => onStationPress?.(station)}
          >
            <View
              style={[
                styles.markerBase,
                {
                  width: size,
                  height: size,
                  borderRadius: size / 2,
                  backgroundColor: station.lineColor,
                  borderWidth: isNearest ? 3 : 2,
                },
              ]}
            />
          </NaverMapMarkerOverlay>
        );
      })}
    </NaverMapView>
  );
}

const styles = StyleSheet.create({
  map: {
    flex: 1,
  },
  markerBase: {
    borderColor: '#ffffff',
  },
});
