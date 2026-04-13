import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNearestStation } from '../../src/hooks/useNearestStation';
import { useArrivalInfo } from '../../src/hooks/useArrivalInfo';
import { LINE_NAMES } from '../../src/constants/lineColors';
import { useAppStore } from '../../src/store/useAppStore';
import { DestinationPicker } from '../../src/components/DestinationPicker';
import { findRoute } from '../../src/utils/stationRoute';
import { initStationNotification, updateStationNotification, clearStationNotification } from '../../src/utils/stationNotification';
import { createLogger } from '../../src/utils/logger';

const logger = createLogger('HomeScreen');

export default function HomeScreen() {
  const { result, userLocation, loading, error, permissionDenied, refresh } = useNearestStation();
  const { arrival } = useArrivalInfo(result?.station.name ?? null);
  const { addFavorite, removeFavorite, isFavorite, loadFavorites, destination, setDestination, recentDestination, setRecentDestination } = useAppStore();
  const [pickerVisible, setPickerVisible] = useState(false);
  const [arrivedBanner, setArrivedBanner] = useState(false);
  const arrivedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevNotifKeyRef = useRef<string | undefined>(undefined);
  const route = result && destination ? findRoute(result.station.id, destination.id) : null;

  useEffect(() => {
    loadFavorites();
    initStationNotification();
  }, []);

  useEffect(() => {
    if (!result) {
      if (prevNotifKeyRef.current !== 'none') {
        prevNotifKeyRef.current = 'none';
        logger.info('역 없음 → 알림 해제');
        clearStationNotification();
      }
      return;
    }
    const key = `${result.station.id}__${destination?.id ?? ''}`;
    if (key === prevNotifKeyRef.current) return;
    prevNotifKeyRef.current = key;
    logger.info('알림 업데이트:', result.station.name, destination ? `→ ${destination.name}` : '');
    updateStationNotification(
      result.station,
      Math.round(result.distanceKm * 1000),
      destination,
      route ?? null,
    ).catch((e) => logger.error('알림 업데이트 실패:', e));
  }, [result?.station.id, destination?.id, route]);

  useEffect(() => {
    if (arrivedBanner) {
      clearStationNotification().catch(console.error);
      prevNotifKeyRef.current = undefined;
    }
  }, [arrivedBanner]);

  useEffect(() => {
    if (result?.station.id && destination?.id && result.station.id === destination.id) {
      setArrivedBanner(true);
      arrivedTimeoutRef.current = setTimeout(() => {
        setDestination(null);
        setArrivedBanner(false);
      }, 2000);
    }
    return () => {
      if (arrivedTimeoutRef.current) clearTimeout(arrivedTimeoutRef.current);
    };
  }, [result?.station.id, destination?.id]);

  if (permissionDenied) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.icon}>📍</Text>
          <Text style={styles.title}>위치 권한 필요</Text>
          <Text style={styles.subtitle}>
            설정에서 위치 권한을 허용해 주세요.{'\n'}현재 탑승 중인 역을 감지하려면{'\n'}위치 권한이 필요합니다.
          </Text>
          <TouchableOpacity style={styles.button} onPress={refresh}>
            <Text style={styles.buttonText}>다시 시도</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.loadingText}>위치 확인 중...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.button} onPress={refresh}>
            <Text style={styles.buttonText}>새로고침</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {arrivedBanner && (
        <View style={styles.arrivedBanner} testID="arrived-banner">
          <Text style={styles.arrivedBannerText}>도착!</Text>
        </View>
      )}
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.header}>지금 여기</Text>

        {result ? (
          <>
            <View style={[styles.stationCard, { borderLeftColor: result.station.lineColor }]}>
              <View style={styles.stationCardHeader}>
                <View style={[styles.lineBadge, { backgroundColor: result.station.lineColor }]}>
                  <Text style={styles.lineBadgeText}>{LINE_NAMES[result.station.line]}</Text>
                </View>
                <TouchableOpacity
                  onPress={() =>
                    isFavorite(result.station.id)
                      ? removeFavorite(result.station.id)
                      : addFavorite(result.station)
                  }
                >
                  <Text style={styles.favoriteIcon}>
                    {isFavorite(result.station.id) ? '⭐' : '☆'}
                  </Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.currentStationLabel}>현재역</Text>
              <Text style={styles.stationName}>{result.station.name}</Text>
              <Text style={styles.distanceText}>
                현재 위치에서 약 {Math.round(result.distanceKm * 1000)}m
              </Text>
            </View>

            <View style={styles.destinationCard}>
              {destination ? (
                <View style={styles.destinationInfo}>
                  <Text style={styles.destinationArrow}>→</Text>
                  <View>
                    <Text style={styles.destinationName}>{destination.name}</Text>
                    {route?.type === 'direct' ? (
                      <View style={styles.routeDirectBox}>
                        <Text style={styles.routeDirectStops}>{route.stops}</Text>
                        <Text style={styles.routeDirectLabel}>정거장 남음</Text>
                      </View>
                    ) : route?.type === 'transfer' ? (
                      <View style={styles.transferBox}>
                        <View style={styles.transferBeforeRow}>
                          <Text style={styles.transferBeforeStops}>{route.stopsToTransfer}</Text>
                          <Text style={styles.transferBeforeLabel}>정거장 후 환승</Text>
                        </View>
                        <View style={styles.transferStationRow}>
                          <Text style={styles.transferIcon}>⇄</Text>
                          <Text style={styles.transferStationName}>{route.transferName}</Text>
                        </View>
                        <Text style={styles.transferAfterText}>환승 후 {route.stopsFromTransfer}정거장</Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              ) : null}
              {!destination && recentDestination && (
                <TouchableOpacity
                  style={styles.recentDestinationButton}
                  onPress={() => setDestination(recentDestination)}
                  testID="recent-destination-button"
                >
                  <Text style={styles.recentDestinationLabel}>이전 목적지</Text>
                  <View style={styles.recentDestinationRow}>
                    <Text style={styles.recentDestinationName}>{recentDestination.name}</Text>
                    <View style={[styles.recentLineBadge, { backgroundColor: recentDestination.lineColor }]}>
                      <Text style={styles.recentLineText}>{recentDestination.line}호선</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.destinationButton}
                onPress={() => setPickerVisible(true)}
                testID="destination-button"
              >
                <Text style={styles.destinationButtonText}>
                  {destination ? '목적지 변경' : '목적지 설정'}
                </Text>
              </TouchableOpacity>
              {destination ? (
                <TouchableOpacity
                  onPress={() => setDestination(null)}
                  testID="destination-clear-button"
                >
                  <Text style={styles.clearText}>초기화</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {arrival && (
              <View style={styles.arrivalSection}>
                <Text style={styles.sectionTitle}>열차 도착 정보</Text>
                <ArrivalRow label="상행" items={arrival.up} />
                <ArrivalRow label="하행" items={arrival.down} />
              </View>
            )}
          </>
        ) : (
          <View style={styles.center}>
            <Text style={styles.icon}>🚶</Text>
            <Text style={styles.title}>지하철역 근처가 아닙니다</Text>
            <Text style={styles.subtitle}>지하철역 500m 이내에 있을 때{'\n'}현재 역이 표시됩니다.</Text>
            <TouchableOpacity style={styles.button} onPress={refresh}>
              <Text style={styles.buttonText}>새로고침</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <DestinationPicker
        visible={pickerVisible}
        onSelect={(station) => {
          setRecentDestination(station);
          setDestination(station);
          setPickerVisible(false);
        }}
        onClose={() => setPickerVisible(false)}
        recentDestination={recentDestination}
        userLat={userLocation?.lat ?? null}
        userLng={userLocation?.lng ?? null}
      />
    </SafeAreaView>
  );
}

function ArrivalRow({
  label,
  items,
}: {
  label: string;
  items: { destination: string; arrivalMinutes: number }[];
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.arrivalRow}>
      <Text style={styles.arrivalLabel}>{label}</Text>
      <View>
        {items.map((item, idx) => (
          <Text key={idx} style={styles.arrivalItem}>
            {item.destination ? `${item.destination} · ` : ''}
            {item.arrivalMinutes === 0 ? '곧 도착' : `${item.arrivalMinutes}분 후`}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  arrivedBanner: {
    backgroundColor: '#22c55e',
    paddingVertical: 12,
    alignItems: 'center',
  },
  arrivedBannerText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
  },
  scroll: {
    padding: 24,
    flexGrow: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  header: {
    fontSize: 14,
    color: '#8888aa',
    marginBottom: 16,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  stationCard: {
    backgroundColor: '#16213e',
    borderRadius: 16,
    padding: 24,
    borderLeftWidth: 6,
    marginBottom: 16,
  },
  stationCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  favoriteIcon: {
    fontSize: 26,
  },
  lineBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  lineBadgeText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  stationName: {
    fontSize: 32,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 8,
  },
  currentStationLabel: {
    fontSize: 12,
    color: '#8888aa',
    fontWeight: '600',
    letterSpacing: 1,
    marginBottom: 4,
  },
  distanceText: {
    fontSize: 14,
    color: '#8888aa',
  },
  destinationCard: {
    backgroundColor: '#16213e',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  destinationInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  destinationArrow: {
    fontSize: 24,
    color: '#a78bfa',
    marginRight: 12,
  },
  destinationName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
  },
  remainingText: {
    fontSize: 13,
    color: '#8888aa',
    marginTop: 2,
  },
  routeDirectBox: {
    marginTop: 8,
    alignItems: 'flex-start',
  },
  routeDirectStops: {
    fontSize: 32,
    fontWeight: '800',
    color: '#ffffff',
    lineHeight: 36,
  },
  routeDirectLabel: {
    fontSize: 13,
    color: '#8888aa',
    marginTop: 2,
  },
  transferBox: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#2a2a4a',
    gap: 6,
  },
  transferBeforeRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
  },
  transferBeforeStops: {
    fontSize: 28,
    fontWeight: '800',
    color: '#ffffff',
  },
  transferBeforeLabel: {
    fontSize: 13,
    color: '#8888aa',
  },
  transferStationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  transferIcon: {
    fontSize: 20,
    color: '#a78bfa',
  },
  transferStationName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#ffffff',
  },
  transferAfterText: {
    fontSize: 13,
    color: '#8888aa',
  },
  recentDestinationButton: {
    backgroundColor: '#0f0f2a',
    borderWidth: 1,
    borderColor: '#a78bfa',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginBottom: 8,
  },
  recentDestinationLabel: {
    color: '#a78bfa',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  recentDestinationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  recentDestinationName: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  recentLineBadge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  recentLineText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: 'bold',
  },
  destinationButton: {
    backgroundColor: '#a78bfa',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  destinationButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  clearText: {
    color: '#8888aa',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
  },
  arrivalSection: {
    backgroundColor: '#16213e',
    borderRadius: 16,
    padding: 20,
  },
  sectionTitle: {
    fontSize: 14,
    color: '#8888aa',
    marginBottom: 16,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  arrivalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#2a2a4a',
  },
  arrivalLabel: {
    fontSize: 15,
    color: '#aaaacc',
    fontWeight: '600',
  },
  arrivalItem: {
    fontSize: 15,
    color: '#ffffff',
    textAlign: 'right',
    marginBottom: 4,
  },
  icon: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    color: '#8888aa',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  loadingText: {
    fontSize: 16,
    color: '#8888aa',
  },
  errorText: {
    fontSize: 16,
    color: '#ff6b6b',
    marginBottom: 16,
  },
  button: {
    backgroundColor: '#0052A4',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
});
