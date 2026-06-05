import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NearestStationResult, Station } from '../../../shared/types/station';
import { BG_LAST_STATION_KEY } from '../../../shared/constants/storageKeys';
import { findNearestStations } from '../utils/findNearestStation';
import {
  isAccuracyAcceptable,
  isAccuracyAcceptableForDisplay,
  isLocationFresh,
  isPlausibleJump,
  type FixSample,
} from '../utils/locationGates';
import {
  MAX_ACCURACY_M,
  MAX_ACCURACY_M_DISPLAY,
  MAX_STATION_DISTANCE_KM,
  isValidGpsSpeedMps,
} from '../../../shared/constants/location';
import { E2E_MOCK_LOCATION, IS_E2E_MOCK } from '../../../shared/constants/e2e';
import {
  appStateToGpsActive,
  currentGpsActive,
  type GpsActiveState,
} from '../../../shared/constants/gpsStatus';
import { createLogger } from '../../../utils/logger';
import { pushFusionDebugEntry } from '../utils/fusionDebugBuffer';
import { haversine } from '../../../utils/haversine';
import { useStickyStation } from './useStickyStation';

/** #876 — useNearestStation 표시값의 출처. sticky lock된 역이면 'sticky', 아니면 GPS live.
 *  알람 트리거에는 영향 없음 — 호출자가 출처별 UX(예: "탑승 전 추정")를 분기할 수 있게 노출. */
export type NearestStationSource = 'sticky' | 'live';

const logger = createLogger('useNearestStation');

const MIN_DISTANCE_CHANGE_KM = 0.003; // 3m — UI 갱신을 자주 흘려보낸다.

// userLocation/result는 표시용 완화 게이트(MAX_ACCURACY_M_DISPLAY=1500m)를 통과한 좌표로 갱신된다.
// 알람 발화 경로에서 이 값을 ETA/거리 계산에 사용할 경우 반드시 accuracyMeters와 함께 묶어
// 알람 엄격 게이트(isAccuracyAcceptable, MAX_ACCURACY_M=200m)를 먼저 통과시켜야 한다.
// 예: useStationAlarm는 effect 진입부에서 isAccuracyAcceptable(accuracyMeters) early return으로
// 이 계약을 강제한다.
interface UseNearestStationReturn {
  result: NearestStationResult | null;
  variants: Station[];
  userLocation: { lat: number; lng: number } | null;
  speedMps: number | null;
  accuracyMeters: number | null;
  loading: boolean;
  error: string | null;
  permissionDenied: boolean;
  // true: 직전 좌표가 표시 게이트(MAX_ACCURACY_M_DISPLAY)에 의해 drop되어 result가
  // 마지막 신뢰 fix로 정지된 상태. 호출자는 "위치 확인 중" 상태로 표시한다.
  locationUncertain: boolean;
  // #852: GPS watch 구독 활성 여부. AppState 'active' 동안만 'fg', 그 외(BG/inactive)는 'bg'.
  // silent push wake 시에도 'bg' — 사용자가 디버그 모달에서 "왜 안 바뀌지" 확인 가능.
  gpsActive: GpsActiveState;
  // #852: 마지막 신뢰 fix epoch ms. BG 진입 후 새 fix가 없으면 이 시각은 정지.
  // null = 한 번도 fix 없음(cold start). 디버그 모달 표기용.
  lastFixAtMs: number | null;
  // #876: result 출처. sticky lock된 역이면 'sticky', live GPS 최근접이면 'live'.
  // 호출자가 출처별 UX(예: 라벨 "탑승 전 추정")로 분기 가능. 알람 트리거에는 영향 없음.
  source: NearestStationSource;
  refresh: () => Promise<void>;
}

// #711: BG task가 최근 평가한 nearest station. FG 복귀 직후 fresh fix 도착 전 임시 hydrate에 사용.
// WhileInUse 사용자는 BG task 미동작 → key 없음(null) → graceful no-op.
async function readBgLastStation(): Promise<NearestStationResult | null> {
  try {
    const raw = await AsyncStorage.getItem(BG_LAST_STATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { distanceKm?: unknown }).distanceKm === 'number' &&
      (parsed as { station?: unknown }).station &&
      typeof ((parsed as { station: { id?: unknown } }).station.id) === 'string'
    ) {
      const { station, distanceKm } = parsed as { station: Station; distanceKm: number };
      return { station, distanceKm };
    }
    return null;
  } catch {
    return null;
  }
}

function applyNearestResult(
  stationsResult: ReturnType<typeof findNearestStations>,
  setResult: (r: NearestStationResult | null) => void,
  setVariants: (v: Station[]) => void,
): void {
  if (stationsResult) {
    setResult({ station: stationsResult.primary, distanceKm: stationsResult.distanceKm });
    setVariants(stationsResult.variants);
  } else {
    setResult(null);
    setVariants([]);
  }
}

