import { useCallback, useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { NearestStationResult } from '../types/station';
import { findNearestStation } from '../utils/findNearestStation';
import { usePolling } from './usePolling';

const UPDATE_INTERVAL_MS = 30_000;

interface UseNearestStationReturn {
  result: NearestStationResult | null;
  userLocation: { lat: number; lng: number } | null;
  loading: boolean;
  error: string | null;
  permissionDenied: boolean;
  refresh: () => Promise<void>;
}

export function useNearestStation(): UseNearestStationReturn {
  const [result, setResult] = useState<NearestStationResult | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const isFirstFetch = useRef(true);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setPermissionDenied(true);
        setLoading(false);
        return;
      }
      setPermissionDenied(false);

      // 첫 호출: 캐시된 위치로 즉시 UI 표시
      if (isFirstFetch.current) {
        const lastKnown = await Location.getLastKnownPositionAsync();
        if (lastKnown) {
          setUserLocation({ lat: lastKnown.coords.latitude, lng: lastKnown.coords.longitude });
          setResult(findNearestStation(lastKnown.coords.latitude, lastKnown.coords.longitude));
          setLoading(false);
        }
      }

      // 첫 호출은 Balanced(빠른 fix), 이후는 High(정밀)
      const accuracy = isFirstFetch.current
        ? Location.Accuracy.Balanced
        : Location.Accuracy.High;
      isFirstFetch.current = false;

      const location = await Location.getCurrentPositionAsync({ accuracy });

      setUserLocation({ lat: location.coords.latitude, lng: location.coords.longitude });
      const nearest = findNearestStation(location.coords.latitude, location.coords.longitude);
      setResult(nearest);
    } catch (e) {
      setError('위치를 가져오는 데 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  usePolling(refresh, UPDATE_INTERVAL_MS);

  return { result, userLocation, loading, error, permissionDenied, refresh };
}
