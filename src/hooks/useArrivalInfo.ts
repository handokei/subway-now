import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchArrivalInfo, StationArrival } from '../api/arrivalApi';

const POLL_INTERVAL_MS = 30_000;

interface UseArrivalInfoReturn {
  arrival: StationArrival | null;
  loading: boolean;
  isMock: boolean;
}

export function useArrivalInfo(stationName: string | null): UseArrivalInfoReturn {
  const [arrival, setArrival] = useState<StationArrival | null>(null);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined as unknown as ReturnType<typeof setInterval>);
  const isMountedRef = useRef(true);

  const fetch = useCallback(async () => {
    if (!stationName) {
      setArrival(null);
      return;
    }
    setLoading(true);
    const data = await fetchArrivalInfo(stationName);
    if (!isMountedRef.current) return;
    setArrival(data);
    setLoading(false);
  }, [stationName]);

  useEffect(() => {
    fetch();
    intervalRef.current = setInterval(fetch, POLL_INTERVAL_MS);
    return () => {
      isMountedRef.current = false;
      clearInterval(intervalRef.current);
    };
  }, [fetch]);

  return { arrival, loading, isMock: arrival?.isMock ?? false };
}
