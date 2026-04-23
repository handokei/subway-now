import React, { useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { Station } from '../types/station';
import { buildMapHtml } from '../utils/buildMapHtml';

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
  const apiKey = process.env.EXPO_PUBLIC_KAKAO_MAP_KEY ?? '';
  const html = buildMapHtml({ apiKey, userLat, userLng, nearestStation, nearbyStations });

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.type === 'stationPress') {
          onStationPress?.(data.station);
        }
      } catch {
        // 잘못된 메시지 무시
      }
    },
    [onStationPress],
  );

  return (
    <WebView
      style={styles.map}
      source={{ html }}
      onMessage={handleMessage}
      scrollEnabled={false}
      testID="kakao-map-webview"
    />
  );
}

const styles = StyleSheet.create({
  map: {
    flex: 1,
  },
});
