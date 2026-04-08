import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Station } from '../types/station';

interface StationMapProps {
  userLat: number;
  userLng: number;
  nearestStation: Station | null;
  nearbyStations: Station[];
  kakaoKey: string;
}

export function StationMap(_props: StationMapProps) {
  return (
    <View style={styles.fallback}>
      <Text style={styles.text}>지도는 모바일 앱(Expo Go)에서 이용하세요.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1a1a2e',
    padding: 24,
  },
  text: {
    color: '#8888aa',
    fontSize: 14,
    textAlign: 'center',
  },
});
