import { useCallback, useEffect, useState } from 'react';
import * as Location from 'expo-location';
import { NearestStationResult, Station } from '../types/station';
import { findNearestStations } from '../utils/findNearestStation';
import { usePolling } from './usePolling';

const UPDATE_INTERVAL_MS = 30_000;

interface UseNearestStationReturn {
  result: NearestStationResult | null;
  variants: Station[];
  isTransfer: boolean;
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
  setIsTransfer: (t: boolean) => void,
): void {
  if (stationsResult) {
    setResult({ station: stationsResult.primary, distanceKm: stationsResult.distanceKm });
    setVariants(stationsResult.variants);
    setIsTransfer(stationsResult.isTransfer);
  } else {
    setResult(null);
    setVariants([]);
    setIsTransfer(false);
  }
}

export function useNearestStation(): UseNearestStationReturn {
  const [result, setResult] = useState<NearestStationResult | null>(null);
  const [variants, setVariants] = useState<Station[]>([]);
  const [isTransfer, setIsTransfer] = useState(false);
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
      applyNearestResult(
        findNearestStations(location.coords.latitude, location.coords.longitude),
        setResult, setVariants, setIsTransfer,
      );
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

  return { result, variants, isTransfer, userLocation, loading, error, permissionDenied, refresh };
}
