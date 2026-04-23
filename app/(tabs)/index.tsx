import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, InteractionManager, Pressable, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNearestStation } from '../../src/hooks/useNearestStation';
import { useArrivalInfo } from '../../src/hooks/useArrivalInfo';
import { useArrivalCountdown } from '../../src/hooks/useArrivalCountdown';
import { formatArrivalTime } from '../../src/utils/formatTime';
import { LINE_NAMES } from '../../src/constants/lineColors';
import { useAppStore } from '../../src/store/useAppStore';
import { DestinationPicker } from '../../src/components/DestinationPicker';
import { findRoute, buildJourneyDisplay, calculateETA, calculateStaticETA, getNextStationName, type Route } from '../../src/utils/stationRoute';
import { EditorialTimeline } from '../../src/components/EditorialTimeline';
import { journeyDisplayToStops, nearestResultToNearest } from '../../src/utils/journeyAdapter';
import { initStationNotification, updateStationNotification, clearStationNotification, clearAlarmNotification } from '../../src/utils/stationNotification';
import { useStationAlarm } from '../../src/hooks/useStationAlarm';
import { useBackgroundLocation } from '../../src/hooks/useBackgroundLocation';
import { AlarmOverlay } from '../../src/components/AlarmOverlay';
import { createLogger } from '../../src/utils/logger';
import { colors, typography, spacing, radius } from '../../src/theme';
import { LineBadge } from '../../src/components/LineBadge';

const logger = createLogger('HomeScreen');

