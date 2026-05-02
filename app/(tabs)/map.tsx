import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNearestStation } from '../../src/hooks/useNearestStation';
import { useMapData } from '../../src/hooks/useMapData';
import { StationMap } from '../../src/components/StationMap';
import { buildKakaoMapAppUrl, buildKakaoMapWebUrl } from '../../src/utils/kakaoMapLink';
import { useTheme } from '../../src/theme';

export default function MapScreen() {
  const { userLocation, result, loading, error, permissionDenied, refresh } =
    useNearestStation();
  const { nearbyStations } = useMapData(
    userLocation?.lat ?? null,
    userLocation?.lng ?? null
  );
  const { colors } = useTheme();

  const openInKakaoMap = async () => {
    if (!userLocation) return;
    const lat = result?.station.lat ?? userLocation.lat;
    const lng = result?.station.lng ?? userLocation.lng;
    const name = result?.station.name ?? '현재 위치';
    const appUrl = buildKakaoMapAppUrl(lat, lng);
    const webUrl = buildKakaoMapWebUrl(name, lat, lng);
    const canOpen = await Linking.canOpenURL(appUrl);
    await Linking.openURL(canOpen ? appUrl : webUrl);
  };

  if (permissionDenied) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.center}>
          <Text style={[styles.message, { color: colors.muted }]}>위치 권한이 필요합니다.</Text>
          <TouchableOpacity style={[styles.button, { backgroundColor: colors.accent }]} onPress={refresh}>
            <Text style={[styles.buttonText, { color: colors.onAccent }]}>권한 요청</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (loading || !userLocation) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.center}>
          <Text style={[styles.message, { color: colors.muted }]}>위치 확인 중...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.center}>
          <Text style={[styles.message, { color: colors.muted }]}>{error}</Text>
          <TouchableOpacity style={[styles.button, { backgroundColor: colors.accent }]} onPress={refresh}>
            <Text style={[styles.buttonText, { color: colors.onAccent }]}>다시 시도</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]} edges={['top']}>
      <StationMap
        userLat={userLocation.lat}
        userLng={userLocation.lng}
        nearestStation={result?.station ?? null}
        nearbyStations={nearbyStations}
      />
      <TouchableOpacity style={styles.kakaoButton} onPress={openInKakaoMap}>
        <Text style={styles.kakaoButtonText}>🗺️ 카카오맵에서 보기</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  message: {
    fontSize: 16,
    marginBottom: 16,
    textAlign: 'center',
  },
  button: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    fontSize: 16,
  },
  kakaoButton: {
    backgroundColor: '#FEE500',
    margin: 16,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  kakaoButtonText: {
    color: '#191919',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
