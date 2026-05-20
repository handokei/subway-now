import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, InteractionManager, Pressable, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { useTranslation } from 'react-i18next';
import { useFusedNearestStation } from '../../src/hooks/useFusedNearestStation';
import { useArrivalInfo } from '../../src/hooks/useArrivalInfo';
import { useArrivalCountdown } from '../../src/hooks/useArrivalCountdown';
import { formatArrivalTime } from '../../src/utils/formatTime';
import { LINE_NAMES } from '../../src/constants/lineColors';
import { useAppStore } from '../../src/store/useAppStore';
import { DestinationPicker } from '../../src/components/DestinationPicker';
import { findRouteCandidatesByCategory, buildJourneyDisplay, calculateETA, calculateStaticETA, getNextStationName, type Route, type CategorizedRoute, type RoutePreference } from '../../src/utils/stationRoute';
import type { Station } from '../../src/types/station';
import { EditorialTimeline } from '../../src/components/EditorialTimeline';
import { journeyDisplayToStops, nearestResultToNearest } from '../../src/utils/journeyAdapter';
import { useRouter } from 'expo-router';
import { getStationDisplayName } from '../../src/utils/stationDisplay';
import { initStationNotification, updateStationNotification, clearStationNotification, clearAlarmNotification } from '../../src/utils/stationNotification';
import { useStationAlarm } from '../../src/hooks/useStationAlarm';
import { useScheduledAlarms } from '../../src/hooks/useScheduledAlarms';
import { useTripOrigin } from '../../src/hooks/useTripOrigin';
import { useBackgroundLocation } from '../../src/hooks/useBackgroundLocation';
import { useApnsTripRegistration } from '../../src/hooks/useApnsTripRegistration';
import { registerSilentPushTask } from '../../src/tasks/silentPushTask';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ROUTE_KEY } from '../../src/constants/storageKeys';
import { AlarmOverlay } from '../../src/components/AlarmOverlay';
import { createLogger } from '../../src/utils/logger';
import { useTheme, typography, spacing, radius } from '../../src/theme';
import { LineBadge } from '../../src/components/LineBadge';
import { useSleepModeGuide } from '../../src/hooks/useSleepModeGuide';

const logger = createLogger('HomeScreen');

