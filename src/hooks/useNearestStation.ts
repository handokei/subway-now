import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import { NearestStationResult, Station } from '../types/station';
import { findNearestStations } from '../utils/findNearestStation';

const DISTANCE_INTERVAL_M = 10;
const MIN_DISTANCE_CHANGE_KM = 0.01; // 10m

interface UseNearestStationReturn {
  result: NearestStationResult | null;
  variants: Station[];
  userLocation: { lat: number; lng: number } | null;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const lastStationIdRef = useRef<string | null>(null);
  const lastDistanceRef = useRef<number>(0);

  const applyLocation = useCallback((coords: { latitude: number; longitude: number }) => {
    const { latitude, longitude } = coords;
    const stationsResult = findNearestStations(latitude, longitude);

    const newId = stationsResult?.primary.id ?? null;
    const newDistance = stationsResult?.distanceKm ?? 0;
    const stationChanged = newId !== lastStationIdRef.current;
    const distanceDelta = Math.abs(newDistance - lastDistanceRef.current);

    if (stationChanged || distanceDelta > MIN_DISTANCE_CHANGE_KM) {
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

      // 캐시된 위치로 즉시 UI 표시
      const lastKnown = await Location.getLastKnownPositionAsync();
      if (lastKnown) {
        applyLocation(lastKnown.coords);
        setLoading(false);
      }

      // 연속 GPS 스트리밍 시작
      subscriptionRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: DISTANCE_INTERVAL_M },
        (location) => applyLocation(location.coords),
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
      applyLocation(location.coords);
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

  return { result, variants, userLocation, loading, error, permissionDenied, refresh };
}
