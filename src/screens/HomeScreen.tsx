import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, InteractionManager, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { useTranslation } from 'react-i18next';
import { useFusedNearestStation } from '../features/nearest-station/hooks/useFusedNearestStation';
import { useV1MismatchDetector } from '../features/nearest-station/hooks/useV1MismatchDetector';
import { useStationMismatchDetector } from '../features/nearest-station/hooks/useStationMismatchDetector';
import { useArrivalInfo } from '../features/arrival/hooks/useArrivalInfo';
import type { ArrivalInfo } from '../features/arrival/api/arrivalApi';
import { useArrivalCountdown } from '../features/arrival/hooks/useArrivalCountdown';
import { LINE_NAMES } from '../shared/constants/lineColors';
import { useFavoritesStore } from '../features/favorites/store/useFavoritesStore';
import { useSettingsStore } from '../features/settings/store/useSettingsStore';
import { useDestinationStore } from '../features/route/store/useDestinationStore';
import { useAlarmEventStore } from '../features/alarm/store/useAlarmEventStore';
import { useBoardingLockStore } from '../features/alarm/store/useBoardingLockStore';
import { useUserIntentStore } from '../features/alarm/store/useUserIntentStore';
import { DestinationPicker } from '../features/route/components/DestinationPicker';
import { findRouteCandidatesByCategory, buildJourneyDisplay, calculateETA, calculateStaticETA, getNextStationName, getStationById, routeSignature, type Route, type CategorizedRoute, type RoutePreference } from '../shared/utils/stationRoute';
import { pickArrivalAtOrigin } from '../features/arrival/utils/pickArrivalAtOrigin';
import { EditorialTimeline } from '../features/arrival/components/EditorialTimeline';
import { arrivalInfoToArrivalTrain, journeyDisplayToStops, nearestResultToNearest } from '../features/route/utils/journeyAdapter';
import { EditorialArrivalRow } from '../features/arrival/components/EditorialArrivalRow';
import { useRouter } from 'expo-router';
import { getStationDisplayName } from '../shared/utils/stationDisplay';
import { initStationNotification, updateStationNotification, clearStationNotification, clearAlarmNotification } from '../features/alarm/utils/stationNotification';
import { useWidgetMirror } from '../features/widget/hooks/useWidgetMirror';
import { saveStationToWidget } from '../features/widget/api/widgetStorage';
import { buildWidgetTripContext } from '../features/widget/utils/buildTripContext';
import { useStationAlarm } from '../features/alarm/hooks/useStationAlarm';
import { useMotionActivity } from '../features/nearest-station/hooks/useMotionActivity';
import { useAccelerometer } from '../features/nearest-station/hooks/useAccelerometer';
import { useBarometer } from '../shared/hooks/useBarometer';
import { useTripOrigin } from '../features/route/hooks/useTripOrigin';
import { useBackgroundLocation } from '../features/nearest-station/hooks/useBackgroundLocation';
import { useApnsTripRegistration } from '../features/alarm/hooks/useApnsTripRegistration';
import { useLiveActivityDismissBridge } from '../features/alarm/hooks/useLiveActivityDismissBridge';
import { registerSilentPushTask } from '../features/alarm/tasks/silentPushTask';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ROUTE_KEY } from '../shared/constants/storageKeys';
import { AlarmOverlay } from '../features/alarm/components/AlarmOverlay';
import { createLogger } from '../shared/utils/logger';
import { useTheme, typography, spacing, radius } from '../shared/theme';
import { ActionBanner } from '../shared/ui/ActionBanner';
import { LineBadge } from '../shared/ui/LineBadge';
import { LocationStateView } from '../shared/ui/LocationStateView';
import { ServiceWindowBanner } from '../shared/ui/ServiceWindowBanner';
import { PermissionChangeBanner } from '../shared/ui/PermissionChangeBanner';
import { useLocationPermissionWatcher } from '../shared/hooks/useLocationPermissionWatcher';
import { SourceBadge } from '../features/arrival/components/SourceBadge';
import { resolveNotificationSource } from '../features/alarm/utils/notificationSource';
import { ArrivalSourceNotice } from '../features/arrival/components/ArrivalSourceNotice';
import { useSleepModeGuide } from '../features/settings/hooks/useSleepModeGuide';
import { useSilentPushHealthCheck } from '../features/alarm/hooks/useSilentPushHealthCheck';
import { useArrivalAutoClear } from '../features/arrival/hooks/useArrivalAutoClear';
import { useBoardingLockController } from '../features/alarm/hooks/useBoardingLockController';
import { useBoardingLockScheduler } from '../features/alarm/hooks/useBoardingLockScheduler';
import { useTripBoundAlarmScheduler } from '../features/alarm/hooks/useTripBoundAlarmScheduler';
import { useBoardingLockAdvancer } from '../features/alarm/hooks/useBoardingLockAdvancer';
import { useBoardingLockAutoRelease } from '../features/alarm/hooks/useBoardingLockAutoRelease';
import { useDestinationAutoClear } from '../features/alarm/hooks/useDestinationAutoClear';
import { useBoardingLockSync } from '../features/alarm/hooks/useBoardingLockSync';
import { useFgPositionUpload } from '../features/alarm/hooks/useFgPositionUpload';
import { useCurrentStationConfirmModal } from '../features/nearest-station/hooks/useCurrentStationConfirmModal';
import { isStrongFusionConfidence } from '../shared/constants/fusionConfidenceStrength';
import { useWifiStation } from '../features/nearest-station/hooks/useWifiStation';
import { CurrentStationConfirmModal } from '../features/nearest-station/components/CurrentStationConfirmModal';
import { ColdStartCandidatePicker } from '../features/nearest-station/components/ColdStartCandidatePicker';
import { useColdStartCandidates } from '../features/nearest-station/hooks/useColdStartCandidates';
import type { ColdStartCandidate } from '../features/nearest-station/hooks/useColdStartCandidates';
import { MisBoardingBanner } from '../features/route/components/MisBoardingBanner';
import { MisBoardingReselectModal } from '../features/route/components/MisBoardingReselectModal';
import { ShareTripButton } from '../features/route/components/ShareTripButton';
import { isDegenerateDestination } from '../features/route/utils/isDegenerateDestination';
import { Toast } from '../shared/ui/Toast';
import { useMisBoardingDetector } from '../features/route/hooks/useMisBoardingDetector';
import { useTrainCodeMismatchDetector } from '../features/route/hooks/useTrainCodeMismatchDetector';
import { useTrainPositions } from '../features/route/hooks/useTrainPositions';
import { useTransferTrainList } from '../features/route/hooks/useTransferTrainList';
import { useTransferAutoDetect } from '../features/route/hooks/useTransferAutoDetect';
import {
  BOARDING_PROXIMITY_THRESHOLD_M,
  TRANSFER_WALKING_BUFFER_SECONDS,
} from '../shared/constants/boardingLock';
import { getTransferSeconds } from '../shared/utils/transferTimes';
import { BoardingTrainList } from '../features/alarm/components/BoardingTrainList';
import { BoardingLockHopCard } from '../features/alarm/components/BoardingLockHopCard';
import { LocklessBadge } from '../features/alarm/components/LocklessBadge';
import { resolveNextAdjacentStationName } from '../features/route/utils/nextAdjacentStation';
import { getApproachLine } from '../features/route/utils/approachLine';
import { useCongestion } from '../features/congestion/hooks/useCongestion';
import { deriveCongestionDirection } from '../features/congestion/utils/deriveDirection';
import { CongestionBadge } from '../features/congestion/components/CongestionBadge';
import type { Stop } from '../shared/types/journey';
import type { LineNumber, Station } from '../shared/types/station';

const logger = createLogger('HomeScreen');

// #534: 첫 LA 송출 시 route 계산 완료를 기다리는 최대 시간. 이 시간을 넘기면 ETA 없이
// destination-only로 송출해 경로 산출이 영구 실패하는 케이스에서도 LA가 뜨도록 한다.
const FIRST_SEND_ROUTE_WAIT_MS = 1500;