export default function HomeScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const customOrigin = useAppStore((s) => s.customOrigin);
  const loadCustomOrigin = useAppStore((s) => s.loadCustomOrigin);
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
  const loadAllowSpeaker = useAppStore((s) => s.loadAllowSpeaker);
  const showSleepModeGuide = useSleepModeGuide();
  const alarmEvent = useAppStore((s) => s.alarmEvent);
  const clearAlarmEvent = useAppStore((s) => s.clearAlarmEvent);
  const loadAlarmEvent = useAppStore((s) => s.loadAlarmEvent);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [arrivedBanner, setArrivedBanner] = useState(false);
  const arrivedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevNotifKeyRef = useRef<string | undefined>(undefined);
  const prevDestIdRef = useRef<string | null>(null);
  const routePreference = useAppStore((s) => s.routePreference);
  const loadRoutePreference = useAppStore((s) => s.loadRoutePreference);
  const [categorized, setCategorized] = useState<CategorizedRoute[]>([]);
  const [selectedKey, setSelectedKey] = useState<RoutePreference>(routePreference);
  const route: Route =
    categorized.find((r) => r.category.key === selectedKey)?.candidate.route ?? null;

  // 트립 origin은 destination 설정 시점에 캡처되어 trip 동안 고정 (useTripOrigin 참조).
  // useFusedNearestStation 첫 호출 시점엔 routeContext=undefined로 GPS fusion fallback,
  // 다음 렌더에서 useTripOrigin이 effectiveOrigin을 캡처해 setTripOrigin을 호출하면
  // routeContext가 채워지고 useRouteProgress(1D map matching)가 활성화된다.
  const [tripOrigin, setTripOrigin] = useState<Station | null>(null);
  const routeContext = useMemo(
    () => (route && tripOrigin && destination ? { route, origin: tripOrigin, destination } : undefined),
    [route, tripOrigin, destination],
  );
  const { result, variants, userLocation, speedMps, accuracyMeters, loading, error, permissionDenied, locationUncertain, refresh, confidence } = useFusedNearestStation(undefined, undefined, routeContext);
  // AppState listener는 단일-바인딩 패턴이라 deps에 refresh를 추가할 수 없다.
  // 최신 refresh 함수를 ref에 보관해 listener에서 호출한다.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const isCustomOrigin = customOrigin !== null;
  const effectiveOrigin = customOrigin ?? result?.station ?? null;
  useTripOrigin(destination, effectiveOrigin, setTripOrigin);
  const { arrival: rawArrival, isMock: arrivalIsMock, loading: arrivalLoading } = useArrivalInfo(
    route ? (effectiveOrigin?.name ?? null) : null,
  );
  const arrival = useArrivalCountdown(rawArrival);
  const isFav = effectiveOrigin ? favorites.some((f) => f.id === effectiveOrigin.id) : false;

  // 환승역이면 모든 호선 변형에서 경로 계산 → 출발역 환승 없는 최적 경로 자동 선택
  const originVariants = !isCustomOrigin && variants.length > 1 ? variants : effectiveOrigin ? [effectiveOrigin] : [];
  const variantIds = originVariants.map((v) => v.id).join(',');

  useEffect(() => {
    if (!effectiveOrigin || !destination) {
      setCategorized([]);
      AsyncStorage.removeItem(ROUTE_KEY).catch(() => {});
      return;
    }
    const interactionStart = performance.now();
    const interaction = InteractionManager.runAfterInteractions(() => {
      const result = findRouteCandidatesByCategory(
        originVariants.map((o) => o.id),
        destination.id,
      );
      const total = performance.now() - interactionStart;
      logger.debug(`경로 계산 전체 (InteractionManager 포함): ${total.toFixed(2)}ms`);
      setCategorized(result);
      const preferred = result.find((r) => r.category.key === routePreference) ?? result[0];
      if (preferred) {
        setSelectedKey(preferred.category.key);
        AsyncStorage.setItem(ROUTE_KEY, JSON.stringify(preferred.candidate.route)).catch(() => {});
      } else {
        AsyncStorage.removeItem(ROUTE_KEY).catch(() => {});
      }
    });
    return () => interaction.cancel();
  }, [effectiveOrigin?.id, destination?.id, routePreference, variantIds]);

  const journey = useMemo(
    () => (route && effectiveOrigin && destination ? buildJourneyDisplay(route, effectiveOrigin, destination) : null),
    [route, effectiveOrigin?.id, destination?.id],
  );
  const nextTrainMinutes = useMemo(() => {
    if (!arrival) return null;
    const directions = [arrival.up, arrival.down];
    const minutes = directions.map((trains) => {
      const first = trains[0];
      return first?.arrivalSeconds != null ? Math.floor(first.arrivalSeconds / 60) : Infinity;
    });
    return Math.min(...minutes);
  }, [arrival]);
  const etaMinutes = route && nextTrainMinutes !== null && nextTrainMinutes !== Infinity
    ? calculateETA(nextTrainMinutes, route)
    : null;
  const staticEtaMinutes = route ? calculateStaticETA(route) : null;
  const isRealtimeEta = etaMinutes !== null && !arrivalIsMock && arrival !== null;
  const displayEta = isRealtimeEta ? etaMinutes : staticEtaMinutes;

  const nextStationName = useMemo(
    () => (effectiveOrigin && destination && route ? getNextStationName(effectiveOrigin.id, destination.id, route) : null),
    [effectiveOrigin?.id, destination?.id, route],
  );

  useStationAlarm({
    route,
    destination,
    nearestStation: result?.station ?? null,
    userLocation,
    speedMps,
    accuracyMeters,
    arrivalConfidence: confidence,
  });
  useScheduledAlarms({
    route,
    destination,
    currentStation: result?.station ?? null,
    arrival: rawArrival,
  });
  useBackgroundLocation(destination);
  useApnsTripRegistration({
    route,
    destination,
    nextStationEtaSeconds:
      nextTrainMinutes != null && nextTrainMinutes !== Infinity ? nextTrainMinutes * 60 : null,
    currentStation: result?.station ?? null,
  });

  useEffect(() => {
    if (!loading) {
      SplashScreen.hideAsync();
    }
  }, [loading]);

  useEffect(() => {
    loadFavorites();
    loadSleepMode();
    loadAllowSpeaker();
    loadCustomOrigin();
    loadRoutePreference();
    loadAlarmEvent();
    initStationNotification().catch((e) => logger.error('알림 초기화 실패:', e));
    registerSilentPushTask().catch((e) => logger.error('silent push task 등록 실패:', e));
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        loadAlarmEvent();
        // BG에서 watchPositionAsync가 멈춘 동안 캐시된 stale 위치가 화면에 남는 것을
        // 방지하기 위해 FG 복귀 즉시 fresh GPS fix를 요청한다. WhileInUse 권한 환경에서
        // 특히 중요 — BG GPS가 없으므로 FG 복귀가 위치 갱신의 유일한 트리거다.
        void refreshRef.current();
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const prevDestId = prevDestIdRef.current;
    const currDestId = destination?.id ?? null;
    prevDestIdRef.current = currDestId;

    // 실시간 현황(Live Activity/알림)은 경로 진행 중일 때만 노출한다.
    if (!effectiveOrigin || !destination) {
      if (prevNotifKeyRef.current !== 'none') {
        prevNotifKeyRef.current = 'none';
        logger.info('경로 없음 → 알림 해제');
        clearAlarmNotification().catch((e) => logger.error('알림 해제 실패:', e));
        clearStationNotification().catch((e) => logger.error('알림 해제 실패:', e));
      }
      return;
    }
    const key = `${effectiveOrigin.id}__${destination.id}__${displayEta ?? ''}__${arrivalIsMock}__${alarmEvent?.type ?? ''}`;
    if (key === prevNotifKeyRef.current) return;
    prevNotifKeyRef.current = key;

    const destinationChanged = prevDestId != null && prevDestId !== currDestId;
    const update = async () => {
      if (destinationChanged) {
        logger.info('목적지 변경 → 알람 알림 해제');
        await clearAlarmNotification();
        // Live Activity는 end→start race로 "Target is not foreground" 실패를 유발하므로
        // 종료하지 않고 updateStationNotification 내부의 update() 경로로만 갱신한다.
      }
      logger.info('알림 업데이트:', effectiveOrigin.name, `→ ${destination.name}`);
      await updateStationNotification(
        effectiveOrigin,
        isCustomOrigin ? 0 : Math.round((result?.distanceKm ?? 0) * 1000),
        destination,
        route ?? null,
        displayEta,
        arrivalIsMock,
        alarmEvent,
      );
    };
    update().catch((e) => logger.error('알림 업데이트 실패:', e));
  }, [effectiveOrigin?.id, destination?.id, displayEta, arrivalIsMock, route, alarmEvent]);

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
    if (result && destination && result.station.name === destination.name && result.distanceKm <= 0.5) {
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
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.center}>
          <Text style={styles.icon}>📍</Text>
          <Text style={[styles.title, { color: colors.ink }]}>{t('permissions.locationRequiredTitle')}</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            {t('permissions.locationRequiredDescription')}
          </Text>
          <TouchableOpacity style={[styles.button, { backgroundColor: colors.accent }]} onPress={refresh}>
            <Text style={[styles.buttonText, { color: colors.onAccent }]}>{t('common.retry')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.center}>
          <Text style={[styles.loadingText, { color: colors.muted }]}>{t('permissions.locating')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.center}>
          <Text style={[styles.errorText, { color: colors.accent }]}>{error}</Text>
          <TouchableOpacity style={[styles.button, { backgroundColor: colors.accent }]} onPress={refresh}>
            <Text style={[styles.buttonText, { color: colors.onAccent }]}>{t('home.refresh')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const nearest = result ? nearestResultToNearest(result) : null;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      {arrivedBanner && (
        <View style={[styles.arrivedBanner, { backgroundColor: colors.success }]} testID="arrived-banner">
          <Text style={styles.arrivedBannerText}>{t('home.arrived')}</Text>
        </View>
      )}
      <ScrollView contentContainerStyle={{ paddingBottom: 80 }}>
        {effectiveOrigin ? (
          <>
            {/* Hero: origin station */}
            <View style={{ paddingHorizontal: spacing.xxl, paddingTop: spacing.xxxl - 4 }}>
              <Text style={[typography.label, { color: colors.muted, marginBottom: 10 }]}>
                {isCustomOrigin
                  ? t('home.originManual')
                  : result && result.distanceKm <= 0.5
                  ? t('home.originCurrent')
                  : t('home.originNearest')}
              </Text>
              <View style={styles.heroRow}>
                <Text style={[typography.hero, { color: colors.ink, flex: 1, fontWeight: '900' }]}>
                  {getStationDisplayName(effectiveOrigin)}
                </Text>
                <TouchableOpacity
                  onPress={() =>
                    isFav
                      ? removeFavorite(effectiveOrigin.id)
                      : addFavorite(effectiveOrigin)
                  }
                >
                  <Text style={styles.favoriteIcon}>
                    {isFav ? '⭐' : '☆'}
                  </Text>
                </TouchableOpacity>
              </View>
              <View style={styles.metaRow}>
                <LineBadge line={effectiveOrigin.line} />
                {!isCustomOrigin && nearest && (
                  <>
                    <Dot />
                    <Text style={[typography.bodySm, { color: colors.muted }]}>
                      {nearest.distanceM} m
                    </Text>
                    <Dot />
                    <Text style={[typography.bodySm, { color: colors.muted }]}>
                      {nearest.walkMin} min walk
                    </Text>
                  </>
                )}
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
                        {t('home.routeTo')}
                      </Text>
                      <Text style={{ fontSize: 32, fontWeight: '900', letterSpacing: -0.8, color: colors.ink }}>{getStationDisplayName(destination)}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      {displayEta != null && (
                        <>
                          <Text style={[typography.countMM, { color: colors.ink }]}>
                            {displayEta}
                            <Text style={{ fontSize: 13, color: colors.muted }}> min</Text>
                          </Text>
                          <Text style={[typography.label, { color: colors.subtle, marginTop: 4 }]}>
                            {isRealtimeEta ? 'EST' : t('home.estimatedSuffix')} · {journey?.totalStops ?? 0} STOPS
                          </Text>
                        </>
                      )}
                    </View>
                  </View>
                  {categorized.length > 0 && (
                    <View style={[styles.routePillGroup, { backgroundColor: colors.hair }]} testID="route-segment-control">
                      {categorized.map(({ category, candidate }) => {
                        const active = category.key === selectedKey;
                        return (
                          <Pressable
                            key={category.key}
                            testID={`route-tab-${category.key}`}
                            style={[styles.routePill, active && { backgroundColor: colors.accent }]}
                            onPress={() => {
                              setSelectedKey(category.key);
                              AsyncStorage.setItem(ROUTE_KEY, JSON.stringify(candidate.route)).catch(() => {});
                            }}
                          >
                            <Text style={[styles.routePillText, { color: active ? colors.onAccent : colors.muted }]}>
                              {t(`routes.${category.key}`)}
                            </Text>
                            <Text style={[styles.routePillSub, { color: active ? colors.onAccent : colors.subtle }]}>
                              {candidate.transferCount === 0
                                ? t('route.directOnly', { min: candidate.travelMinutes })
                                : t('route.minutesAndTransfers', { min: candidate.travelMinutes, count: candidate.transferCount })}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                  {journey && (
                    <EditorialTimeline stops={journeyDisplayToStops(journey)} />
                  )}
                  {route && effectiveOrigin && destination && (
                    <Pressable
                      style={[styles.viewOnMapButton, { borderColor: colors.accent }]}
                      onPress={() => router.push('/(tabs)/map')}
                      testID="view-route-on-map-button"
                    >
                      <Text style={[typography.bodySm, { color: colors.accent, fontWeight: '600' }]}>
                        {t('home.viewRouteOnMap')}
                      </Text>
                    </Pressable>
                  )}
                </View>

                {/* Actions */}
                <View style={styles.actionsRow}>
                  <Pressable onPress={() => setPickerVisible(true)}>
                    <Text style={[typography.bodySm, { color: colors.accent, fontWeight: '600' }]}>
                      {t('home.destinationChange')}
                    </Text>
                  </Pressable>
                  <View style={[styles.vHair, { backgroundColor: colors.hair }]} />
                  <Pressable onPress={() => setDestination(null)} testID="destination-clear-button">
                    <Text style={[typography.bodySm, { color: colors.muted }]}>{t('home.destinationReset')}</Text>
                  </Pressable>
                </View>

                <Hr />

                {/* Sleep mode */}
                <View style={styles.sleepRow} testID="sleep-mode-row">
                  <View>
                    <Text style={[typography.bodySm, { color: colors.ink, fontWeight: '600' }]}>
                      {t('home.sleepMode')}
                    </Text>
                    <Text style={[typography.mono, { color: colors.muted, marginTop: 2 }]}>
                      {t('home.sleepModeDescription')}
                    </Text>
                  </View>
                  <Switch
                    value={sleepMode}
                    onValueChange={(value) => {
                      if (value) {
                        showSleepModeGuide(() => setSleepMode(true));
                      } else {
                        setSleepMode(false);
                      }
                    }}
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
                    style={[styles.recentDestinationButton, { borderColor: colors.accent }]}
                    onPress={() => setDestination(recentDestination)}
                    testID="recent-destination-button"
                  >
                    <Text style={[styles.recentDestinationLabel, { color: colors.accent }]}>{t('home.previousDestination')}</Text>
                    <View style={styles.recentDestinationRow}>
                      <Text style={[styles.recentDestinationName, { color: colors.ink }]}>{getStationDisplayName(recentDestination)}</Text>
                      <View style={[styles.recentLineBadge, { backgroundColor: recentDestination.lineColor }]}>
                        <Text style={styles.recentLineText}>{LINE_NAMES[recentDestination.line]}</Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[styles.destinationButton, { backgroundColor: colors.accent }]}
                  onPress={() => setPickerVisible(true)}
                  testID="destination-button"
                >
                  <Text style={[styles.destinationButtonText, { color: colors.onAccent }]}>{t('home.destinationSet')}</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Arrivals — 경로 선택된 경우에만 노출 */}
            {route && (
              <View style={[styles.arrivalSection, { backgroundColor: colors.card }]}>
                <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t('home.arrivalInfoTitle')}</Text>
                {arrivalLoading && !arrival && (
                  <Text style={[styles.arrivalItem, { color: colors.ink }]}>{t('home.loading')}</Text>
                )}
                {arrivalIsMock && (
                  <Text style={[styles.mockNotice, { color: colors.warn }]}>{t('home.mockNotice')}</Text>
                )}
                {arrival && (
                  <>
                    <ArrivalRow label={t('arrival.upbound')} items={arrival.up} />
                    <ArrivalRow label={t('arrival.downbound')} items={arrival.down} />
                  </>
                )}
              </View>
            )}
          </>
        ) : locationUncertain ? (
          <View style={styles.center} testID="location-uncertain">
            <Text style={styles.icon}>📍</Text>
            <Text style={[styles.title, { color: colors.ink }]}>{t('home.locationUncertainTitle')}</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>{t('home.locationUncertainDescription')}</Text>
            <TouchableOpacity style={[styles.button, { backgroundColor: colors.accent }]} onPress={refresh}>
              <Text style={[styles.buttonText, { color: colors.onAccent }]}>{t('home.refresh')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.center}>
            <Text style={styles.icon}>🚶</Text>
            <Text style={[styles.title, { color: colors.ink }]}>{t('home.notNearStationTitle')}</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>{t('home.notNearStationDescription')}</Text>
            <TouchableOpacity style={[styles.button, { backgroundColor: colors.accent }]} onPress={refresh}>
              <Text style={[styles.buttonText, { color: colors.onAccent }]}>{t('home.refresh')}</Text>
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
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={[styles.arrivalRow, { borderTopColor: colors.hair }]}>
      <Text style={[styles.arrivalLabel, { color: colors.muted }]}>{label}</Text>
      <View>
        {items.length === 0 ? (
          <Text style={[styles.arrivalItem, { color: colors.ink }]}>{t('home.noArrivalInfo')}</Text>
        ) : (
          items.map((item, idx) => (
            <View key={idx} style={styles.arrivalItemContainer}>
              <Text style={[styles.arrivalItem, { color: colors.ink }]}>
                {item.destination ? `${item.destination} · ` : ''}
                {formatArrivalTime(item.arrivalSeconds)}
              </Text>
              {item.statusMessage !== '' && (
                <Text style={[styles.statusMessage, { color: colors.accent }]}>{item.statusMessage}</Text>
              )}
            </View>
          ))
        )}
      </View>
    </View>
  );
}

function Dot() {
  const { colors } = useTheme();
  return <Text style={{ color: colors.subtle }}>·</Text>;
}
function Hr() {
  const { colors } = useTheme();
  return <View style={{ height: 1, backgroundColor: colors.hair, marginHorizontal: spacing.xxl }} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  arrivedBanner: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  arrivedBannerText: {
    color: '#ffffff', // success 배경 위 텍스트 — 항상 흰색 유지
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
  routePillGroup: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 3,
    marginBottom: spacing.lg,
  },
  routePill: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  routePillText: {
    fontSize: 13,
    fontWeight: '600',
  },
  routePillSub: {
    fontSize: 11,
    marginTop: 2,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxl,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.sm,
  },
  vHair: { width: 1, height: 12 },
  viewOnMapButton: {
    marginTop: spacing.xl,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  sleepRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xl,
  },
  recentDestinationButton: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
  },
  recentDestinationLabel: {
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
    fontSize: 16,
    fontWeight: '700',
  },
  recentLineBadge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  recentLineText: {
    color: '#fff', // 노선색(lineColor) 배경 위 텍스트 — 항상 흰색 유지
    fontSize: 11,
    fontWeight: 'bold',
  },
  destinationButton: {
    borderRadius: radius.md,
    paddingVertical: 10,
    alignItems: 'center',
  },
  destinationButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
  arrivalSection: {
    marginHorizontal: spacing.xxl,
    marginTop: spacing.xl,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.lg,
  },
  sectionTitle: {
    fontSize: 14,
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
  },
  arrivalLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  arrivalItemContainer: {
    marginBottom: 4,
  },
  arrivalItem: {
    fontSize: 15,
    textAlign: 'right',
  },
  statusMessage: {
    fontSize: 12,
    textAlign: 'right',
    marginTop: 2,
  },
  mockNotice: {
    fontSize: 12,
    marginBottom: 8,
  },
  icon: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  loadingText: {
    fontSize: 16,
  },
  errorText: {
    fontSize: 16,
    marginBottom: 16,
  },
  button: {
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: radius.lg,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '700',
  },
});
