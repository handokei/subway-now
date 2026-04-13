import { useCallback, useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import stationsData from '../data/stations.json';
import { haversine } from '../utils/haversine';
import { NearestStationResult, Station } from '../types/station';

const stations = stationsData as Station[];
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
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined as unknown as ReturnType<typeof setInterval>);

  const findNearest = useCallback(
    (lat: number, lng: number): NearestStationResult | null => {
      let nearest: Station | null = null;
      let minDistance = Infinity;

      for (const station of stations) {
        const dist = haversine(lat, lng, station.lat, station.lng);
        if (dist < minDistance) {
          minDistance = dist;
          nearest = station;
        }
      }

      if (nearest) {
        return { station: nearest, distanceKm: minDistance };
      }
      return null;
    },
    []
  );

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
      const nearest = findNearest(location.coords.latitude, location.coords.longitude);
      setResult(nearest);
    } catch (e) {
      setError('위치를 가져오는 데 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }, [findNearest]);

  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, UPDATE_INTERVAL_MS);
    return () => {
      clearInterval(intervalRef.current);
    };
  }, [refresh]);

  return { result, userLocation, loading, error, permissionDenied, refresh };
}