export default function HomeScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const customOrigin = useDestinationStore((s) => s.customOrigin);
  const setCustomOrigin = useDestinationStore((s) => s.setCustomOrigin);
  const loadCustomOrigin = useDestinationStore((s) => s.loadCustomOrigin);
  // #1541 — 강 SSOT consensus가 customOrigin과 다른 station을 가리킬 때 unlock하는 액션.
  const clearCustomOriginForSsotOverride = useDestinationStore(
    (s) => s.clearCustomOriginForSsotOverride,
  );
  const addFavorite = useFavoritesStore((s) => s.addFavorite);
  const removeFavorite = useFavoritesStore((s) => s.removeFavorite);
  const setSlotFavorite = useFavoritesStore((s) => s.setSlotFavorite);
  const favorites = useFavoritesStore((s) => s.favorites);
  const loadFavorites = useFavoritesStore((s) => s.loadFavorites);
  const destination = useDestinationStore((s) => s.destination);
  const setDestination = useDestinationStore((s) => s.setDestination);
  const loadDestination = useDestinationStore((s) => s.loadDestination);
  const recentDestinations = useDestinationStore((s) => s.recentDestinations);
  const addRecentDestination = useDestinationStore((s) => s.addRecentDestination);
  const removeRecentDestination = useDestinationStore((s) => s.removeRecentDestination);
  const loadRecentDestinations = useDestinationStore((s) => s.loadRecentDestinations);
  const sleepMode = useSettingsStore((s) => s.sleepMode);
  const setSleepMode = useSettingsStore((s) => s.setSleepMode);
  const loadSleepMode = useSettingsStore((s) => s.loadSleepMode);
  const loadAllowSpeaker = useSettingsStore((s) => s.loadAllowSpeaker);
  const showSleepModeGuide = useSleepModeGuide();
  const alarmEvent = useAlarmEventStore((s) => s.alarmEvent);
  const clearAlarmEvent = useAlarmEventStore((s) => s.clearAlarmEvent);
  const loadAlarmEvent = useAlarmEventStore((s) => s.loadAlarmEvent);
  // #1923 — 사용자 명시 의향 토글 SSoT. useApnsTripRegistration이 본 값을 backend로 forward해
  // lockless intermediate gate(`trip.infoModeEnabled && waypoint.kind === 'intermediate'`)를 통과시킨다.
  // 트리거: tryAutoLock(boardingPrompt 응답) / createLockFromTrain(BoardingTrainList 탭) 양쪽에서 stamp.
  const infoModeEnabled = useUserIntentStore((s) => s.infoModeEnabled);
  const loadInfoModeEnabled = useUserIntentStore((s) => s.loadInfoModeEnabled);
  // #746: 알람 dismiss → silence 시작점 기록. 같은 컴포넌트의 userLocation을 같이 캡처.
  const setDismissSilence = useAlarmEventStore((s) => s.setDismissSilence);
  // #746 reviewer P1: cold-start hydration — storage에 살아있는 silence 상태를
  // FG path가 무시하지 않도록 loadAlarmEvent와 같은 시퀀스로 hydrate.
  const loadDismissSilence = useAlarmEventStore((s) => s.loadDismissSilence);
  const [pickerVisible, setPickerVisible] = useState(false);
  // #977 — F4 confirm 모달 검색 fallback. 후보 0개 또는 사용자 명시 "검색으로 선택" 시 origin 전용
  // DestinationPicker(mode='origin')를 띄워 직접 station 검색 → setCustomOrigin.
  const [originPickerVisible, setOriginPickerVisible] = useState(false);
  const prevNotifKeyRef = useRef<string | undefined>(undefined);
  const prevDestIdRef = useRef<string | null>(null);
  // #534: route 비동기 계산이 끝나기 전 첫 LA 송출이 일어나면 ETA-less 카드가 잠금화면에
  // 박힌다. route 도착까지 첫 송출을 지연시키되, FIRST_SEND_ROUTE_WAIT_MS 내에 route가
  // 안 오면 destination-only로 송출 (경로 산출 영구 실패 폴백 보존).
  const firstSendWaitStartRef = useRef<number | null>(null);
  const firstSendFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [firstSendFallbackTick, setFirstSendFallbackTick] = useState(0);
  const routePreference = useDestinationStore((s) => s.routePreference);
  const loadRoutePreference = useDestinationStore((s) => s.loadRoutePreference);
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
  const tripOrigin = useDestinationStore((s) => s.tripOrigin);
  const setTripOrigin = useDestinationStore((s) => s.setTripOrigin);
  const loadTripOrigin = useDestinationStore((s) => s.loadTripOrigin);
  const routeContext = useMemo(
    () => (route && tripOrigin && destination ? { route, origin: tripOrigin, destination } : undefined),
    [route, tripOrigin, destination],
  );
  // #584 PR D2: lock.trainCode를 fusion에 전달 — position-train이 같은 trainCode면 'boarding-lock' 승격.
  // #621: lock 전체도 전달 — 지하 GPS stale 시 시간 interpolation으로 ratchet forward.
  // 동일 store의 lock을 useBoardingLockController가 아래서 다시 소비하지만 selector라 churn 없음.
  const fusionBoardingLock = useBoardingLockStore((s) => s.lock);
  // #1659 — train-code-mismatch release 시 reason stamp용. controller releaseLock은 () => void라
  // breadcrumb reason을 전달할 수 없어 store를 직접 참조한다.
  const releaseLockWithReason = useBoardingLockStore((s) => s.releaseLock);
  const lockedTrainCode = fusionBoardingLock?.trainCode ?? null;
  // #728 — CMMotionActivity 신호. 권한 요청/폴링은 hook 내부에서 lifecycle 관리.
  // 미지원/거절 시 false로 고정되어 기존 가드만 동작 (graceful fallback).
  const motionStationary = useMotionActivity();
  // #1287 — 가속도 수집 활성화. BG task(backgroundLocationTask)가 getLatestAccelSummary()로
  // 조회하는 ambient state를 채운다. 반환값 없음 — useMotionActivity/useBarometer와 동일 패턴.
  // 미지원/권한 거절은 accelMotionState가 null을 유지해 BG task가 graceful fallback.
  useAccelerometer();
  // #903 (Seam G) — 기압계 dP/dt 신호. 미지원/권한 거절은 subsurface=false 고정(graceful).
  //   1) useFusedNearestStation: 'gps-only' → 'gps-only-underground' 강등 + sticky automotive 트리거.
  //   2) useApnsTripRegistration: backend payload subsurface 동봉(threshold 5→10).
  const barometerSignal = useBarometer();
  const { subsurface: barometerSubsurface } = barometerSignal;
  // #913 (F2) — wifiStation: 네이티브 SSID 브릿지(NEHotspotNetwork / WifiManager) → lookupStationBySsid.
  //   1) useFusedNearestStation: subsurface=true(지하 GPS dead zone)일 때 fusion cascade 최우선 채택(#1286).
  //   2) useCurrentStationConfirmModal: 매칭되면 useStationCandidates가 단일 후보로 자동 확정(#914 F4).
  // useFusedNearestStation 호출(아래) 전에 선언해 8번째 인자로 전달한다.
  const wifiStation = useWifiStation();
  // #1677 — silent push 60s+ 미수신 감지. FG 시 backendSsotAccepts 강제 false → device tier fallback.
  // 신규 폴링 없음 — 기존 arrival/position 30s cycle 재사용.
  const { healthy: silentPushHealthy } = useSilentPushHealthCheck();
  const { result, liveResult, variants, userLocation, speedMps, accuracyMeters, loading, error, permissionDenied, locationUncertain, positionStability, refresh, confidence, source, currentHopIndex, arcStations, trainProgressing, estimatorIsTimeIntegration, backendSsotCurrentStationId, environment } = useFusedNearestStation(undefined, undefined, routeContext, lockedTrainCode, fusionBoardingLock, motionStationary, { subsurface: barometerSubsurface, signal: barometerSignal }, wifiStation, silentPushHealthy);

  // #1621 Phase B — V1 mismatch 자동 측정. UI currentStation(cascade picker)이 backend SSoT
  // 권위 mirror와 일치하지 않으면 alarmLog 'v1-mismatch' reason으로 1분 dedup 적재.
  // R2 archive 후 `/admin/alarm-log-stats` 응답으로 1주 production 측정.
  useV1MismatchDetector(result?.station.id ?? null, backendSsotCurrentStationId);

  // #1844 (Phase 6.1 Sub-step 5) — cold start 선택 역과 진행 중 신호 mismatch 감지.
  // lock.boardingLine / arc / environment와 observed 신호가 3회 연속 불일치 시 detected=true.
  // detected=true 시 배너로 재확인 prompt (ActionBanner). alarmLog reason='cold-start-mismatch'로 측정.
  const coldStartMismatch = useStationMismatchDetector({
    boardingLock: fusionBoardingLock,
    fusedResult: result,
    arcStations,
    currentHopIndex,
    environment,
  });

  // #914 (F4) — 1탭 현재역 확정 모달. 자동 추정이 locationUncertain으로 길어지면 후보 1~3개를
  // 카드로 노출, 1탭 = customOrigin 적용.
  const [confirmAutoToast, setConfirmAutoToast] = useState<string | null>(null);
  // #1166 — backend가 사용자 탭과 다른 trainCode로 lock을 확정했을 때 노출하는 정정 toast.
  // BoardingTrainList의 onLockCorrected callback이 채워주며, 같은 메시지가 두 인스턴스(현재역/환승)에
  // 공통 적용된다. dismiss는 Toast의 5초 timer 또는 사용자 tap.
  const [lockCorrectionToast, setLockCorrectionToast] = useState<string | null>(null);
  // #1324 — 목적지 == 현재역(degenerate trip) 선택을 차단했을 때 노출하는 경고 toast.
  const [sameOriginToast, setSameOriginToast] = useState<string | null>(null);
  const handleConfirmStation = useCallback(
    (station: Station) => {
      setCustomOrigin(station);
    },
    [setCustomOrigin],
  );
  const confirmModal = useCurrentStationConfirmModal({
    locationUncertain,
    userLocation,
    wifiStation,
    hasEffectiveOrigin: customOrigin !== null || result?.station != null,
    // #1541 — trip 활성 중에는 F4 자동 확정/모달 모두 비활성. trip-locked origin을
    // 덮어쓰는 stuck 회귀 차단(2026-06-19 트립 2 "고터 11분 stuck").
    tripActive: destination !== null,
    onConfirmStation: handleConfirmStation,
  });
  // #1541 — fusion이 강 confidence로 customOrigin과 다른 station을 SSOT로 가리킬 때
  // customOrigin을 unlock해 사용자가 trip 내내 stuck되는 회귀를 차단한다. confidence='high'는
  // ADR-015 §5 consensus gate 통과 신호이며, ADR-014 §4 "사용자 명시 의향 동급 보호" 원칙상
  // 약한 신호로 덮어쓰지 않는다.
  useEffect(() => {
    if (!customOrigin) return;
    if (!result?.station) return;
    if (!isStrongFusionConfidence(confidence)) return;
    if (result.station.id === customOrigin.id) return;
    clearCustomOriginForSsotOverride(result.station);
  }, [customOrigin, result?.station, confidence, clearCustomOriginForSsotOverride]);
  useEffect(() => {
    if (confirmModal.autoConfirmedStation) {
      setConfirmAutoToast(
        t('currentStationConfirm.autoConfirmed', {
          name: getStationDisplayName(confirmModal.autoConfirmedStation),
        }),
      );
      confirmModal.consumeAutoConfirmed();
    }
  }, [confirmModal.autoConfirmedStation, confirmModal.consumeAutoConfirmed, t]);
  const handleConfirmAutoToastDismiss = useCallback(() => setConfirmAutoToast(null), []);
  // #1166 — pending(prev) → confirmed(next) 정정 시 toast 메시지 구성. 4언어 i18n.
  const handleLockCorrected = useCallback(
    (prev: string, next: string) => {
      setLockCorrectionToast(t('home.lockCorrectionToast', { prev, next }));
    },
    [t],
  );
  const handleLockCorrectionToastDismiss = useCallback(() => setLockCorrectionToast(null), []);
  // #977 — F4 검색 fallback wire. confirm 모달 dismiss(setDismissed=true) + origin picker 오픈.
  // 사용자가 picker에서 station 선택 시 setCustomOrigin → confirm 모달은 hasEffectiveOrigin
  // 으로 자동 차단되어 재오픈하지 않는다.
  // onClose는 hook 내부 useCallback(deps=[])로 stable — 객체 자체가 아닌 method를 deps에 둔다.
  const confirmModalClose = confirmModal.onClose;
  const handleSearchFallback = useCallback(() => {
    confirmModalClose();
    setOriginPickerVisible(true);
  }, [confirmModalClose]);
  const handleOriginPickerSelect = useCallback(
    (station: Station) => {
      setCustomOrigin(station);
      setOriginPickerVisible(false);
    },
    [setCustomOrigin],
  );
  const handleOriginPickerClose = useCallback(() => setOriginPickerVisible(false), []);

  // #1842 Phase 6.1 Sub-step 4 — cold start 다중 후보 선택 UI.
  // trip 활성 중 / customOrigin 확정 후에는 picker를 표시하지 않는다.
  const coldStartCandidates = useColdStartCandidates({
    gps: userLocation && accuracyMeters != null
      ? { lat: userLocation.lat, lng: userLocation.lng, accuracy: accuracyMeters }
      : null,
    environment,
    hasTrip: destination !== null,
  });
  const [coldStartPickerVisible, setColdStartPickerVisible] = useState(false);
  // cold start 조건이 충족되고 2개 이상 후보가 나타나면 picker 자동 표시.
  // 이미 customOrigin이 설정됐거나 picker가 닫힌 후 재오픈하지 않도록 dismissedRef로 가드.
  const coldStartPickerDismissedRef = useRef(false);
  useEffect(() => {
    if (!coldStartCandidates) {
      // cold start 조건 해제 시 가드 리셋 (다음 cold start 에피소드를 위해)
      coldStartPickerDismissedRef.current = false;
      setColdStartPickerVisible(false);
      return;
    }
    if (coldStartPickerDismissedRef.current) return;
    if (customOrigin) return;
    if (destination !== null) return;
    // 2개 이상 후보가 있을 때만 picker 표시 (1개는 boardingPrompt 흐름, 0개는 표시 안 함)
    if (coldStartCandidates.length >= 2) {
      setColdStartPickerVisible(true);
    }
  }, [coldStartCandidates, customOrigin, destination]);

  const handleColdStartSelectCandidate = useCallback(
    (candidate: ColdStartCandidate) => {
      // 가장 가까운 entry의 stations[0]으로 setCustomOrigin 호출 → trip chain 시작.
      const firstStation = candidate.stations[0];
      if (firstStation) {
        setCustomOrigin(firstStation);
      }
      coldStartPickerDismissedRef.current = true;
      setColdStartPickerVisible(false);
    },
    [setCustomOrigin],
  );

  const handleColdStartSingleCandidate = useCallback(
    (candidate: ColdStartCandidate) => {
      // 1개 케이스: boardingPrompt 흐름과 동일하게 setCustomOrigin 적용.
      const firstStation = candidate.stations[0];
      if (firstStation) {
        setCustomOrigin(firstStation);
      }
      coldStartPickerDismissedRef.current = true;
      setColdStartPickerVisible(false);
    },
    [setCustomOrigin],
  );

  const handleColdStartSearchFallback = useCallback(() => {
    coldStartPickerDismissedRef.current = true;
    setColdStartPickerVisible(false);
    setOriginPickerVisible(true);
  }, []);

  const handleColdStartPickerClose = useCallback(() => {
    coldStartPickerDismissedRef.current = true;
    setColdStartPickerVisible(false);
  }, []);


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
  // R9-a (#1612) — AppState 'active' 복귀 시 widgetStorage module-level dedupe를 우회해
  // 위젯 currentStation을 강제 동기화. listener는 단일-바인딩이라 latest liveResult를 ref로 stamp.
  const liveResultRef = useRef(liveResult);
  liveResultRef.current = liveResult;
  // #1929 (F-W2) — AppState force 경로에서 tripContext stamp 위해 destination/route 최신값 ref.
  // useEffect [] 안에 위치한 listener는 destination/route를 직접 못 잡으므로 ref로 forward.
  const destinationRef = useRef(destination);
  destinationRef.current = destination;
  const routeRef = useRef(route);
  routeRef.current = route;
  // #1755 — lockless badge tap → scroll to boarding list. ScrollView ref + target Y.
  const scrollViewRef = useRef<ScrollView>(null);
  const boardingListYRef = useRef<number>(0);
  const handleLocklessBadgePress = useCallback(() => {
    scrollViewRef.current?.scrollTo({ y: boardingListYRef.current, animated: true });
  }, []);
  const isCustomOrigin = customOrigin !== null;
  // #1379: effectiveOrigin은 trip 생명선이다. GPS pause(BG 진입/지하 dead zone)로 result?.station이
  // 일시 null이 되면 아래 storage/effect들이 trip을 종료한 것으로 오인해 ROUTE_KEY removeItem →
  // useApnsTripRegistration이 backend ACTIVE_TRIP cleanup을 발사하는 cascade가 일어난다.
  // stale-while-revalidate 마지막 fused station + 활성 boardingLock의 boardingStation +
  // tripOrigin까지 4단 fallback해 trip 종료 신호와 GPS 일시 누락을 구분한다.
  const lastFusedStationRef = useRef<Station | null>(null);
  if (result?.station) lastFusedStationRef.current = result.station;
  const boardingLockStation = fusionBoardingLock
    ? getStationById(fusionBoardingLock.boardingStationId) ?? null
    : null;
  // #1723 — locationUncertain(GPS stale 5분+ 포함) 동안 lastFusedStationRef 우회.
  //   사용자 6/23 13:56 evidence: trip 종료 후 GPS lastFix 6분 전 → result=null 이지만
  //   lastFusedStationRef가 이전 trip 마지막 fused station(을지로3가) 보존 → stale stuck.
  //   stale 시 ref skip → boardingLockStation / tripOrigin fallback → 모두 null 시 "위치 확인 중" UX.
  const effectiveOrigin =
    customOrigin ??
    result?.station ??
    (locationUncertain ? null : lastFusedStationRef.current) ??
    boardingLockStation ??
    tripOrigin ??
    null;
  useTripOrigin(destination, effectiveOrigin, setTripOrigin, tripOrigin);
  const handleSameOriginToastDismiss = useCallback(() => setSameOriginToast(null), []);
  // #1324 — 목적지 선택 단일 진입점. 현재역(effectiveOrigin)과 같은 역이면 degenerate trip을
  // 만들지 않고 경고 toast만 노출한다. picker / 최근 목적지 tap 모두 이 핸들러를 거친다.
  // 반환값: 목적지를 실제로 설정했으면 true(picker가 닫아야 함), 차단했으면 false(picker 유지).
  const handleSelectDestination = useCallback(
    (station: Station): boolean => {
      if (isDegenerateDestination(effectiveOrigin, station)) {
        setSameOriginToast(t('destinationPicker.sameAsOrigin'));
        return false;
      }
      addRecentDestination(station);
      setDestination(station);
      return true;
    },
    [effectiveOrigin, t, addRecentDestination, setDestination],
  );
  // #797: 환승역에서 nearest.station.line이 trip 방향과 어긋나는 회귀 차단.
  // BoardingLock(사용자 선택) > Route(구조적 SSOT) > station.line fallback.
  const approachLine = getApproachLine(route, fusionBoardingLock, effectiveOrigin);
  // D7 (#1213) ETA provider SSOT — 현재역 BoardingTrainList(via boardingListArrivals)와
  // 정상 Arrival 표시(EditorialArrivalRow via ArrivalDirectionGroup)는 둘 다 아래 `arrival`을
  // 출처로 사용한다. 절대 시각 anchor도 arrivalAt(item)으로 통일(#897 Seam A). 따라서 두 surface의
  // ETA는 같은 시점에 항상 동일해야 한다. 회귀 게이트: etaProviderConsistency.test.ts.
  const { arrival: rawArrival, isMock: arrivalIsMock, loading: arrivalLoading, refetch: refetchArrival } = useArrivalInfo(
    effectiveOrigin?.name ?? null,
    approachLine,
  );
  const arrival = useArrivalCountdown(rawArrival);
  const isFav = effectiveOrigin ? favorites.some((f) => f.station.id === effectiveOrigin.id) : false;

  // #1029 pull-to-refresh: 사용자 트리거에만 spinner 표시 (background polling과 분리).
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setIsManualRefreshing(true);
    try {
      await refresh();
      refetchArrival();
    } finally {
      setIsManualRefreshing(false);
    }
  }, [refresh, refetchArrival]);

  // 환승역이면 모든 호선 변형에서 경로 계산 → 출발역 환승 없는 최적 경로 자동 선택
  const originVariants = !isCustomOrigin && variants.length > 1 ? variants : effectiveOrigin ? [effectiveOrigin] : [];
  const variantIds = originVariants.map((v) => v.id).join(',');

  // #1883 (RC-11) — 마지막으로 route를 계산한 trip session id (`${destinationId}|${routePreference}`).
  // trip session이 같으면 effectiveOrigin / variants 갱신으로 인한 mid-trip route mutation을 차단.
  // 사용자가 destination 또는 routePreference를 명시적으로 바꾸면 다른 session id가 되어 가드 통과.
  const lastComputedRouteSessionRef = useRef<string | null>(null);
  useEffect(() => {
    // #1379: destination 종료(=실제 trip 종료)일 때만 ROUTE_KEY removeItem.
    // effectiveOrigin null은 GPS 일시 누락일 수 있으므로 storage는 보존하고 계산만 skip한다.
    if (!destination) {
      setCategorized([]);
      lastComputedRouteSessionRef.current = null;
      AsyncStorage.removeItem(ROUTE_KEY).catch(() => {});
      return;
    }
    if (!effectiveOrigin) {
      return;
    }
    // #1883 (RC-11) — mid-trip route mutation 차단 (사용자 paradigm 2).
    // trip이 시작된 후(이 session id로 이미 1회 계산 완료) effectiveOrigin 변화 / variants
    // 갱신으로 route를 재계산하면 환승역이 바뀌어 "건대입구 → 군자" 같은 회귀가 발생한다.
    // session id(`destinationId|routePreference`)가 동일하면 route는 freeze — 사용자 명시
    // destination 또는 routePreference 변경 시에만 재계산. lockless / lock 활성 둘 다 동일 보호.
    const sessionKey = `${destination.id}|${routePreference}`;
    if (lastComputedRouteSessionRef.current === sessionKey) {
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
        lastComputedRouteSessionRef.current = sessionKey;
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
  // #784: rawArrival(useArrivalInfo)을 직접 사용 — useArrivalCountdown(1Hz tick)은 receivedAtMs를
  // 원본으로 유지하면서 arrivalSeconds만 차감해 60s 후 항상 stale로 판정되는 회귀 회피(옵션 B).
  // 분 단위 정수 ETA라 tick 미반영 영향 없음. arrivalsAtTransfers는 환승역별 폴링 인프라가 없어
  // undefined — leg당 DEFAULT_WAIT_MINUTES fallback 유지.
  const staticEtaMinutes = route
    ? calculateStaticETA(route, {
        currentLocation: userLocation ?? undefined,
        originStation: effectiveOrigin
          ? { lat: effectiveOrigin.lat, lng: effectiveOrigin.lng }
          : undefined,
        arrivalAtOrigin: pickArrivalAtOrigin(rawArrival),
      })
    : null;
  const isRealtimeEta = etaMinutes !== null && !arrivalIsMock && arrival !== null;
  const displayEta = isRealtimeEta ? etaMinutes : staticEtaMinutes;

  const nextStationName = useMemo(
    () => (effectiveOrigin && destination && route ? getNextStationName(effectiveOrigin.id, destination.id, route) : null),
    [effectiveOrigin?.id, destination?.id, route],
  );

  // #1112 — 현재역 시간대 평균 혼잡도. route 없으면 진행 방향 추론이 불가능하므로 direction=null로
  // useCongestion이 null 반환 → 배지 미노출 (graceful). #1097 PoC Mock provider 결과를 그대로 표시.
  const congestionDirection = useMemo(
    () => deriveCongestionDirection(approachLine, effectiveOrigin?.name, nextStationName),
    [approachLine, effectiveOrigin?.name, nextStationName],
  );
  const congestionEntry = useCongestion({
    stationName: effectiveOrigin?.name ?? null,
    line: approachLine,
    direction: congestionDirection,
  });

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
    motionStationary,
    // #917 A2 follow-up — FG fast path: 현재 폴링 중인 origin/nearest station arrival을 전달해
    // lock.trainCode arvlCd∈{0,1} 첫 관찰 시 매역 알림 즉시 발사. rawArrival(useArrivalCountdown
    // 미적용)을 직접 전달 — 매역 발사 트리거는 분 단위 tick과 무관한 arvlCd 원본 값.
    currentStationArrival: rawArrival,
    // #1208 (Epic #1204 D2) — station-passed hop window 게이트 입력.
    // D1 estimator(LocklessRouteHop 포함)의 현재 hop index와 arcStations를 그대로 전달.
    currentHopIndex,
    arcStations,
    // #1401 — 열차 진행 신호. fusion arc advance가 확인되면 evaluateMovement가 device 모션/GPS
    // speed 정적 가드를 우회 — 지하철 내부에서 device 신호 불신뢰성 보완(역삼 13:37 미발사 회귀).
    trainProgressing,
    // #1817 — 시간 적분 estimator 활성 시 fusion/GPS mismatch로 destination/transfer early 조기 발사 차단.
    estimatorIsTimeIntegration,
  });

  // #584 PR B — BoardingLock 진입점. UI 렌더링/lock 생성만 담당하며,
  // alarm/Fusion과의 wiring은 후속 PR C/D에서 활성화된다.
  const {
    lock: boardingLock,
    lockSuggestion,
    boardingListArrivals,
    createLockFromTrain,
    hydrateLockFromCandidate,
    releaseLock: releaseBoardingLock,
  } = useBoardingLockController({
    destinationId: destination?.id ?? null,
    destinationName: destination?.name ?? null,
    route,
    arrival,
    currentStation: result?.station ?? null,
    expectedDurationMinutes: staticEtaMinutes,
    motionStationary,
    speedMps,
  });
  // #1844 — cold start mismatch 재확인: lock 해제 → 사용자가 다시 탑승 선택 가능.
  const handleColdStartMismatchReselect = useCallback(() => {
    releaseBoardingLock?.();
  }, [releaseBoardingLock]);
  // #915 (C1 destination-only baseline UX) — destination 설정 직후 backend로 좋은 fix sync 발사.
  // backend cron이 9단 게이트 통과 시 autoLockCandidate 응답에 부착(#916) → 사용자 명시 탭 없이
  // boardingLock hydrate. lock 활성 여부와 무관하게 trip 활성 동안 폴링.
  // D4 (#1210) — 활성 lock의 trainCode + 노선을 동봉해 환승 leg 진입 시 backend가
  // 새 trainCode로 추적을 갱신하도록 한다 (consecutiveEtaMissing 자동 종료 차단).
  useBoardingLockSync({
    currentStationName: result?.station.name ?? null,
    accuracyMeters: accuracyMeters ?? null,
    tripActive: Boolean(destination && route),
    subsurface: barometerSubsurface,
    // #1286 — 지하 GPS dead zone에서 WiFi SSID로 확정된 역(confidence='wifi-ssid')은 accuracy>50m라도
    // backend로 sync. WiFi SSID가 GPS 정확도와 독립적으로 역을 확정하므로 ≤50m 게이트를 우회한다.
    stationFromWifi: confidence === 'wifi-ssid',
    boardingLockTrainCode: boardingLock?.trainCode ?? null,
    boardingLockLine: boardingLock?.boardingLine ?? null,
    onAutoLockCandidate: hydrateLockFromCandidate,
  });
  // #1280 — FG(WhileInUse) 위치 채널. BG task가 안 도는 WhileInUse 권한에서 FG fix-watch가
  // ~10s throttle로 좌표를 backend에 송신해 POST /position 0건 회귀를 메운다. useBoardingLockSync와
  // 동일하게 trip 활성 + 좋은 fix(≤50m) 게이트. fire-and-forget(URL 미설정/네트워크 실패 graceful).
  useFgPositionUpload({
    userLocation,
    accuracyMeters: accuracyMeters ?? null,
    tripActive: Boolean(destination && route),
    motionStationary,
    // #1363 — 사용자 추정 현재역 이름. backend 진단 log에서 trip waypoint와 명시 구분.
    currentStationName: result?.station.name ?? null,
  });
  useBoardingLockScheduler({
    lock: boardingLock,
    route,
    destinationName: destination?.name ?? null,
  });
  // #918 (A3 후속 wire) — boarding lock + route + destination이 모두 갖춰지면 OS local notification에
  // 사전 예약. 네트워크 0 환경에서 silent push가 못 가는 trip의 fallback alarm 경로. `bl:` prefix와
  // 분리된 `tba:` prefix를 사용해 lock-scheduler 큐와 충돌 없이 공존한다.
  useTripBoundAlarmScheduler({
    lock: boardingLock,
    route,
    destinationName: destination?.name ?? null,
    // #918 A3 PR3 — Fusion 현재역 통과 시 rolling window top-up trigger (64 cap 회피).
    currentStationName: result?.station.name ?? null,
  });
  useBoardingLockAdvancer({
    lock: boardingLock,
    route,
    destinationName: destination?.name ?? null,
    currentStationName: result?.station.name ?? null,
  });
  // #759 — 목적지역 도착 grace 후 lock 자동 release. 명시 "하차" 버튼은 그대로 유지하며,
  // 사용자가 누르지 않은 정상 도착 케이스만 처리. sleep mode와 무관.
  // #899 (Seam C) — route를 전달해 환승 leg waypoint 도달 시에도 자동 release.
  useBoardingLockAutoRelease({
    lock: boardingLock,
    destinationId: destination?.id ?? null,
    currentStation: result?.station ?? null,
    distanceKm: result?.distanceKm ?? null,
    releaseLock: releaseBoardingLock,
    route,
    // #1887 (RC-14) — transfer 분기에 motion stationary 30s 게이트 추가.
    // paradigm 4 "이동속도가 빠르지 않다면 판단 후에 자동 하차" 정확 적용.
    motionStationary,
  });
  // #925 (C2 wire) — destination 자동 하차 감지. arvlCd=0/1 + 역 50m 이내 + 60s motion stationary
  // 4-신호 AND 게이트 통과 시 setDestination(null) 호출 → 후속 LA end / trip-end recall은
  // useDestinationStore.setDestination(null)의 기존 cleanup 경로(triggerTripEndRecall, runTripBoundCleanups)에서 처리.
  // useBoardingLockAutoRelease(lock 라이프사이클, 300m/45s)와는 임계값/책임이 달라 독립적으로 동작.
  // 기존 arrival/useArrivalAutoClear(500m/2s, GPS 역명 매칭)와도 책임 분리:
  //   - arrival/useArrivalAutoClear: 도착 banner UX + 빠른 2초 후 자동 클리어 (낙관적 단순 정책).
  //   - 본 hook: motion=stationary + arvlCd 보강 → 사용자가 명시 "하차" 안 누른 케이스의 안전망.
  // #1058: 자동 하차 직후 6초간 toast + undo 액션. cleared 인자는 useDestinationAutoClear가
  // fire 시점 destination snapshot을 전달 — recentDestination이 아니라 "방금 해제된" station을
  // 그대로 복원할 수 있다 (사용자가 trip 도중 다른 picker 작업으로 recent를 덮어쓰는 회귀 차단).
  const [autoDisembarkToast, setAutoDisembarkToast] = useState<Station | null>(null);
  const handleAutoDisembark = useCallback(
    (cleared: Station) => {
      setDestination(null);
      setAutoDisembarkToast(cleared);
    },
    [setDestination],
  );
  const handleAutoDisembarkUndo = useCallback(() => {
    if (autoDisembarkToast) {
      setDestination(autoDisembarkToast);
    }
    setAutoDisembarkToast(null);
  }, [autoDisembarkToast, setDestination]);
  const handleAutoDisembarkDismiss = useCallback(() => setAutoDisembarkToast(null), []);
  // #1647 — boardingLock 활성 시 API-independent fallback 게이트 활성화.
  // Seoul Arrival API outage / 지하 dead zone에서 기존 arvlCd 게이트가 fire 0건이라
  // 좀비 trip(10.5h evidence) + V5/X8/X9 회귀 발생. 5min stationary + 100m + lock 활성
  // 3-of-3 합의로 device self-contained 자동 종료.
  useDestinationAutoClear({
    destination,
    userLocation,
    motionStationary,
    lockActive: Boolean(boardingLock),
    onAutoClear: handleAutoDisembark,
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
  // #1659: 같은 노선 다른 trainCode가 90s 지속 → lock 무효화 + 재선택 모달.
  // useMisBoardingDetector(absent)와 달리 trains 배열에 다른 trainCode가 있을 때만 감지 —
  // Seoul API stale(빈 배열) 오판 차단. lockLinePositions를 공유해 추가 폴링 비용 없음.
  const { detected: trainCodeMismatchDetected } = useTrainCodeMismatchDetector({
    lock: boardingLock,
    positions: lockLinePositions,
  });
  const prevTrainCodeMismatchRef = useRef(false);
  useEffect(() => {
    if (trainCodeMismatchDetected && !prevTrainCodeMismatchRef.current) {
      // lock 무효화 — breadcrumb에 reason='train-code-mismatch' stamp.
      void releaseLockWithReason('train-code-mismatch');
      // 사용자에게 재선택 UI 제시. 기존 MisBoardingReselectModal 재사용.
      setMisBoardingToastVisible(true);
      setMisBoardingModalVisible(true);
    }
    prevTrainCodeMismatchRef.current = trainCodeMismatchDetected;
  }, [trainCodeMismatchDetected, releaseLockWithReason]);
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
  // #924 D1 — route 미설정 환승 자동 detect. 환승역 walking + 다른 노선 임박 ArrivalRow 신호 결합.
  // useFusedNearestStation은 NearestStationResult(단수)만 노출 — 본 hook 입력 NearestStationsResult로 재조합.
  const nearestStationsForDetect = useMemo(() => {
    if (!result) return null;
    return {
      primary: result.station,
      variants,
      distanceKm: result.distanceKm,
      // primary가 환승역 candidate들 사이에 포함되어 있으면 환승역. variants가 비어 있어도 같은 이름
      // 다른 노선이 stations.json에 1개라도 더 있으면 isTransfer=true.
      isTransfer: variants.length > 1,
    };
  }, [result, variants]);
  const {
    modalVisible: transferDetectModalVisible,
    modalCandidates: transferDetectCandidates,
    selectLine: selectTransferDetectLine,
    dismissModal: dismissTransferDetectModal,
  } = useTransferAutoDetect({
    nearestStations: nearestStationsForDetect,
    motionStationary,
    arrival: rawArrival,
    boardingLock,
    route,
    destinationName: destination?.name ?? null,
    onAutoLock: hydrateLockFromCandidate,
  });
  const handleTransferDetectConfirm = useCallback(
    (station: Station) => {
      selectTransferDetectLine(station.line);
    },
    [selectTransferDetectLine],
  );
  useBackgroundLocation(destination);
  const permissionWatcher = useLocationPermissionWatcher();
  useLiveActivityDismissBridge();
  useApnsTripRegistration({
    route,
    destination,
    nextStationEtaSeconds:
      nextTrainMinutes != null && nextTrainMinutes !== Infinity ? nextTrainMinutes * 60 : null,
    currentStation: result?.station ?? null,
    boardingLock,
    subsurface: barometerSubsurface,
    // #1923 — 사용자 명시 의향 토글. backend가 lockless intermediate gate 진입에 사용 →
    // station-passed silent push 발사. 미stamp(false) trip은 기존 lockMissing skip 동작.
    infoModeEnabled,
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
    loadRecentDestinations();
    loadAlarmEvent();
    loadDismissSilence();
    // #1923 — cold start 시 사용자 명시 의향 토글 hydrate. 앱이 BG로 종료된 상태에서
    // 의향 표명 후 재시작했을 때 토글이 false로 stale되지 않도록 storage에서 복원.
    // trip 종료 시 runTripBoundCleanups가 storage를 정리하므로 cold start hydrate 결과는
    // 의향이 살아있는 trip만 true. graceful — 키 부재/parse 실패는 false 유지.
    void loadInfoModeEnabled();
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
        // R9-a (#1612) — 위젯 FG stale 차단. widgetStorage module-level dedupe(5분 freshness)로
        // useWidgetMirror가 같은 bucket/station이면 reload skip이라 BG에서 FG 복귀 시 위젯이
        // 잘못된 station에 stuck되는 회귀(2026-06-19 반포 stuck) 발생. force=true로 dedupe 우회.
        // liveResult는 raw GPS 최근접(sticky override 없음) — useWidgetMirror와 동일 SSoT.
        // #1929 (F-W2) — tripContext를 5th arg로 forward해 RC-15 widget expired-gate(SubwayWidget.swift:229) 활성화.
        const live = liveResultRef.current;
        if (live) {
          const tripContext = buildWidgetTripContext({
            destination: destinationRef.current,
            currentStation: live.station,
            route: routeRef.current,
          });
          void saveStationToWidget(live.station, live.distanceKm, Date.now(), { force: true }, tripContext).catch((e) =>
            logger.error('R9-a force-save 실패:', e),
          );
        }
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

  // #1094: 위젯은 destination/route 진행 여부와 무관하게 항상 nearest station을 미러링한다.
  // 50m bucket 단위로 dedupe되어 GPS tick 폭주를 흡수. LA/푸시 알림 lifecycle과 의도적으로 분리.
  //
  // #1568 (T8b, Epic ADR-017 #1553) — sticky 격리: fused result는 sticky:locked override가 들어가
  // 위젯에 stuck되는 회귀("반포 stuck") 회피하려고 raw GPS 최근접(liveResult)을 전달한다.
  // 위젯은 boardingLock·trip context와 무관한 ambient display 채널이라 sticky override 의무 없음.
  //
  // #1929 (F-W1) — trip 활성 시 tripContext를 forward해 SubwayWidget.swift:229 RC-15 expired-gate 진입.
  // trip 비활성(destination/currentStation null)이면 helper가 undefined 반환 → 기존 nearest UI 유지.
  const widgetTripContext = useMemo(
    () =>
      buildWidgetTripContext({
        destination,
        currentStation: liveResult?.station ?? null,
        route,
      }),
    [destination, liveResult?.station, route],
  );
  useWidgetMirror(liveResult?.station ?? null, liveResult?.distanceKm ?? null, widgetTripContext);

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
    // MapScreen과 동일한 단일 UI(LocationStateView)로 통일. iOS 영구 거부 시 OS dialog가
    // 뜨지 않아 "다시 시도"가 dead end가 되는 문제를 해결한다 (#1061).
    return (
      <LocationStateView permissionDenied={true} loading={false} error={null} onRetry={refresh} />
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
          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.accent }]}
            onPress={refresh}
            testID="home-refresh-button"
          >
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
        message={t('home.misBoardingToast')}
        onDismiss={handleMisBoardingToastDismiss}
        accent={colors.warn}
        testID="mis-boarding-toast"
      />
      <Toast
        visible={autoDisembarkToast !== null}
        message={t('home.autoDisembarkToast.message', { name: autoDisembarkToast?.name ?? '' })}
        actionLabel={t('home.autoDisembarkToast.undo')}
        onAction={handleAutoDisembarkUndo}
        onDismiss={handleAutoDisembarkDismiss}
        durationMs={6000}
        testID="auto-disembark-toast"
      />
      {/* line이 정해져야 list를 렌더 가능 — line null이면 모달 자체를 띄우지 않음 (빈 sheet 회피). */}
      <MisBoardingReselectModal
        visible={misBoardingModalVisible && effectiveOrigin?.line != null}
        arrivals={boardingListArrivals}
        line={effectiveOrigin?.line ?? null}
        onSelect={handleMisBoardingReselect}
        onClose={handleMisBoardingModalClose}
        nextStationLabel={nextStationName}
      />
      {/* #924 D1 — 환승 자동 detect 다중 후보 모달. F4 1탭 모달 인프라(#914) 재사용. */}
      <CurrentStationConfirmModal
        visible={transferDetectModalVisible}
        candidates={transferDetectCandidates}
        topPick={transferDetectCandidates[0] ?? null}
        onConfirm={handleTransferDetectConfirm}
        onSearchFallback={dismissTransferDetectModal}
        onClose={dismissTransferDetectModal}
      />

      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={{ paddingBottom: 80 }}
        refreshControl={<RefreshControl refreshing={isManualRefreshing} onRefresh={handleRefresh} />}
      >
        {effectiveOrigin ? (
          <>
            {/* #1066 follow-up — 운행 시간 외 안내 배너. 배너 자체가 in-service/unknown 분기에서
                 null을 반환해 운행 중엔 자동 숨김. 외곽 padding은 배너가 직접 소유한다 — 여기에
                 wrapper로 padding을 두면 운행 중에도 phantom 여백이 남아 하단 레이아웃을
                 밀어내고 E2E scrollUntilVisible 회귀를 일으킨다(#1083). */}
            <ServiceWindowBanner stationName={effectiveOrigin.name} line={effectiveOrigin.line} />
            <PermissionChangeBanner
              change={permissionWatcher.change}
              onAcknowledge={permissionWatcher.acknowledge}
            />
            {/* Hero: origin station */}
            <View style={{ paddingHorizontal: spacing.xxl, paddingTop: spacing.xxxl - 4 }}>
              <Text
                style={[typography.label, { color: colors.muted, marginBottom: 10 }]}
                testID="home-origin-label"
              >
                {isCustomOrigin
                  ? t('home.originManual')
                  : source !== 'gps'
                  ? t('home.originEstimated')
                  : result && result.distanceKm <= 0.5
                  ? t('home.originCurrent')
                  : t('home.originNearest')}
              </Text>
              <View style={styles.heroRow}>
                <Text
                  style={[typography.hero, { color: colors.ink, flex: 1, fontWeight: '900' }]}
                  testID="home-origin-station-name"
                >
                  {getStationDisplayName(effectiveOrigin)}
                </Text>
                <TouchableOpacity
                  onPress={() =>
                    isFav
                      ? removeFavorite(effectiveOrigin.id)
                      : addFavorite(effectiveOrigin)
                  }
                  accessibilityRole="button"
                  accessibilityLabel={isFav ? t('home.favRemove') : t('home.favAdd')}
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
                {congestionEntry && (
                  <CongestionBadge entry={congestionEntry} testID="home-congestion-badge" />
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

            {/* #1755 — lockless badge: trip 활성 + lock 미부착 상태를 사용자에게 알림. 탭하면 boarding list로 스크롤. */}
            {destination && !boardingLock && (
              <View style={{ paddingHorizontal: spacing.xxl, paddingBottom: spacing.md }}>
                <LocklessBadge onPress={handleLocklessBadgePress} />
              </View>
            )}

            {/* #1844 (Phase 6.1 Sub-step 5) — cold start mismatch 재확인 배너.
                 lock 활성 + mismatch 감지 시 노출. 탑승역 재선택 → lock 해제. */}
            {boardingLock && coldStartMismatch.detected && (
              <View style={{ paddingHorizontal: spacing.xxl, paddingBottom: spacing.md }}>
                <ActionBanner
                  accent={colors.warn}
                  actionLabel={t('home.coldStartMismatch.reselect', { defaultValue: '재선택' })}
                  onActionPress={handleColdStartMismatchReselect}
                  testID="cold-start-mismatch-banner"
                  actionTestID="cold-start-mismatch-banner-action"
                  accessibilityLabel={t('home.coldStartMismatch.message', { defaultValue: '탑승역이 현재 위치와 다릅니다. 다시 선택해 주세요.' })}
                >
                  <Text style={[typography.bodySm, { color: colors.ink, fontWeight: '600' }]}>
                    {t('home.coldStartMismatch.title', { defaultValue: '탑승역 확인' })}
                  </Text>
                  <Text style={[typography.caption, { color: colors.muted }]}>
                    {t('home.coldStartMismatch.message', { defaultValue: '탑승역이 현재 위치와 다릅니다. 다시 선택해 주세요.' })}
                  </Text>
                </ActionBanner>
              </View>
            )}

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
                      <Text style={[typography.countMM, { fontWeight: '900', color: colors.ink }]}>{getStationDisplayName(destination)}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      {displayEta != null && (
                        <>
                          <Text style={[typography.countMM, { color: colors.ink }]}>
                            {displayEta}
                            <Text style={[typography.caption, { color: colors.muted }]}> min</Text>
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
                    const selectedCandidate = categorized.find((r) => r.category.key === selectedKey)?.candidate;
                    return (
                      <>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
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
                          {/* PR #1069 follow-up — 경로 시스템 텍스트 공유. route/currentStation/destination 누락 시 자동 숨김. */}
                          <ShareTripButton
                            route={route}
                            currentStation={result?.station ?? null}
                            destination={destination}
                            totalStops={journey.totalStops}
                            travelMinutes={selectedCandidate?.travelMinutes ?? 0}
                          />
                        </View>
                        <EditorialTimeline
                          stops={stops}
                          renderHopSlot={(stop, i) => {
                            // #758 — origin hop slot에 BoardingLock 활성 상태 카드 렌더.
                            // BoardingLockBanner 별도 카드는 제거되고 timeline 안 hop으로 통합.
                            if (i === 0 && stop.mark === 'filled' && boardingLock) {
                              // #897 Seam A: lock.trainCode 매칭 train의 잔여 ETA → 지연 칩 계산 input.
                              // 매칭 없으면 undefined → 칩 미노출 (graceful).
                              // #1326: 표시 전용 lookup이라 boardingListArrivals 사용(Gate 1 무관). 방향 폴백
                              //   list에서 탭한 lock도 매칭돼 지연 칩이 살아난다(strict면 폴백 시 영구 미노출).
                              const matchedTrain = boardingListArrivals.find(
                                (t) => t.trainCode === boardingLock.trainCode,
                              );
                              return (
                                <BoardingLockHopCard
                                  lock={boardingLock}
                                  onRelease={releaseBoardingLock}
                                  currentEtaSeconds={matchedTrain?.arrivalSeconds}
                                />
                              );
                            }
                            // #649 — origin hop slot: 현재역에서 다음 인접역 방면 boarding list.
                            // #758 — 탑승역 GPS 근접 게이트(BOARDING_PROXIMITY_THRESHOLD_M). custom origin은
                            //  사용자 명시 설정이라 게이트 면제. 게이트 미통과 시 list 비노출 + 안내 텍스트.
                            if (i === 0 && stop.mark === 'filled' && !boardingLock && effectiveOrigin) {
                              const distanceToCurrentM = (result?.distanceKm ?? Infinity) * 1000;
                              const nearBoardingStation =
                                isCustomOrigin || distanceToCurrentM < BOARDING_PROXIMITY_THRESHOLD_M;
                              if (!nearBoardingStation) {
                                // #1534 (S1, T9b, ADR-016) — GAP A 시나리오: backend가 lockSuggestion을
                                // 추론 중이거나 추론 완료. 사용자에게 "추론 중" feedback 노출해 사용자 대기
                                // 0초 UX 유지. lockSuggestion이 도착하면 useBoardingLockController가
                                // 자동으로 lock을 createLock해 다음 cycle에 BoardingLockHopCard로 전이된다.
                                if (lockSuggestion) {
                                  return (
                                    <View
                                      style={styles.boardingProximityHint}
                                      testID="origin-resolving-hint"
                                    >
                                      <Text style={[typography.bodySm, { color: colors.muted }]}>
                                        {t('home.originResolving')}
                                      </Text>
                                    </View>
                                  );
                                }
                                return (
                                  <View
                                    style={styles.boardingProximityHint}
                                    testID="boarding-proximity-hint"
                                  >
                                    <Text style={[typography.bodySm, { color: colors.muted }]}>
                                      {t('home.boardingProximityHint')}
                                    </Text>
                                  </View>
                                );
                              }
                              const towardName = findNextWaypointName(stops, i);
                              const label = towardName
                                ? resolveNextAdjacentStationName(
                                    effectiveOrigin.line,
                                    effectiveOrigin.name,
                                    towardName,
                                  )
                                : null;
                              // #897 Seam A: 이 분기는 `!boardingLock` 가드 안 — lock이 없으므로 지연 칩 비교 기준이 없다.
                              // 사용자가 BoardingTrainList에서 열차를 탭해야 lock이 생성되고, 이후 폴링에서 칩이 활성화된다.
                              return (
                                // #1755 — lockless badge 탭 시 scrollTo 기준점. onLayout에서 y를 캡처.
                                <View
                                  onLayout={(e) => { boardingListYRef.current = e.nativeEvent.layout.y; }}
                                  testID="boarding-list-anchor"
                                >
                                  <BoardingTrainList
                                    arrivals={boardingListArrivals}
                                    // #797: approachLine 우선 — 환승역에서 effectiveOrigin.line이 trip 방향과
                                    // 어긋날 때 BoardingLock·route SSOT로 정확한 호선 표시.
                                    line={approachLine ?? effectiveOrigin.line}
                                    onSelect={createLockFromTrain}
                                    compact
                                    nextStationLabel={label}
                                    // #1166: 낙관적 탭 → backend 정정 UX. lockedTrainCode를 prop으로 넘겨야
                                    // pending 일치/정정 effect가 발화한다. fusionBoardingLock 기반 SSOT 사용.
                                    lockedTrainCode={lockedTrainCode}
                                    onLockCorrected={handleLockCorrected}
                                  />
                                </View>
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
                              // #897 Seam A: 환승 list는 다음 leg 선택용 — 새 leg의 lock은 아직 없다.
                              // 현재 lock은 이전 leg(곧 종료)라 ETA 비교 baseline으로 부적합. 칩 미노출.
                              return (
                                <BoardingTrainList
                                  arrivals={transferArrivals}
                                  line={transferContext.nextLine}
                                  onSelect={createTransferLock}
                                  walkingBufferSeconds={
                                    // ADR-015 §6 — 호선쌍별 환승 도보 시간(#1435).
                                    // lock.boardingLine = 환승 직전 leg의 노선 (fromLine).
                                    // useTransferTrainList가 lock 활성 시에만 context를 노출하므로
                                    // 정상 흐름에서는 lock이 항상 존재한다. ts narrowing이 불가능하므로
                                    // optional chaining + `getTransferSeconds`의 fallback(=180s)에 위임한다.
                                    boardingLock
                                      ? getTransferSeconds(
                                          boardingLock.boardingLine,
                                          transferContext.nextLine,
                                          transferContext.transferStationInToLine.name,
                                        )
                                      : TRANSFER_WALKING_BUFFER_SECONDS
                                  }
                                  compact
                                  nextStationLabel={label}
                                  // #1166: 환승 leg lock도 같은 SSOT(fusionBoardingLock). 환승 row에서도
                                  // round-trip 정정 시 동일 toast UX 적용.
                                  lockedTrainCode={lockedTrainCode}
                                  onLockCorrected={handleLockCorrected}
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
                  {/* #625 — MisBoarding 배너는 route 컨텍스트 안에서 노출.
                       외곽 {destination && ...} 가드 안쪽이라 destination 재가드 불필요.
                       #758: BoardingLockBanner는 hop slot 안 BoardingLockHopCard로 통합 이전 — 별도 노출 제거. */}
                  {boardingLock && misBoardingDetected && (
                    <MisBoardingBanner onReselect={releaseBoardingLock} />
                  )}
                  {/* #649 — BoardingTrainList 두 인스턴스(현재역/환승)는 EditorialTimeline의
                       renderHopSlot으로 이동: timeline hop 사이에 inline compact 표기.
                       #758 — BoardingLockHopCard도 같은 origin hop slot으로 통합. */}
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
                    accessibilityLabel={t('home.sleepModeLabel')}
                  />
                </View>

                <Hr />
              </>
            )}

            {/* No destination: picker + recent */}
            {!destination && (
              <View style={{ paddingHorizontal: spacing.xxl, paddingVertical: spacing.xxl }}>
                {recentDestinations.length > 0 && (
                  <View testID="recent-destinations-list">
                    <Text style={[styles.recentDestinationLabel, { color: colors.accent, paddingHorizontal: spacing.lg }]}>
                      {t('home.previousDestination')}
                    </Text>
                    {recentDestinations.map((recent) => (
                      <View
                        key={recent.id}
                        style={[styles.recentDestinationButton, styles.recentDestinationItemRow, { borderColor: colors.accent }]}
                      >
                        <TouchableOpacity
                          style={styles.recentDestinationTapArea}
                          onPress={() => handleSelectDestination(recent)}
                          testID={`recent-destination-button-${recent.id}`}
                        >
                          <View style={styles.recentDestinationRow}>
                            <Text style={[styles.recentDestinationName, { color: colors.ink }]}>{getStationDisplayName(recent)}</Text>
                            <View style={[styles.recentLineBadge, { backgroundColor: recent.lineColor }]}>
                              <Text style={styles.recentLineText}>{LINE_NAMES[recent.line]}</Text>
                            </View>
                          </View>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.recentDestinationDelete}
                          onPress={() => removeRecentDestination(recent.id)}
                          accessibilityLabel={t('common.remove')}
                          testID={`recent-destination-delete-${recent.id}`}
                        >
                          <Text style={[styles.recentDestinationDeleteText, { color: colors.muted }]}>✕</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
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
              <View
                style={[styles.arrivalSection, { backgroundColor: colors.card }]}
                testID="home-arrival-section"
              >
                <Text
                  style={[styles.sectionTitle, { color: colors.muted }]}
                  testID="home-arrival-section-title"
                >
                  {t('home.arrivalInfoTitle')}
                </Text>
                {arrivalLoading && !arrival && (
                  <Text style={[styles.arrivalItem, { color: colors.ink }]}>{t('home.loading')}</Text>
                )}
                <ArrivalSourceNotice arrival={arrival} />
                {arrival && arrival.source !== 'closed' && (
                  <>
                    <ArrivalDirectionGroup
                      label={t('arrival.upbound')}
                      items={arrival.up}
                      stationName={effectiveOrigin.name}
                      line={effectiveOrigin.line}
                      directionKey="up"
                    />
                    <ArrivalDirectionGroup
                      label={t('arrival.downbound')}
                      items={arrival.down}
                      stationName={effectiveOrigin.name}
                      line={effectiveOrigin.line}
                      directionKey="down"
                    />
                  </>
                )}
              </View>
            )}
          </>
        ) : locationUncertain ? (
          <View style={styles.center} testID="location-uncertain">
            <Text style={styles.icon} allowFontScaling={false}>📍</Text>
            <Text style={[styles.title, { color: colors.ink }]}>{t('home.locationUncertainTitle')}</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>{t('home.locationUncertainDescription')}</Text>
            <TouchableOpacity
              style={[styles.button, { backgroundColor: colors.accent }]}
              onPress={refresh}
              testID="home-refresh-button"
            >
              <Text style={[styles.buttonText, { color: colors.onAccent }]}>{t('home.refresh')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.center} testID="home-not-near-station">
            <Text style={styles.icon} allowFontScaling={false}>🚶</Text>
            <Text
              style={[styles.title, { color: colors.ink }]}
              testID="home-not-near-station-title"
            >
              {t('home.notNearStationTitle')}
            </Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>{t('home.notNearStationDescription')}</Text>
            <TouchableOpacity
              style={[styles.button, { backgroundColor: colors.accent }]}
              onPress={refresh}
              testID="home-refresh-button"
            >
              <Text style={[styles.buttonText, { color: colors.onAccent }]}>{t('home.refresh')}</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {alarmEvent && (
        // #806: dismiss는 알람 UI/진동만 끄고 trip(BoardingLock)은 유지.
        // 한 정거장 전(early) destination 알람을 끄면 trip이 종료되던 회귀의 fix.
        // trip release는 도착 자동 release(useBoardingLockAutoRelease, #759)에 위임한다.
        // #746: dismiss와 동시에 silence 시작점 기록. userLocation 미가용 시 시간 단독 silence.
        <AlarmOverlay
          event={alarmEvent}
          onDismiss={() => {
            setDismissSilence(
              Date.now(),
              userLocation ? { lat: userLocation.lat, lng: userLocation.lng } : null,
            ).catch(() => {});
            clearAlarmEvent();
          }}
        />
      )}

      {/* #1842 Phase 6.1 Sub-step 4 — cold start 다중 후보 선택 UI. */}
      <ColdStartCandidatePicker
        visible={coldStartPickerVisible}
        candidates={coldStartCandidates ?? []}
        onSelectCandidate={handleColdStartSelectCandidate}
        onSingleCandidate={handleColdStartSingleCandidate}
        onSearchFallback={handleColdStartSearchFallback}
        onClose={handleColdStartPickerClose}
      />

      {/* #914 (F4) — 1탭 현재역 확정. wifi 단일 매칭은 자동 확정 + toast 노출,
           GPS 다중 후보는 모달 1탭 확정, 후보 0개는 검색 fallback 안내(#977 wire). */}
      <CurrentStationConfirmModal
        visible={confirmModal.visible}
        candidates={confirmModal.candidates}
        topPick={confirmModal.topPick}
        onConfirm={confirmModal.onCardTap}
        onSearchFallback={handleSearchFallback}
        onClose={confirmModal.onClose}
      />
      {/* #977 — F4 검색 fallback origin picker. DestinationPicker mode='origin' 재사용.
           onAssignSlot 미전달 → 즐겨찾기 슬롯 placeholder는 자동 숨김(origin 컨텍스트 무관). */}
      <DestinationPicker
        visible={originPickerVisible}
        mode="origin"
        onSelect={handleOriginPickerSelect}
        onClose={handleOriginPickerClose}
        favorites={favorites}
        userLat={userLocation?.lat ?? null}
        userLng={userLocation?.lng ?? null}
        onRecenter={() => {
          void refreshRef.current();
        }}
      />
      <Toast
        visible={confirmAutoToast !== null}
        message={confirmAutoToast ?? ''}
        onDismiss={handleConfirmAutoToastDismiss}
        testID="current-station-auto-confirm-toast"
      />
      {/* #1166 — backend round-trip 정정 toast. 5초 자동 dismiss + tap 닫기. */}
      <Toast
        visible={lockCorrectionToast !== null}
        message={lockCorrectionToast ?? ''}
        onDismiss={handleLockCorrectionToastDismiss}
        testID="lock-correction-toast"
      />
      {/* #1324 — 목적지 == 현재역 차단 경고. 5초 자동 dismiss + tap 닫기. */}
      <Toast
        visible={sameOriginToast !== null}
        message={sameOriginToast ?? ''}
        onDismiss={handleSameOriginToastDismiss}
        testID="same-origin-toast"
      />

      <DestinationPicker
        visible={pickerVisible}
        onSelect={(station) => {
          if (handleSelectDestination(station)) setPickerVisible(false);
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

/**
 * #1074 — 도착 섹션 한 방향(상행/하행) 그룹.
 * arrival.up/down(ArrivalInfo[]) → arrivalInfoToArrivalTrain으로 변환해 EditorialArrivalRow로 렌더.
 * stationName/line/directionKey 컨텍스트를 패스스루해 ArrivalStatusBadge가 막차 HH:mm을 lookup한다(#1035/#1043).
 */
function ArrivalDirectionGroup({
  label,
  items,
  stationName,
  line,
  directionKey,
}: {
  label: string;
  items: ArrivalInfo[];
  stationName: string;
  line: LineNumber;
  directionKey: 'up' | 'down';
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const trains = useMemo(
    () => arrivalInfoToArrivalTrain(items, label, line, { stationName, directionKey }),
    [items, label, line, stationName, directionKey],
  );
  return (
    <View
      style={[styles.arrivalGroup, { borderTopColor: colors.hair }]}
      testID={`arrival-direction-${directionKey}`}
    >
      <Text
        style={[styles.arrivalLabel, { color: colors.muted }]}
        testID={`arrival-direction-label-${directionKey}`}
      >
        {label}
      </Text>
      {trains.length === 0 ? (
        <Text style={[styles.arrivalItem, { color: colors.ink }]}>{t('home.noArrivalInfo')}</Text>
      ) : (
        trains.map((train, idx) => (
          <EditorialArrivalRow key={`${train.line}-${idx}`} train={train} />
        ))
      )}
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
    ...typography.bodyLg,
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
    ...typography.title,
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
    ...typography.caption,
    fontWeight: '600',
  },
  routePillSub: {
    ...typography.micro,
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
  boardingProximityHint: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
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
  recentDestinationItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  recentDestinationTapArea: {
    flex: 1,
  },
  recentDestinationDelete: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginLeft: spacing.sm,
  },
  recentDestinationDeleteText: {
    ...typography.bodyMd,
    fontWeight: '700',
  },
  recentDestinationLabel: {
    ...typography.micro,
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
    ...typography.bodyMd,
    fontWeight: '700',
  },
  recentLineBadge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  recentLineText: {
    color: '#fff', // 노선색(lineColor) 배경 위 텍스트 — 항상 흰색 유지
    ...typography.micro,
    fontWeight: 'bold',
  },
  destinationButton: {
    borderRadius: radius.md,
    paddingVertical: 10,
    alignItems: 'center',
  },
  destinationButtonText: {
    ...typography.bodyBase,
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
    ...typography.bodySm,
    marginBottom: spacing.lg,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  arrivalGroup: {
    paddingTop: 10,
    borderTopWidth: 1,
    marginTop: spacing.sm,
  },
  arrivalLabel: {
    ...typography.bodyBase,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  arrivalItem: {
    ...typography.bodyBase,
  },
  icon: {
    fontSize: 48, // emoji icon — allowFontScaling={false} applied at render
    marginBottom: 16,
  },
  title: {
    ...typography.titleSm,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    ...typography.bodyBase,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  loadingText: {
    ...typography.bodyMd,
  },
  errorText: {
    ...typography.bodyMd,
    marginBottom: 16,
  },
  button: {
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: radius.lg,
  },
  buttonText: {
    ...typography.bodyBase,
    fontWeight: '700',
  },
});