export function useNearestStation(): UseNearestStationReturn {
  const [result, setResult] = useState<NearestStationResult | null>(null);
  const [variants, setVariants] = useState<Station[]>([]);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [speedMps, setSpeedMps] = useState<number | null>(null);
  const [accuracyMeters, setAccuracyMeters] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [locationUncertain, setLocationUncertain] = useState(false);
  // #852: AppState 초기값 기준 — RN의 초기 currentState는 보통 'active'지만
  // 모듈 마운트 타이밍에 따라 'unknown'/'background'일 수 있어 wrapper로 통일.
  const [gpsActive, setGpsActive] = useState<GpsActiveState>(() => currentGpsActive());
  const [lastFixAtMs, setLastFixAtMs] = useState<number | null>(null);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const lastStationIdRef = useRef<string | null>(null);
  const lastDistanceRef = useRef<number>(0);
  // 진단용 누적 카운터: lastKnown 캐시 fix가 freshness/accuracy 게이트에서 거부된 횟수.
  // BG→FG 전환마다 startWatch가 호출되므로 stale 위치 의심 시 운영 로그로 추적한다.
  const lastKnownStaleCountRef = useRef<number>(0);
  const lastKnownLowAccuracyCountRef = useRef<number>(0);
  // #527: jump gate가 참조하는 직전 수용 fix. accuracy 게이트는 fix 단위 절대값만 보고
  // 이전 좌표와의 시공간 일관성은 확인하지 못한다 — 21:29 효창공원앞↔신내 25km/8s
  // 텔레포트 사고를 차단하기 위해 useRef로 prev를 들고 비교한다.
  const lastFixRef = useRef<FixSample | null>(null);

  const applyLocation = useCallback((coords: Location.LocationObjectCoords, timestamp: number) => {
    const { latitude, longitude, speed, accuracy } = coords;
    const fix: FixSample = { lat: latitude, lng: longitude, timestamp };
    if (!isPlausibleJump(lastFixRef.current, fix)) {
      setLocationUncertain(true);
      return;
    }
    lastFixRef.current = fix;
    // jump/accuracy 게이트 모두 통과한 신뢰 fix — uncertain 상태에서 자동 복귀시킨다.
    // (호출자 측 setLocationUncertain(false)에 의존하면 jump drop 직후 정상 fix가 들어와도
    //  복귀 호출 경로가 없어 uncertain이 고착되는 결함 발생 — P1 회피.)
    setLocationUncertain(false);
    // #852: 신뢰 fix가 채택된 시점을 기록 — 디버그 모달 GPS 섹션에서 stale window 시각화.
    // jump/accuracy drop된 fix는 채택 안 함(stale 시각이 그대로 유지) — 사용자가 stale 구간 식별 가능.
    setLastFixAtMs(timestamp);
    const stationsResult = findNearestStations(latitude, longitude, MAX_STATION_DISTANCE_KM);

    const newId = stationsResult?.primary.id ?? null;
    const newDistance = stationsResult?.distanceKm ?? 0;
    const stationChanged = newId !== lastStationIdRef.current;
    const distanceDelta = Math.abs(newDistance - lastDistanceRef.current);
    const noStation = !stationsResult && lastStationIdRef.current !== null;

    // raw 신호는 매 fix 즉시 갱신. useFusedNearestStation의 candidates 메모가
    // userLocation 변화에 의존하므로 throttle 안에 두면 천천히 이동할 때 후보가 잠긴다.
    setSpeedMps(isValidGpsSpeedMps(speed) ? speed : null);
    setAccuracyMeters(accuracy ?? null);
    setUserLocation({ lat: latitude, lng: longitude });

    // 표시값(result/variants)은 3m throttle 유지 — 잦은 리렌더 방지.
    if (stationChanged || distanceDelta > MIN_DISTANCE_CHANGE_KM || noStation) {
      lastStationIdRef.current = newId;
      lastDistanceRef.current = newDistance;
      applyNearestResult(stationsResult, setResult, setVariants);
    }
    // 측정(#443): station 변화 시에만 push. 매 fix는 너무 자주 — 점프 시퀀스
    // (사가정→을지로4가→용마산) 재구성엔 station 단위면 충분.
    if (stationChanged || noStation) {
      pushFusionDebugEntry({
        kind: 'gps',
        event: 'gps-fix',
        ts: Date.now(),
        lat: latitude,
        lng: longitude,
        accuracyMeters: accuracy ?? null,
        speedMps: isValidGpsSpeedMps(speed) ? speed : null,
        nearestStation: stationsResult?.primary.name ?? null,
        nearestLine: stationsResult?.primary.line ?? null,
        nearestDistanceKm: stationsResult?.distanceKm ?? null,
      });
    }
  }, []);

  const stopWatch = useCallback(() => {
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
  }, []);

  const startWatch = useCallback(async () => {
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
    if (IS_E2E_MOCK) {
      setError(null);
      setPermissionDenied(false);
      setLocationUncertain(false);
      applyLocation(
        {
          latitude: E2E_MOCK_LOCATION.latitude,
          longitude: E2E_MOCK_LOCATION.longitude,
          accuracy: E2E_MOCK_LOCATION.accuracyMeters,
          speed: E2E_MOCK_LOCATION.speedMps,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
        },
        Date.now(),
      );
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setPermissionDenied(true);
        setLoading(false);
        return;
      }
      setPermissionDenied(false);

      // #808: 캐시 위치 hydrate 정책 — cold start 빈 화면 회피 + 잘못된 라우팅 방지.
      //
      // freshness 게이트(MAX_LOCATION_AGE_MS=15s)는 항상 유지 — stale 좌표로 hydrate하면
      // 사용자가 이미 이동한 뒤일 수 있어 위험.
      //
      // accuracy 게이트는 **표시 게이트(MAX_ACCURACY_M_DISPLAY=250m)**까지 허용:
      //   - 알람 엄격(200m) 통과 → applyLocation 정상 경로 (uncertain=false)
      //   - 알람 엄격 초과 + 표시 통과 (200~250m) → result만 hydrate + uncertain=true
      //     (cold start 빈 화면 회피 — UI는 "위치 확인 중" + 추정 역 표시)
      //   - 표시 게이트 초과 → 진단 로그 + 무시 (오정보 방지)
      // watch가 fresh fix를 보내면 uncertain이 false로 복귀하며 정정 가능.
      // 사용자 정책 "실시간성 우선, 나쁜 좌표 거부"와 일치 — 250m도 거부, 그 이하만 hydrate.
      const lastKnown = await Location.getLastKnownPositionAsync();
      if (lastKnown) {
        const fresh = isLocationFresh(lastKnown.timestamp);
        const strictlyAcceptable = isAccuracyAcceptable(lastKnown.coords.accuracy);
        const displayAcceptable = isAccuracyAcceptableForDisplay(lastKnown.coords.accuracy);
        if (fresh && strictlyAcceptable) {
          applyLocation(lastKnown.coords, lastKnown.timestamp);
          setLoading(false);
        } else if (fresh && displayAcceptable) {
          // cold start 완화 hydrate — result는 채우되 uncertain=true로 신뢰도 표시.
          applyLocation(lastKnown.coords, lastKnown.timestamp);
          setLocationUncertain(true);
          setLoading(false);
          logger.info('lastKnown coldStart hydrate: uncertain', {
            accuracyMeters: lastKnown.coords.accuracy,
          });
        } else if (!fresh) {
          lastKnownStaleCountRef.current += 1;
          logger.info('lastKnown rejected: stale', {
            ageMs: Date.now() - lastKnown.timestamp,
            cumulativeStale: lastKnownStaleCountRef.current,
          });
        } else {
          lastKnownLowAccuracyCountRef.current += 1;
          logger.info('lastKnown rejected: lowAccuracy', {
            accuracyMeters: lastKnown.coords.accuracy,
            cumulativeLowAccuracy: lastKnownLowAccuracyCountRef.current,
          });
        }
      }

      // 연속 GPS 스트리밍 — 지하 구간 horizontalAccuracy(300~1500m)도 표시용으로는 수용.
      // 알람은 useStationAlarm에서 accuracyMeters로 별도 엄격 게이트.
      // High + distanceInterval:0 + timeInterval:2000:
      //  좌표를 최대한 자주 흘려보낸다 (foreground 한정, 화면 켜진 동안만).
      //  High는 GPS hardware fix가 없으면 WiFi BSSID / Cell tower triangulation으로 fallback
      //  → 지하 구간에서도 ~50~100m 위치가 들어옴 (BestForNavigation은 fallback 없이 stale).
      // 참고: pausesUpdatesAutomatically / activityType은 expo-location foreground 옵션에
      //  노출되지 않아 적용 불가. background task 옵션에서만 사용 가능.
      subscriptionRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          distanceInterval: 0,
          timeInterval: 2000,
        },
        (location) => {
          if (!isAccuracyAcceptableForDisplay(location.coords.accuracy)) {
            setLocationUncertain(true);
            // #443: 표시 게이트에 drop된 fix도 사후 진단에 필요(사가정 같은 부정확 fix로
            // 락된 의심 시점을 식별). 이 분기는 accuracy가 non-null 임계 초과인 경우만.
            const dropSpeed = location.coords.speed;
            pushFusionDebugEntry({
              kind: 'gps',
              event: 'gps-drop',
              ts: Date.now(),
              lat: location.coords.latitude,
              lng: location.coords.longitude,
              accuracyMeters: location.coords.accuracy,
              speedMps: isValidGpsSpeedMps(dropSpeed) ? dropSpeed : null,
              nearestStation: null,
              nearestLine: null,
              nearestDistanceKm: null,
              dropReason: 'low-accuracy-display',
            });
            return;
          }
          setLocationUncertain(false);
          applyLocation(location.coords, location.timestamp);
        },
      );
      setLoading(false);
    } catch {
      setError('위치를 가져오는 데 실패했습니다.');
      setLoading(false);
    }
  }, [applyLocation]);

  // 수동 새로고침: watch 중지 → one-shot → watch 재시작
  const refresh = useCallback(async () => {
    stopWatch();
    if (IS_E2E_MOCK) {
      await startWatch();
      return;
    }
    let shouldRestart = true;
    try {
      setError(null);
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setPermissionDenied(true);
        shouldRestart = false;
        return;
      }
      setPermissionDenied(false);
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      if (isAccuracyAcceptableForDisplay(location.coords.accuracy)) {
        setLocationUncertain(false);
        applyLocation(location.coords, location.timestamp);
      } else {
        setLocationUncertain(true);
      }
    } catch {
      setError('위치를 가져오는 데 실패했습니다.');
    } finally {
      if (shouldRestart) await startWatch();
    }
  }, [stopWatch, startWatch, applyLocation]);

  useEffect(() => {
    startWatch();

    const appStateSub = AppState.addEventListener('change', (state) => {
      // #852: AppState 전환 시점에 즉시 gpsActive 라벨 갱신. silent push wake로 BG에 있는 동안
      // 'bg' 상태 유지 → 사용자가 디버그 모달에서 확인 가능.
      setGpsActive(appStateToGpsActive(state));
      if (state === 'active') {
        // FG 복귀 시 result는 BG 진입 시점의 stale 위치 — 사용자가 그 사이 이동했을 수 있다 (#543).
        // 명시적으로 uncertain 상태로 전환해 UI가 "위치 확인 중"을 표시하게 하고,
        // refresh()로 즉시 fresh fix를 요청한다. fresh fix가 들어오면 applyLocation이 uncertain을 해제.
        setLocationUncertain(true);
        // #711: BG task가 최근 평가한 nearest를 임시 hydrate. fresh fix(refresh→applyLocation) 도착 전
        // UI 공백을 메운다. uncertain=true는 유지 → "위치 확인 중" 표시 + hydrate된 역 정보 노출.
        // race: hydrate가 applyLocation 후에 resolve되면 신선 fix를 덮어쓸 수 있어,
        // result가 비어있을 때만 채운다 (prev ?? bg).
        // WhileInUse 사용자는 key 부재 → readBgLastStation null → no-op.
        void readBgLastStation().then((bg) => {
          if (bg) {
            setResult((prev) => prev ?? bg);
          }
        });
        void refresh();
      } else if (state === 'background') {
        stopWatch();
      }
      // inactive는 일시적 상태(전화 착신 등)이므로 무시
    });

    return () => {
      stopWatch();
      appStateSub.remove();
    };
  }, [startWatch, stopWatch, refresh]);

  // #876 — 매 fix를 sticky 훅에 전달. lock된 역이 있으면 result를 그것으로 override.
  // fusion candidates는 useFusedNearestStation에서 userLocation 기반으로 별도 계산하므로 영향 없음.
  const sticky = useStickyStation({
    candidate: result,
    accuracyMeters,
    speedMps,
  });

  const exposed = useMemo<{ result: NearestStationResult | null; source: NearestStationSource }>(
    () => {
      // sticky 비활성 또는 sticky가 live와 같은 역이면 live 결과 그대로 — reference 유지로
      // throttle/리렌더 가정을 깨지 않는다. sticky가 다른 역을 lock한 경우에만 override.
      if (!sticky.locked) return { result, source: 'live' };
      if (result && result.station.id === sticky.locked.id) {
        return { result, source: 'sticky' };
      }
      const distanceKm = userLocation
        ? haversine(userLocation.lat, userLocation.lng, sticky.locked.lat, sticky.locked.lng)
        : 0;
      return {
        result: { station: sticky.locked, distanceKm },
        source: 'sticky',
      };
    },
    [sticky.locked, result, userLocation],
  );

  return {
    result: exposed.result,
    variants,
    userLocation,
    speedMps,
    accuracyMeters,
    loading,
    error,
    permissionDenied,
    locationUncertain,
    gpsActive,
    lastFixAtMs,
    source: exposed.source,
    refresh,
  };
}