export default function HomeScreen() {
  const { result, userLocation, loading, error, permissionDenied, refresh } = useNearestStation();
  const { arrival: rawArrival, isMock: arrivalIsMock, loading: arrivalLoading } = useArrivalInfo(result?.station.name ?? null);
  const arrival = useArrivalCountdown(rawArrival);
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
  const loadAlarmEvent = useAppStore((s) => s.loadAlarmEvent);
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
        arrival.up[0]?.arrivalSeconds != null ? Math.floor(arrival.up[0].arrivalSeconds / 60) : Infinity,
        arrival.down[0]?.arrivalSeconds != null ? Math.floor(arrival.down[0].arrivalSeconds / 60) : Infinity,
      )
    : null;
  const etaMinutes = route && nextTrainMinutes !== null && nextTrainMinutes !== Infinity
    ? calculateETA(nextTrainMinutes, route)
    : null;
  const staticEtaMinutes = route ? calculateStaticETA(route) : null;
  const isRealtimeEta = etaMinutes !== null && !arrivalIsMock && arrival !== null;
  const displayEta = isRealtimeEta ? etaMinutes : staticEtaMinutes;

  const nextStationName = useMemo(
    () => (result && destination && route ? getNextStationName(result.station.id, destination.id, route) : null),
    [result?.station.id, destination?.id, route],
  );

  // nextStationName이 확정됐으면 stops=0으로 즉시 시간 기반 임계 통과 (firedAlarms로 중복 방지)
  useStationAlarm(route, destination?.name ?? null, nextStationName, nextStationName ? 0 : undefined);
  useBackgroundLocation(destination);

  useEffect(() => {
    loadFavorites();
    loadSleepMode();
    loadAlarmEvent();
    initStationNotification();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        loadAlarmEvent();
      }
    });
    return () => subscription.remove();
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
    const key = `${result.station.id}__${destination?.id ?? ''}__${displayEta ?? ''}__${arrivalIsMock}__${alarmEvent?.type ?? ''}`;
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
        alarmEvent,
      );
    };
    update().catch((e) => logger.error('알림 업데이트 실패:', e));
  }, [result?.station.id, destination?.id, displayEta, arrivalIsMock, route, alarmEvent]);

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

  const nearest = result ? nearestResultToNearest(result) : null;

  return (
    <SafeAreaView style={styles.container}>
      {arrivedBanner && (
        <View style={styles.arrivedBanner} testID="arrived-banner">
          <Text style={styles.arrivedBannerText}>도착!</Text>
        </View>
      )}
      <ScrollView contentContainerStyle={{ paddingBottom: 80 }}>
        {result && nearest ? (
          <>
            {/* Top meta */}
            <View style={styles.topMeta}>
              <Text style={[typography.mono, { color: colors.subtle }]}>
                {new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
              </Text>
              <Text style={[typography.label, { color: colors.subtle }]}>LIVE</Text>
            </View>

            {/* Hero: nearest station */}
            <View style={{ paddingHorizontal: spacing.xxl, paddingTop: spacing.xxxl - 4 }}>
              <Text style={[typography.label, { color: colors.muted, marginBottom: 10 }]}>
                {result.distanceKm <= 0.5 ? '현재역' : '가장 가까운 역'}
              </Text>
              <View style={styles.heroRow}>
                <Text style={[typography.hero, { color: colors.ink, flex: 1 }]}>
                  {nearest.name}
                </Text>
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
              <View style={styles.metaRow}>
                <LineBadge line={result.station.line} />
                <Dot />
                <Text style={[typography.bodySm, { color: colors.muted }]}>
                  {nearest.distanceM} m
                </Text>
                <Dot />
                <Text style={[typography.bodySm, { color: colors.muted }]}>
                  {nearest.walkMin} min walk
                </Text>
              </View>
            </View>

            <Hr />

            {/* Route */}
            {destination && (
              <>
                <View style={{ paddingHorizontal: spacing.xxl, paddingVertical: spacing.xxl }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: spacing.xl }}>
                    <View>
                      <Text style={[typography.label, { color: colors.muted, marginBottom: 4 }]}>
                        Route to
                      </Text>
                      <Text style={[typography.title, { color: colors.ink }]}>{destination.name}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      {displayEta != null && (
                        <>
                          <Text style={[typography.countMM, { color: colors.ink }]}>
                            {displayEta}
                            <Text style={{ fontSize: 13, color: colors.muted }}> min</Text>
                          </Text>
                          <Text style={[typography.label, { color: colors.subtle, marginTop: 4 }]}>
                            {isRealtimeEta ? 'EST' : '예상'} · {journey?.totalStops ?? 0} STOPS
                          </Text>
                        </>
                      )}
                    </View>
                  </View>
                  {journey && (
                    <EditorialTimeline stops={journeyDisplayToStops(journey)} />
                  )}
                </View>

                {/* Actions */}
                <View style={styles.actionsRow}>
                  <Pressable onPress={() => setPickerVisible(true)}>
                    <Text style={[typography.bodySm, { color: colors.accent, fontWeight: '600' }]}>
                      목적지 변경 →
                    </Text>
                  </Pressable>
                  <View style={styles.vHair} />
                  <Pressable onPress={() => setDestination(null)} testID="destination-clear-button">
                    <Text style={[typography.bodySm, { color: colors.muted }]}>초기화</Text>
                  </Pressable>
                </View>

                <Hr />

                {/* Sleep mode */}
                <View style={styles.sleepRow} testID="sleep-mode-row">
                  <View>
                    <Text style={[typography.bodySm, { color: colors.ink, fontWeight: '600' }]}>
                      취침 모드
                    </Text>
                    <Text style={[typography.mono, { color: colors.muted, marginTop: 2 }]}>
                      환승·도착 1정거장 전 진동 · 알림
                    </Text>
                  </View>
                  <Switch
                    value={sleepMode}
                    onValueChange={setSleepMode}
                    trackColor={{ false: colors.hair, true: colors.accent }}
                    thumbColor={colors.bg}
                    testID="home-sleep-mode-switch"
                  />
                </View>

                <Hr />
              </>
            )}

            {/* No destination: picker + recent */}
            {!destination && (
              <View style={{ paddingHorizontal: spacing.xxl, paddingVertical: spacing.xxl }}>
                {recentDestination && (
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
                  <Text style={styles.destinationButtonText}>목적지 설정</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Arrivals — 기존 상행/하행 포맷 유지 */}
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
  items: { destination: string; arrivalSeconds: number; statusMessage: string }[];
}) {
  return (
    <View style={styles.arrivalRow}>
      <Text style={styles.arrivalLabel}>{label}</Text>
      <View>
        {items.length === 0 ? (
          <Text style={styles.arrivalItem}>도착 정보 없음</Text>
        ) : (
          items.map((item, idx) => (
            <View key={idx} style={styles.arrivalItemContainer}>
              <Text style={styles.arrivalItem}>
                {item.destination ? `${item.destination} · ` : ''}
                {formatArrivalTime(item.arrivalSeconds)}
              </Text>
              {item.statusMessage !== '' && (
                <Text style={styles.statusMessage}>{item.statusMessage}</Text>
              )}
            </View>
          ))
        )}
      </View>
    </View>
  );
}

const Dot = () => <Text style={{ color: colors.subtle }}>·</Text>;
const Hr  = () => <View style={{ height: 1, backgroundColor: colors.hair, marginHorizontal: spacing.xxl }} />;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
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
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
    minHeight: 400,
  },
  topMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.lg,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  favoriteIcon: {
    fontSize: 26,
    marginLeft: spacing.md,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxl,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.sm,
  },
  vHair: { width: 1, height: 12, backgroundColor: colors.hair },
  sleepRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xl,
  },
  recentDestinationButton: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
  },
  recentDestinationLabel: {
    color: colors.accent,
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
    color: colors.ink,
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
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 10,
    alignItems: 'center',
  },
  destinationButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  arrivalSection: {
    marginHorizontal: spacing.xxl,
    marginTop: spacing.xl,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.xl,
    backgroundColor: '#ffffff',
    borderRadius: radius.lg,
  },
  sectionTitle: {
    fontSize: 14,
    color: colors.muted,
    marginBottom: spacing.lg,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  arrivalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.hair,
  },
  arrivalLabel: {
    fontSize: 15,
    color: colors.muted,
    fontWeight: '600',
  },
  arrivalItemContainer: {
    marginBottom: 4,
  },
  arrivalItem: {
    fontSize: 15,
    color: colors.ink,
    textAlign: 'right',
  },
  statusMessage: {
    fontSize: 12,
    color: colors.accent,
    textAlign: 'right',
    marginTop: 2,
  },
  mockNotice: {
    fontSize: 12,
    color: colors.warn,
    marginBottom: 8,
  },
  icon: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink,
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  loadingText: {
    fontSize: 16,
    color: colors.muted,
  },
  errorText: {
    fontSize: 16,
    color: colors.accent,
    marginBottom: 16,
  },
  button: {
    backgroundColor: colors.accent,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: radius.lg,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
});
