import { useEffect, useRef, useState } from 'react';
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

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      if (!stationName) {
        setArrival(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      const data = await fetchArrivalInfo(stationName);
      if (cancelled) return;
      setArrival(data);
      setLoading(false);
    };

    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalRef.current);
    };
  }, [stationName]);

  return { arrival, loading, isMock: arrival?.isMock ?? false };
}
