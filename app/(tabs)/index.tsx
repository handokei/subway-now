import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, InteractionManager, Pressable, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { useTranslation } from 'react-i18next';
import { useFusedNearestStation } from '../../src/hooks/useFusedNearestStation';
import { useArrivalInfo } from '../../src/hooks/useArrivalInfo';
import type { ArrivalInfo } from '../../src/api/arrivalApi';
import { useArrivalCountdown } from '../../src/hooks/useArrivalCountdown';
import { formatArrivalTime } from '../../src/utils/formatTime';
import { LINE_NAMES } from '../../src/constants/lineColors';
import { useAppStore } from '../../src/store/useAppStore';
import { useBoardingLockStore } from '../../src/store/useBoardingLockStore';
import { DestinationPicker } from '../../src/components/DestinationPicker';
import { findRouteCandidatesByCategory, buildJourneyDisplay, calculateETA, calculateStaticETA, getNextStationName, routeSignature, type Route, type CategorizedRoute, type RoutePreference } from '../../src/utils/stationRoute';
import { EditorialTimeline } from '../../src/components/EditorialTimeline';
import { journeyDisplayToStops, nearestResultToNearest } from '../../src/utils/journeyAdapter';
import { useRouter } from 'expo-router';
import { getStationDisplayName } from '../../src/utils/stationDisplay';
import { initStationNotification, updateStationNotification, clearStationNotification, clearAlarmNotification } from '../../src/utils/stationNotification';
import { useStationAlarm } from '../../src/hooks/useStationAlarm';
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
import { SourceBadge } from '../../src/components/SourceBadge';
import { resolveNotificationSource } from '../../src/utils/notificationSource';
import { ArrivalSourceNotice } from '../../src/components/ArrivalSourceNotice';
import { useSleepModeGuide } from '../../src/hooks/useSleepModeGuide';
import { useArrivalAutoClear } from '../../src/hooks/useArrivalAutoClear';
import { useBoardingLockController } from '../../src/hooks/useBoardingLockController';
import { useBoardingLockScheduler } from '../../src/hooks/useBoardingLockScheduler';
import { useBoardingLockAdvancer } from '../../src/hooks/useBoardingLockAdvancer';
import { BoardingLockBanner } from '../../src/components/BoardingLockBanner';
import { MisBoardingBanner } from '../../src/components/MisBoardingBanner';
import { MisBoardingReselectModal } from '../../src/components/MisBoardingReselectModal';
import { Toast } from '../../src/components/Toast';
import { useMisBoardingDetector } from '../../src/hooks/useMisBoardingDetector';
import { useTrainPositions } from '../../src/hooks/useTrainPositions';
import { useTransferTrainList } from '../../src/hooks/useTransferTrainList';
import { TRANSFER_WALKING_BUFFER_SECONDS } from '../../src/constants/boardingLock';
import { BoardingTrainList } from '../../src/components/BoardingTrainList';
import { resolveNextAdjacentStationName } from '../../src/utils/nextAdjacentStation';
import type { Stop } from '../../src/utils/journeyAdapter';

const logger = createLogger('HomeScreen');

// #534: 첫 LA 송출 시 route 계산 완료를 기다리는 최대 시간. 이 시간을 넘기면 ETA 없이
// destination-only로 송출해 경로 산출이 영구 실패하는 케이스에서도 LA가 뜨도록 한다.
const FIRST_SEND_ROUTE_WAIT_MS = 1500;

