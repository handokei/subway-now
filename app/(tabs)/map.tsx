import React from 'react';
import { StyleSheet, Text, View, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNearestStation } from '../../src/hooks/useNearestStation';
import { useMapData } from '../../src/hooks/useMapData';
import { StationMap } from '../../src/components/StationMap';

const KAKAO_KEY = process.env.EXPO_PUBLIC_KAKAO_MAP_KEY ?? '';

export default function MapScreen() {
  const { userLocation, result, loading, error, permissionDenied, refresh } =
    useNearestStation();
  const { nearbyStations } = useMapData(
    userLocation?.lat ?? null,
    userLocation?.lng ?? null
  );

  if (permissionDenied) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.message}>위치 권한이 필요합니다.</Text>
          <TouchableOpacity style={styles.button} onPress={refresh}>
            <Text style={styles.buttonText}>권한 요청</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (loading || !userLocation) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.message}>위치 확인 중...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.message}>{error}</Text>
          <TouchableOpacity style={styles.button} onPress={refresh}>
            <Text style={styles.buttonText}>다시 시도</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StationMap
        userLat={userLocation.lat}
        userLng={userLocation.lng}
        nearestStation={result?.station ?? null}
        nearbyStations={nearbyStations}
        kakaoKey={KAKAO_KEY}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  message: {
    color: '#8888aa',
    fontSize: 16,
    marginBottom: 16,
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#4a4a8a',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
  },
});
