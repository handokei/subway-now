import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { Station } from '../types/station';
import { buildMapHtml } from '../utils/buildMapHtml';
import { useTheme } from '../theme';

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
  const { colors } = useTheme();
  const [mapError, setMapError] = useState<string | null>(null);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.type === 'stationPress') {
          onStationPress?.(data.station);
        } else if (data.type === 'error') {
          setMapError(data.message);
        }
      } catch {
        // 잘못된 메시지 무시
      }
    },
    [onStationPress],
  );

  if (!apiKey) {
    return (
      <View style={styles.fallback} testID="map-no-api-key">
        <Text style={[styles.fallbackText, { color: colors.muted }]}>
          카카오맵 API 키가 설정되지 않았습니다.
        </Text>
      </View>
    );
  }

  if (mapError) {
    return (
      <View style={styles.fallback} testID="map-error">
        <Text style={[styles.fallbackText, { color: colors.muted }]}>
          지도를 불러올 수 없습니다.
        </Text>
        <Text style={[styles.fallbackText, { color: colors.subtle, marginTop: 8, fontSize: 12 }]}>
          {mapError}
        </Text>
      </View>
    );
  }

  const html = buildMapHtml({ apiKey, userLat, userLng, nearestStation, nearbyStations });

  return (
    <WebView
      style={styles.map}
      source={{ html }}
      onMessage={handleMessage}
      onError={() => setMapError('WebView 로드 실패')}
      scrollEnabled={false}
      testID="kakao-map-webview"
    />
  );
}

const styles = StyleSheet.create({
  map: {
    flex: 1,
  },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  fallbackText: {
    fontSize: 14,
    textAlign: 'center',
  },
});
