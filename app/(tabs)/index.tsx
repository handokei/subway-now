import { useEffect, useMemo, useRef, useState } from 'react';
import { InteractionManager, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNearestStation } from '../../src/hooks/useNearestStation';
import { useArrivalInfo } from '../../src/hooks/useArrivalInfo';
import { LINE_NAMES } from '../../src/constants/lineColors';
import { useAppStore } from '../../src/store/useAppStore';
import { DestinationPicker } from '../../src/components/DestinationPicker';
import { findRoute, buildJourneyDisplay, calculateETA, calculateStaticETA, type Route } from '../../src/utils/stationRoute';
import { JourneyTimeline } from '../../src/components/JourneyTimeline';
import { initStationNotification, updateStationNotification, clearStationNotification, clearAlarmNotification } from '../../src/utils/stationNotification';
import { useStationAlarm } from '../../src/hooks/useStationAlarm';
import { AlarmOverlay } from '../../src/components/AlarmOverlay';
import { createLogger } from '../../src/utils/logger';

const logger = createLogger('HomeScreen');

export default function HomeScreen() {
  const { result, userLocation, loading, error, permissionDenied, refresh } = useNearestStation();
  const { arrival, isMock: arrivalIsMock, loading: arrivalLoading } = useArrivalInfo(result?.station.name ?? null);
  const addFavorite = useAppStore((s) => s.addFavorite);
  const removeFavorite = useAppStore((s) => s.removeFavorite);
  const favorites = useAppStore((s) => s.favorites);
  const loadFavorites = useAppStore((s) => s.loadFavorites);
  const destination = useAppStore((s) => s.destination);
  const setDestination = useAppStore((s) => s.setDestination);
  const recentDestination = useAppStore((s) => s.recentDestination);
  const setRecentDestination = useAppStore((s) => s.setRecentDestination);
  const sleepMode = useAppStore((s) => s.sleepMode);
  const setSleepMode = useAppStore((s) => s.setSleepMode);
  const loadSleepMode = useAppStore((s) => s.loadSleepMode);
  const alarmEvent = useAppStore((s) => s.alarmEvent);
  const clearAlarmEvent = useAppStore((s) => s.clearAlarmEvent);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [arrivedBanner, setArrivedBanner] = useState(false);
  const arrivedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevNotifKeyRef = useRef<string | undefined>(undefined);
  const prevDestIdRef = useRef<string | null>(null);
  const [route, setRoute] = useState<Route>(null);
  const isFav = result ? favorites.some((f) => f.id === result.station.id) : false;

  useEffect(() => {
    if (!result || !destination) {
      setRoute(null);
      return;
    }
    const interactionStart = performance.now();
    const interaction = InteractionManager.runAfterInteractions(() => {
      const route = findRoute(result.station.id, destination.id);
      const total = performance.now() - interactionStart;
      logger.debug(`경로 계산 전체 (InteractionManager 포함): ${total.toFixed(2)}ms`);
      setRoute(route);
    });
    return () => interaction.cancel();
  }, [result?.station.id, destination?.id]);

  const journey = useMemo(
    () => (route && result && destination ? buildJourneyDisplay(route, result.station, destination) : null),
    [route, result?.station.id, destination?.id],
  );
  const nextTrainMinutes = arrival
    ? Math.min(
        arrival.up[0]?.arrivalMinutes ?? Infinity,
        arrival.down[0]?.arrivalMinutes ?? Infinity,
      )
    : null;
  const etaMinutes = route && nextTrainMinutes !== null && nextTrainMinutes !== Infinity
    ? calculateETA(nextTrainMinutes, route)
    : null;
  const staticEtaMinutes = route ? calculateStaticETA(route) : null;
  const isRealtimeEta = etaMinutes !== null && !arrivalIsMock && arrival !== null;
  const displayEta = isRealtimeEta ? etaMinutes : staticEtaMinutes;

  useStationAlarm(route, destination?.name ?? null);

  useEffect(() => {
    loadFavorites();
    loadSleepMode();
    initStationNotification();
  }, []);

  useEffect(() => {
    const prevDestId = prevDestIdRef.current;
    const currDestId = destination?.id ?? null;
    prevDestIdRef.current = currDestId;

    if (!result) {
      if (prevNotifKeyRef.current !== 'none') {
        prevNotifKeyRef.current = 'none';
        logger.info('역 없음 → 알림 해제');
        clearStationNotification();
      }
      return;
    }
    const key = `${result.station.id}__${destination?.id ?? ''}__${displayEta ?? ''}__${arrivalIsMock}`;
    if (key === prevNotifKeyRef.current) return;
    prevNotifKeyRef.current = key;

    const destinationCleared = prevDestId != null && currDestId == null;
    const destinationChanged = prevDestId != null && currDestId != null && prevDestId !== currDestId;
    const update = async () => {
      if (destinationCleared || destinationChanged) {
        if (destinationCleared) {
          logger.info('목적지 해제 → Live Activity 종료 후 재시작');
        } else {
          logger.info('목적지 변경 → 이전 알림 교체');
        }
        await clearAlarmNotification();
        await clearStationNotification();
      }
      logger.info('알림 업데이트:', result.station.name, destination ? `→ ${destination.name}` : '');
      await updateStationNotification(
        result.station,
        Math.round(result.distanceKm * 1000),
        destination,
        route ?? null,
        displayEta,
        arrivalIsMock,
      );
    };
    update().catch((e) => logger.error('알림 업데이트 실패:', e));
  }, [result?.station.id, destination?.id, displayEta, arrivalIsMock, route]);

  useEffect(() => {
    if (arrivedBanner) {
      clearStationNotification().catch(console.error);
      clearAlarmNotification().catch(console.error);
      clearAlarmEvent();
      prevNotifKeyRef.current = undefined;
    }
  }, [arrivedBanner]);

  useEffect(() => {
    if (arrivedBanner) return;
    if (result?.station.name && destination?.name && result.station.name === destination.name && result.distanceKm <= 0.5) {
      setArrivedBanner(true);
      arrivedTimeoutRef.current = setTimeout(() => {
        setDestination(null);
        setArrivedBanner(false);
      }, 2000);
    }
    return () => {
      if (arrivedTimeoutRef.current) clearTimeout(arrivedTimeoutRef.current);
    };
  }, [result?.station.name, destination?.name, result?.distanceKm]);

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
                    isFav
                      ? removeFavorite(result.station.id)
                      : addFavorite(result.station)
                  }
                >
                  <Text style={styles.favoriteIcon}>
                    {isFav ? '⭐' : '☆'}
                  </Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.currentStationLabel}>
                {result.distanceKm <= 0.5 ? '현재역' : '가장 가까운 역'}
              </Text>
              <Text style={styles.stationName}>{result.station.name}</Text>
              <Text style={styles.distanceText}>
                현재 위치에서 약 {Math.round(result.distanceKm * 1000)}m
              </Text>
            </View>

            <View style={styles.destinationCard}>
              {destination ? (
                <View>
                  <View style={styles.destinationInfo}>
                    <Text style={styles.destinationArrow}>→</Text>
                    <Text style={styles.destinationName}>{destination.name}</Text>
                    {displayEta != null && (
                      <Text style={styles.etaInline}>약 {displayEta}분 소요{!isRealtimeEta ? ' (예상)' : ''}</Text>
                    )}
                  </View>
                  {journey && (
                    <JourneyTimeline journey={journey} />
                  )}
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
                      <Text style={styles.recentLineText}>{LINE_NAMES[recentDestination.line]}</Text>
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
                <>
                  <View style={styles.sleepModeRow} testID="sleep-mode-row">
                    <Text style={styles.sleepModeLabel}>취침 모드</Text>
                    <Switch
                      value={sleepMode}
                      onValueChange={setSleepMode}
                      trackColor={{ false: '#2a2a4a', true: '#a78bfa' }}
                      thumbColor={sleepMode ? '#ffffff' : '#666688'}
                      testID="home-sleep-mode-switch"
                    />
                  </View>
                  <TouchableOpacity
                    onPress={() => setDestination(null)}
                    testID="destination-clear-button"
                  >
                    <Text style={styles.clearText}>초기화</Text>
                  </TouchableOpacity>
                </>
              ) : null}
            </View>

            <View style={styles.arrivalSection}>
              <Text style={styles.sectionTitle}>열차 도착 정보</Text>
              {arrivalLoading && !arrival && (
                <Text style={styles.arrivalItem}>불러오는 중...</Text>
              )}
              {arrivalIsMock && (
                <Text style={styles.mockNotice}>실시간 데이터를 불러올 수 없어 예상 데이터를 표시합니다</Text>
              )}
              {arrival && (
                <>
                  <ArrivalRow label="상행" items={arrival.up} />
                  <ArrivalRow label="하행" items={arrival.down} />
                </>
              )}
            </View>
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

      {alarmEvent && (
        <AlarmOverlay event={alarmEvent} onDismiss={clearAlarmEvent} />
      )}

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
  return (
    <View style={styles.arrivalRow}>
      <Text style={styles.arrivalLabel}>{label}</Text>
      <View>
        {items.length === 0 ? (
          <Text style={styles.arrivalItem}>도착 정보 없음</Text>
        ) : (
          items.map((item, idx) => (
            <Text key={idx} style={styles.arrivalItem}>
              {item.destination ? `${item.destination} · ` : ''}
              {item.arrivalMinutes === 0 ? '곧 도착' : `${item.arrivalMinutes}분 후`}
            </Text>
          ))
        )}
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
    fontSize: 26,
    fontWeight: '800',
    color: '#ffffff',
    flexShrink: 1,
  },
  etaInline: {
    fontSize: 14,
    color: '#a78bfa',
    fontWeight: '600',
    marginLeft: 10,
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
  sleepModeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#2a2a4a',
  },
  sleepModeLabel: {
    fontSize: 14,
    color: '#aaaacc',
    fontWeight: '600',
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
  mockNotice: {
    fontSize: 12,
    color: '#ff9f43',
    marginBottom: 8,
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
