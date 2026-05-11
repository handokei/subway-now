import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import { NearestStationResult, Station } from '../types/station';
import { findNearestStations } from '../utils/findNearestStation';
import { isAccuracyAcceptable, isLocationFresh } from '../utils/locationGates';
import { MAX_STATION_DISTANCE_KM } from '../constants/location';

const DISTANCE_INTERVAL_M = 10;
const MIN_DISTANCE_CHANGE_KM = 0.01; // 10m

interface UseNearestStationReturn {
  result: NearestStationResult | null;
  variants: Station[];
  userLocation: { lat: number; lng: number } | null;
  speedMps: number | null;
  loading: boolean;
  error: string | null;
  permissionDenied: boolean;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const lastStationIdRef = useRef<string | null>(null);
  const lastDistanceRef = useRef<number>(0);

  const applyLocation = useCallback((coords: Location.LocationObjectCoords) => {
    const { latitude, longitude, speed } = coords;
    const stationsResult = findNearestStations(latitude, longitude, MAX_STATION_DISTANCE_KM);

    const newId = stationsResult?.primary.id ?? null;
    const newDistance = stationsResult?.distanceKm ?? 0;
    const stationChanged = newId !== lastStationIdRef.current;
    const distanceDelta = Math.abs(newDistance - lastDistanceRef.current);
    const noStation = !stationsResult && lastStationIdRef.current !== null;

    setSpeedMps(speed != null && speed >= 0 ? speed : null);

    if (stationChanged || distanceDelta > MIN_DISTANCE_CHANGE_KM || noStation) {
      lastStationIdRef.current = newId;
      lastDistanceRef.current = newDistance;
      setUserLocation({ lat: latitude, lng: longitude });
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
    try {
      setError(null);
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setPermissionDenied(true);
        setLoading(false);
        return;
      }
      setPermissionDenied(false);

      // 캐시된 위치는 신선하고 정확한 경우만 즉시 표시 (stale/저정확도로 인한 false alarm 방지)
      const lastKnown = await Location.getLastKnownPositionAsync();
      if (lastKnown && isLocationFresh(lastKnown.timestamp) && isAccuracyAcceptable(lastKnown.coords.accuracy)) {
        applyLocation(lastKnown.coords);
        setLoading(false);
      }

      // 연속 GPS 스트리밍 시작 — 저정확도 좌표는 무시
      subscriptionRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: DISTANCE_INTERVAL_M },
        (location) => {
          if (!isAccuracyAcceptable(location.coords.accuracy)) return;
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
      if (isAccuracyAcceptable(location.coords.accuracy)) {
        applyLocation(location.coords);
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

  return { result, variants, userLocation, speedMps, loading, error, permissionDenied, refresh };
}
