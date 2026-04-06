import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchArrivalInfo, StationArrival } from '../api/arrivalApi';

const POLL_INTERVAL_MS = 30_000;

interface UseArrivalInfoReturn {
  arrival: StationArrival | null;
  loading: boolean;
  error: string | null;
}

export function useArrivalInfo(stationName: string | null): UseArrivalInfoReturn {
  const [arrival, setArrival] = useState<StationArrival | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined as unknown as ReturnType<typeof setInterval>);

  const fetch = useCallback(async () => {
    if (!stationName) {
      setArrival(null);
      return;
    }
    try {
      setError(null);
      setLoading(true);
      const data = await fetchArrivalInfo(stationName);
      setArrival(data);
    } catch {
      setError('도착 정보를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [stationName]);

  useEffect(() => {
    fetch();
    intervalRef.current = setInterval(fetch, POLL_INTERVAL_MS);
    return () => {
      clearInterval(intervalRef.current);
    };
  }, [fetch]);

  return { arrival, loading, error };
}
