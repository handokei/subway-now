import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNearestStation } from '../../src/hooks/useNearestStation';
import { useMapData } from '../../src/hooks/useMapData';
import { StationMap } from '../../src/components/StationMap';
import { buildNaverMapAppUrl, buildNaverMapWebUrl } from '../../src/utils/naverMapLink';

export default function MapScreen() {
  const { userLocation, result, loading, error, permissionDenied, refresh } =
    useNearestStation();
  const { nearbyStations } = useMapData(
    userLocation?.lat ?? null,
    userLocation?.lng ?? null
  );

  const openInNaverMap = async () => {
    if (!userLocation) return;
    const lat = result?.station.lat ?? userLocation.lat;
    const lng = result?.station.lng ?? userLocation.lng;
    const name = result?.station.name ?? '현재 위치';
    const appUrl = buildNaverMapAppUrl(lat, lng, name);
    const webUrl = buildNaverMapWebUrl(lat, lng, name);
    const canOpen = await Linking.canOpenURL(appUrl);
    await Linking.openURL(canOpen ? appUrl : webUrl);
  };

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
      />
      <TouchableOpacity style={styles.naverButton} onPress={openInNaverMap}>
        <Text style={styles.naverButtonText}>🗺️ 네이버 지도에서 보기</Text>
      </TouchableOpacity>
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
  naverButton: {
    backgroundColor: '#03C75A',
    margin: 16,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  naverButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
