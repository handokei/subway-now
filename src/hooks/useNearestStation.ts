import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import { NearestStationResult, Station } from '../types/station';
import { findNearestStations } from '../utils/findNearestStation';
import { isAccuracyAcceptable, isAccuracyAcceptableForDisplay, isLocationFresh } from '../utils/locationGates';
import { MAX_STATION_DISTANCE_KM } from '../constants/location';
import { E2E_MOCK_LOCATION, IS_E2E_MOCK } from '../constants/e2e';
import { createLogger } from '../utils/logger';

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
  refresh: () => Promise<void>;
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
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const lastStationIdRef = useRef<string | null>(null);
  const lastDistanceRef = useRef<number>(0);
  // 진단용 누적 카운터: lastKnown 캐시 fix가 freshness/accuracy 게이트에서 거부된 횟수.
  // BG→FG 전환마다 startWatch가 호출되므로 stale 위치 의심 시 운영 로그로 추적한다.
  const lastKnownStaleCountRef = useRef<number>(0);
  const lastKnownLowAccuracyCountRef = useRef<number>(0);

  const applyLocation = useCallback((coords: Location.LocationObjectCoords) => {
    const { latitude, longitude, speed, accuracy } = coords;
    const stationsResult = findNearestStations(latitude, longitude, MAX_STATION_DISTANCE_KM);

    const newId = stationsResult?.primary.id ?? null;
    const newDistance = stationsResult?.distanceKm ?? 0;
    const stationChanged = newId !== lastStationIdRef.current;
    const distanceDelta = Math.abs(newDistance - lastDistanceRef.current);
    const noStation = !stationsResult && lastStationIdRef.current !== null;

    // raw 신호는 매 fix 즉시 갱신. useFusedNearestStation의 candidates 메모가
    // userLocation 변화에 의존하므로 throttle 안에 두면 천천히 이동할 때 후보가 잠긴다.
    setSpeedMps(speed != null && speed >= 0 ? speed : null);
    setAccuracyMeters(accuracy ?? null);
    setUserLocation({ lat: latitude, lng: longitude });

    // 표시값(result/variants)은 3m throttle 유지 — 잦은 리렌더 방지.
    if (stationChanged || distanceDelta > MIN_DISTANCE_CHANGE_KM || noStation) {
      lastStationIdRef.current = newId;
      lastDistanceRef.current = newDistance;
      applyNearestResult(stationsResult, setResult, setVariants);
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
      applyLocation({
        latitude: E2E_MOCK_LOCATION.latitude,
        longitude: E2E_MOCK_LOCATION.longitude,
        accuracy: E2E_MOCK_LOCATION.accuracyMeters,
        speed: E2E_MOCK_LOCATION.speedMps,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
      });
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

      // 캐시된 위치는 신선하고 알람 엄격 게이트(200m)를 통과하는 경우만 즉시 표시.
      // 콜드 스타트 시 부정확한 fix로 사용자에게 오정보를 주는 것을 방지.
      const lastKnown = await Location.getLastKnownPositionAsync();
      if (lastKnown) {
        const fresh = isLocationFresh(lastKnown.timestamp);
        const acceptable = isAccuracyAcceptable(lastKnown.coords.accuracy);
        if (fresh && acceptable) {
          applyLocation(lastKnown.coords);
          setLoading(false);
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
      // BestForNavigation + distanceInterval:0 + timeInterval:2000:
      //  좌표를 최대한 자주 흘려보낸다 (foreground 한정, 화면 켜진 동안만 GPS 풀파워).
      // 참고: pausesUpdatesAutomatically / activityType은 expo-location foreground 옵션에
      //  노출되지 않아 적용 불가. background task 옵션에서만 사용 가능.
      subscriptionRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          distanceInterval: 0,
          timeInterval: 2000,
        },
        (location) => {
          if (!isAccuracyAcceptableForDisplay(location.coords.accuracy)) {
            setLocationUncertain(true);
            return;
          }
          setLocationUncertain(false);
          applyLocation(location.coords);
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
        applyLocation(location.coords);
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
      if (state === 'active') {
        startWatch();
      } else if (state === 'background') {
        stopWatch();
      }
      // inactive는 일시적 상태(전화 착신 등)이므로 무시
    });

    return () => {
      stopWatch();
      appStateSub.remove();
    };
  }, [startWatch, stopWatch]);

  return { result, variants, userLocation, speedMps, accuracyMeters, loading, error, permissionDenied, locationUncertain, refresh };
}
