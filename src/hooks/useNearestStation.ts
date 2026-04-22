import { useCallback, useEffect, useState } from 'react';
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

      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

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
