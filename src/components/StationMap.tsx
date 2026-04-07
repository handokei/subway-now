import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Station } from '../types/station';
import { buildMapHtml } from '../utils/buildMapHtml';

interface StationMapProps {
  userLat: number;
  userLng: number;
  nearestStation: Station | null;
  nearbyStations: Station[];
  kakaoKey: string;
}

export function StationMap({
  userLat,
  userLng,
  nearestStation,
  nearbyStations,
  kakaoKey,
}: StationMapProps) {
  if (!kakaoKey) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>카카오맵 API 키가 필요합니다.</Text>
        <Text style={styles.fallbackSub}>EXPO_PUBLIC_KAKAO_MAP_KEY를 .env에 설정하세요.</Text>
      </View>
    );
  }

  const html = buildMapHtml({ userLat, userLng, nearestStation, nearbyStations, kakaoKey });

  return (
    <WebView
      style={styles.map}
      source={{ html }}
      originWhitelist={['*']}
      javaScriptEnabled
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
    backgroundColor: '#1a1a2e',
    padding: 24,
  },
  fallbackText: {
    color: '#ffffff',
    fontSize: 16,
    marginBottom: 8,
  },
  fallbackSub: {
    color: '#8888aa',
    fontSize: 12,
  },
});