export default function HomeScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const customOrigin = useAppStore((s) => s.customOrigin);
  const loadCustomOrigin = useAppStore((s) => s.loadCustomOrigin);
  const addFavorite = useAppStore((s) => s.addFavorite);
  const removeFavorite = useAppStore((s) => s.removeFavorite);
  const setSlotFavorite = useAppStore((s) => s.setSlotFavorite);
  const favorites = useAppStore((s) => s.favorites);
  const loadFavorites = useAppStore((s) => s.loadFavorites);
  const destination = useAppStore((s) => s.destination);
  const setDestination = useAppStore((s) => s.setDestination);
  const loadDestination = useAppStore((s) => s.loadDestination);
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
  const prevNotifKeyRef = useRef<string | undefined>(undefined);
  const prevDestIdRef = useRef<string | null>(null);
  // #534: route 비동기 계산이 끝나기 전 첫 LA 송출이 일어나면 ETA-less 카드가 잠금화면에
  // 박힌다. route 도착까지 첫 송출을 지연시키되, FIRST_SEND_ROUTE_WAIT_MS 내에 route가
  // 안 오면 destination-only로 송출 (경로 산출 영구 실패 폴백 보존).
  const firstSendWaitStartRef = useRef<number | null>(null);
  const firstSendFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [firstSendFallbackTick, setFirstSendFallbackTick] = useState(0);
  const routePreference = useAppStore((s) => s.routePreference);
  const loadRoutePreference = useAppStore((s) => s.loadRoutePreference);
  const [categorized, setCategorized] = useState<CategorizedRoute[]>([]);
  const [selectedKey, setSelectedKey] = useState<RoutePreference>(routePreference);
  // #546: 경로 timeline을 출발/환승/도착 마커만 보일지(false), 모든 정거장을 펼쳐 보일지(true)
  // 사용자가 토글한다. 세션 in-memory — 재기동 시 compact 기본.
  const [routeExpanded, setRouteExpanded] = useState(false);
  // categorized/selectedKey가 동일하면 같은 reference를 유지해 하위 훅(LiveActivity,
  // useApnsTripRegistration)의 useEffect가 매 렌더 재발사되는 churn을 막는다.
  const route: Route = useMemo(
    () => categorized.find((r) => r.category.key === selectedKey)?.candidate.route ?? null,
    [categorized, selectedKey],
  );
  const routeSig = useMemo(() => routeSignature(route), [route]);

  // 트립 origin은 destination 설정 시점에 캡처되어 trip 동안 고정 (useTripOrigin 참조).
  // useFusedNearestStation 첫 호출 시점엔 routeContext=undefined로 GPS fusion fallback,
  // 다음 렌더에서 useTripOrigin이 effectiveOrigin을 캡처해 setTripOrigin을 호출하면
  // routeContext가 채워지고 useRouteProgress(1D map matching)가 활성화된다.
  // #700 — store SSOT로 이전. cold restart 시 loadTripOrigin이 영속값을 복원해
  // 첫 GPS fix가 진짜 출발역과 다른 회귀를 차단한다.
  const tripOrigin = useAppStore((s) => s.tripOrigin);
  const setTripOrigin = useAppStore((s) => s.setTripOrigin);
  const loadTripOrigin = useAppStore((s) => s.loadTripOrigin);
  const routeContext = useMemo(
    () => (route && tripOrigin && destination ? { route, origin: tripOrigin, destination } : undefined),
    [route, tripOrigin, destination],
  );
  // #584 PR D2: lock.trainCode를 fusion에 전달 — position-train이 같은 trainCode면 'boarding-lock' 승격.
  // #621: lock 전체도 전달 — 지하 GPS stale 시 시간 interpolation으로 ratchet forward.
  // 동일 store의 lock을 useBoardingLockController가 아래서 다시 소비하지만 selector라 churn 없음.
  const fusionBoardingLock = useBoardingLockStore((s) => s.lock);
  const lockedTrainCode = fusionBoardingLock?.trainCode ?? null;
  const { result, variants, userLocation, speedMps, accuracyMeters, loading, error, permissionDenied, locationUncertain, positionStability, refresh, confidence, source } = useFusedNearestStation(undefined, undefined, routeContext, lockedTrainCode, fusionBoardingLock);
  const handleArrivalClear = useCallback(() => setDestination(null), [setDestination]);
  const { arrivedBanner } = useArrivalAutoClear({
    currentStationName: result?.station.name,
    distanceKm: result?.distanceKm,
    destinationName: destination?.name,
    onClear: handleArrivalClear,
  });
  // AppState listener는 단일-바인딩 패턴이라 deps에 refresh를 추가할 수 없다.
  // 최신 refresh 함수를 ref에 보관해 listener에서 호출한다.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const isCustomOrigin = customOrigin !== null;
  const effectiveOrigin = customOrigin ?? result?.station ?? null;
  useTripOrigin(destination, effectiveOrigin, setTripOrigin, tripOrigin);
  const { arrival: rawArrival, isMock: arrivalIsMock, loading: arrivalLoading } = useArrivalInfo(
    effectiveOrigin?.name ?? null,
    effectiveOrigin?.line ?? null,
  );
  const arrival = useArrivalCountdown(rawArrival);
  const isFav = effectiveOrigin ? favorites.some((f) => f.station.id === effectiveOrigin.id) : false;

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
    if (!arrival || arrivalIsMock) return null;
    const directions = [arrival.up, arrival.down];
    const minutes = directions.map((trains) => {
      const first = trains[0];
      return first?.arrivalSeconds != null ? Math.floor(first.arrivalSeconds / 60) : Infinity;
    });
    return Math.min(...minutes);
  }, [arrival, arrivalIsMock]);
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
    fusionSource: source,
    locationUncertain,
    positionStability,
  });

  // #584 PR B — BoardingLock 진입점. UI 렌더링/lock 생성만 담당하며,
  // alarm/Fusion과의 wiring은 후속 PR C/D에서 활성화된다.
  const {
    lock: boardingLock,
    directionalArrivals,
    createLockFromTrain,
    releaseLock: releaseBoardingLock,
  } = useBoardingLockController({
    destinationId: destination?.id ?? null,
    destinationName: destination?.name ?? null,
    route,
    arrival,
    currentStation: result?.station ?? null,
    expectedDurationMinutes: staticEtaMinutes,
  });
  useBoardingLockScheduler({
    lock: boardingLock,
    route,
    destinationName: destination?.name ?? null,
  });
  useBoardingLockAdvancer({
    lock: boardingLock,
    route,
    destinationName: destination?.name ?? null,
    currentStationName: result?.station.name ?? null,
  });
  // #584 PR D3: lock.boardingLine 위치 데이터를 별도 구독 — fusion 캐시와 dedup되어 추가 비용 없음.
  // lock 없으면 line=null로 호출되어 polling이 자동 정지된다.
  const { positions: lockLinePositions } = useTrainPositions(boardingLock?.boardingLine ?? null);
  const { detected: misBoardingDetected } = useMisBoardingDetector({
    lock: boardingLock,
    positions: lockLinePositions,
  });
  // #603: detected false→true 전환 시점에 토스트 + 모달 1회 발사. true가 유지되어도 중복 발사 X.
  // banner는 그대로 노출되어 사용자가 닫은 뒤에도 잘못 탑승 상태를 알 수 있다.
  const [misBoardingToastVisible, setMisBoardingToastVisible] = useState(false);
  const [misBoardingModalVisible, setMisBoardingModalVisible] = useState(false);
  const prevMisBoardingRef = useRef(false);
  useEffect(() => {
    if (misBoardingDetected && !prevMisBoardingRef.current) {
      setMisBoardingToastVisible(true);
      setMisBoardingModalVisible(true);
    }
    prevMisBoardingRef.current = misBoardingDetected;
  }, [misBoardingDetected]);
  const handleMisBoardingReselect = useCallback(
    (train: ArrivalInfo) => {
      createLockFromTrain(train);
      setMisBoardingModalVisible(false);
      setMisBoardingToastVisible(false);
    },
    [createLockFromTrain],
  );
  // setState setter는 stable 참조지만 인라인 화살표를 prop으로 넘기면 매 렌더 새 함수가 되어
  // Toast의 5초 타이머 effect가 재설정된다(역 폴링 30s, 도착 갱신 등으로 리렌더 잦음).
  const handleMisBoardingToastDismiss = useCallback(() => setMisBoardingToastVisible(false), []);
  const handleMisBoardingModalClose = useCallback(() => setMisBoardingModalVisible(false), []);
  // #584 PR E: 활성 lock이 현재 leg의 transfer waypoint에 도달하면 다음 노선 도착 list 노출.
  const {
    context: transferContext,
    arrivals: transferArrivals,
    createTransferLock,
  } = useTransferTrainList({
    lock: boardingLock,
    route,
    destinationName: destination?.name ?? null,
    currentStation: result?.station ?? null,
  });
  useBackgroundLocation(destination);
  useApnsTripRegistration({
    route,
    destination,
    nextStationEtaSeconds:
      nextTrainMinutes != null && nextTrainMinutes !== Infinity ? nextTrainMinutes * 60 : null,
    currentStation: result?.station ?? null,
    boardingLock,
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
    // iOS가 BG에서 앱을 메모리 압박으로 종료하면 Zustand 상태는 휘발되지만
    // DESTINATION_KEY는 디스크에 남는다. 콜드/웜 부팅 시 복원해 trip을 이어간다 (#541).
    // #700 — tripOrigin을 먼저 await으로 hydrate한 다음 destination을 set한다.
    // 순서를 뒤집으면 destination이 먼저 truthy로 set되는 commit에서 effectiveOrigin이
    // 캐시된 GPS로 이미 truthy → useTripOrigin capture effect가 잘못된 origin으로
    // setter 호출 → 영속값(진짜 출발역) 덮어쓰기. 직렬화로 race를 차단한다.
    void (async () => {
      await loadTripOrigin();
      await loadDestination();
    })();
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
    return () => {
      subscription.remove();
      if (firstSendFallbackTimerRef.current) {
        clearTimeout(firstSendFallbackTimerRef.current);
        firstSendFallbackTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const prevDestId = prevDestIdRef.current;
    const currDestId = destination?.id ?? null;
    prevDestIdRef.current = currDestId;

    // 도착 배너가 떠 있는 동안에는 LA가 막 종료된 직후 displayEta/alarmEvent 갱신으로
    // updateStationNotification이 호출되어 LA가 부활하는 race를 막는다. arrivedBanner는
    // 2초 후 setDestination(null)과 함께 false로 풀린다.
    if (arrivedBanner) return;

    // 실시간 현황(Live Activity/알림)은 경로 진행 중일 때만 노출한다.
    if (!effectiveOrigin || !destination) {
      if (prevNotifKeyRef.current !== 'none') {
        prevNotifKeyRef.current = 'none';
        logger.info('경로 없음 → 알림 해제');
        clearAlarmNotification().catch((e) => logger.error('알림 해제 실패:', e));
        clearStationNotification().catch((e) => logger.error('알림 해제 실패:', e));
      }
      firstSendWaitStartRef.current = null;
      if (firstSendFallbackTimerRef.current) {
        clearTimeout(firstSendFallbackTimerRef.current);
        firstSendFallbackTimerRef.current = null;
      }
      return;
    }
    const isFirstSend = prevNotifKeyRef.current === undefined || prevNotifKeyRef.current === 'none';
    // route가 아직 계산되지 않은 짧은 윈도우(콜드 스타트, categorized async fill 중)에
    // 정상 payload를 한 번 송출한 뒤라면 destination-only로 덮어쓰지 말고 이전 payload를
    // 유지한다.
    if (!route && !isFirstSend) {
      return;
    }
    // #534: 첫 송출이고 route가 아직 없으면 staticEta 계산 불가 → ETA-less LA가 박힌다.
    // FIRST_SEND_ROUTE_WAIT_MS 내에 route가 도착하면 routeSig deps 변화로 자연 재발화되어
    // ETA 포함 송출. 타임아웃 만료 시 setFirstSendFallbackTick으로 재발화시켜 폴백 송출.
    if (!route && isFirstSend) {
      if (firstSendWaitStartRef.current === null) {
        firstSendWaitStartRef.current = Date.now();
      }
      const elapsed = Date.now() - firstSendWaitStartRef.current;
      if (elapsed < FIRST_SEND_ROUTE_WAIT_MS) {
        if (!firstSendFallbackTimerRef.current) {
          firstSendFallbackTimerRef.current = setTimeout(() => {
            firstSendFallbackTimerRef.current = null;
            setFirstSendFallbackTick((n) => n + 1);
          }, FIRST_SEND_ROUTE_WAIT_MS - elapsed);
        }
        return;
      }
    }
    firstSendWaitStartRef.current = null;
    if (firstSendFallbackTimerRef.current) {
      clearTimeout(firstSendFallbackTimerRef.current);
      firstSendFallbackTimerRef.current = null;
    }
    const key = `${effectiveOrigin.id}__${destination.id}__${routeSig}__${displayEta ?? ''}__${arrivalIsMock}__${alarmEvent?.type ?? ''}`;
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
        // FG fusion 결과 source를 LA에 전달 (#327). FusionSource → NotificationSource로 매핑.
        // customOrigin 사용자가 직접 출발지 설정한 경우엔 라벨 부착 안 함.
        isCustomOrigin ? undefined : resolveNotificationSource(source, locationUncertain),
      );
    };
    update().catch((e) => logger.error('알림 업데이트 실패:', e));
  }, [effectiveOrigin?.id, destination?.id, displayEta, arrivalIsMock, routeSig, alarmEvent, arrivedBanner, firstSendFallbackTick]);

  useEffect(() => {
    if (arrivedBanner) {
      clearStationNotification().catch(console.error);
      clearAlarmNotification().catch(console.error);
      clearAlarmEvent();
      prevNotifKeyRef.current = undefined;
      // #534: arrived→재트립 진입 시 이전 트립의 대기 윈도우/타이머가 잔존하지 않도록 정리.
      firstSendWaitStartRef.current = null;
      if (firstSendFallbackTimerRef.current) {
        clearTimeout(firstSendFallbackTimerRef.current);
        firstSendFallbackTimerRef.current = null;
      }
    }
  }, [arrivedBanner]);

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
      <Toast
        visible={misBoardingToastVisible}
        message="탑승 열차를 찾을 수 없어요. 다시 선택해주세요."
        onDismiss={handleMisBoardingToastDismiss}
        accent={colors.warn}
        testID="mis-boarding-toast"
      />
      {/* line이 정해져야 list를 렌더 가능 — line null이면 모달 자체를 띄우지 않음 (빈 sheet 회피). */}
      <MisBoardingReselectModal
        visible={misBoardingModalVisible && effectiveOrigin?.line != null}
        arrivals={directionalArrivals}
        line={effectiveOrigin?.line ?? null}
        onSelect={handleMisBoardingReselect}
        onClose={handleMisBoardingModalClose}
      />

      <ScrollView contentContainerStyle={{ paddingBottom: 80 }}>
        {effectiveOrigin ? (
          <>
            {/* Hero: origin station */}
            <View style={{ paddingHorizontal: spacing.xxl, paddingTop: spacing.xxxl - 4 }}>
              <Text style={[typography.label, { color: colors.muted, marginBottom: 10 }]}>
                {isCustomOrigin
                  ? t('home.originManual')
                  : source !== 'gps'
                  ? t('home.originEstimated')
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
                {originVariants.length > 0 ? (
                  originVariants.map((v) => <LineBadge key={v.id} line={v.line} />)
                ) : (
                  <LineBadge line={effectiveOrigin.line} />
                )}
                {/* #446: source==='gps'일 때만 user↔station 거리/도보시간이 의미 있음.
                    fusion 추정(positionTrain/arrival/route) 결과의 거리는 user↔추정역
                    직선거리라 도보 안내로 표시하면 잘못된 정보가 됨 → 숨김. */}
                {!isCustomOrigin && nearest && source === 'gps' && (
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
                {!isCustomOrigin && (
                  <SourceBadge
                    source={source}
                    locationUncertain={locationUncertain}
                    testID="home-source-badge"
                  />
                )}
                {__DEV__ && (
                  <>
                    <Dot />
                    <Text
                      style={[typography.bodySm, { color: colors.warn, fontWeight: '700' }]}
                      testID="home-fusion-source-badge"
                    >
                      {source}·{confidence}
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
                  {journey && (() => {
                    const stops = journeyDisplayToStops(journey, { expanded: routeExpanded });
                    return (
                      <>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={routeExpanded ? t('home.routeCollapse') : t('home.routeExpand')}
                          onPress={() => setRouteExpanded((v) => !v)}
                          style={styles.expandToggle}
                          testID="route-expand-toggle"
                        >
                          <Text style={[typography.label, { color: colors.accent, fontWeight: '600' }]}>
                            {routeExpanded ? t('home.routeCollapse') : t('home.routeExpand')}
                          </Text>
                        </Pressable>
                        <EditorialTimeline
                          stops={stops}
                          renderHopSlot={(stop, i) => {
                            // #649 — origin hop slot: 현재역에서 다음 인접역 방면 boarding list
                            if (i === 0 && stop.mark === 'filled' && !boardingLock && effectiveOrigin) {
                              const towardName = findNextWaypointName(stops, i);
                              const label = towardName
                                ? resolveNextAdjacentStationName(
                                    effectiveOrigin.line,
                                    effectiveOrigin.name,
                                    towardName,
                                  )
                                : null;
                              return (
                                <BoardingTrainList
                                  arrivals={directionalArrivals}
                                  line={effectiveOrigin.line}
                                  onSelect={createLockFromTrain}
                                  compact
                                  nextStationLabel={label}
                                />
                              );
                            }
                            // #649 — transfer hop slot: 현재 활성 transfer 시점에만 노출.
                            // multi-transfer 라우트에서도 transferContext가 가리키는 단일 transfer만 매칭.
                            if (
                              stop.mark === 'transfer' &&
                              transferContext &&
                              stop.station === transferContext.transferStationInToLine.name
                            ) {
                              const label = resolveNextAdjacentStationName(
                                transferContext.nextLine,
                                transferContext.transferStationInToLine.name,
                                transferContext.nextWaypointName,
                              );
                              return (
                                <BoardingTrainList
                                  arrivals={transferArrivals}
                                  line={transferContext.nextLine}
                                  onSelect={createTransferLock}
                                  walkingBufferSeconds={TRANSFER_WALKING_BUFFER_SECONDS}
                                  compact
                                  nextStationLabel={label}
                                />
                              );
                            }
                            return null;
                          }}
                        />
                      </>
                    );
                  })()}
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
                  {/* #625 — BoardingLock/MisBoarding 배너는 route 컨텍스트 안에서 노출.
                       종전에는 sleep mode toggle 아래라 사용자가 route와 별도 카드로 인지하지
                       못함 + 너무 멀리 떨어져 있었음. 이제 경로 표시 직후로 이동.
                       외곽 {destination && ...} 가드 안쪽이라 destination 재가드 불필요. */}
                  {boardingLock && misBoardingDetected && (
                    <MisBoardingBanner onReselect={releaseBoardingLock} />
                  )}
                  {boardingLock && (
                    <BoardingLockBanner lock={boardingLock} onRelease={releaseBoardingLock} />
                  )}
                  {/* #649 — BoardingTrainList 두 인스턴스(현재역/환승)는 EditorialTimeline의
                       renderHopSlot으로 이동: timeline hop 사이에 inline compact 표기. */}
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

            {/* #634: BoardingTrainList 두 인스턴스(현재역/환승)는 route 박스 안으로 이동됨. */}
            {effectiveOrigin && (
              <View style={[styles.arrivalSection, { backgroundColor: colors.card }]}>
                <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t('home.arrivalInfoTitle')}</Text>
                {arrivalLoading && !arrival && (
                  <Text style={[styles.arrivalItem, { color: colors.ink }]}>{t('home.loading')}</Text>
                )}
                <ArrivalSourceNotice arrival={arrival} />
                {arrival && arrival.source !== 'closed' && (
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
        <AlarmOverlay
          event={alarmEvent}
          onDismiss={clearAlarmEvent}
          // #633: 도착 알람 dismiss 시 trip 종료. lock release + destination clear.
          // 환승 알람은 AlarmOverlay 내부에서 trip 유지하며 진동만 정지.
          onEndTrip={() => {
            releaseBoardingLock();
            setDestination(null);
          }}
        />
      )}

      <DestinationPicker
        visible={pickerVisible}
        onSelect={(station) => {
          setRecentDestination(station);
          setDestination(station);
          setPickerVisible(false);
        }}
        onClose={() => setPickerVisible(false)}
        favorites={favorites}
        onAssignSlot={setSlotFavorite}
        userLat={userLocation?.lat ?? null}
        userLng={userLocation?.lng ?? null}
        onRecenter={() => {
          void refreshRef.current();
        }}
      />
    </SafeAreaView>
  );
}

/**
 * stops 배열에서 fromIdx 다음의 waypoint(intermediate 아닌 stop) 이름을 찾는다(#649).
 * 종착까지 도달 못 하면 null — slot에서 라벨 계산 fallback에 사용.
 */
function findNextWaypointName(stops: Stop[], fromIdx: number): string | null {
  for (let i = fromIdx + 1; i < stops.length; i++) {
    if (stops[i].mark !== 'intermediate') return stops[i].station;
  }
  return null;
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
  expandToggle: {
    alignSelf: 'flex-end',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.xs,
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
