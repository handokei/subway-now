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
  const cacheRef = useRef<Map<string, StationArrival>>(new Map());

  useEffect(() => {
    if (!stationName) {
      setArrival(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const cached = cacheRef.current.get(stationName);
    if (cached) {
      setArrival(cached);
      setLoading(false);
    } else {
      setArrival(null);
      setLoading(true);
    }

    const poll = async () => {
      try {
        const data = await fetchArrivalInfo(stationName);
        if (cancelled) return;
        if (!data.isMock) {
          cacheRef.current.set(stationName, data);
        }
        setArrival(data);
      } catch {
        // fetchArrivalInfo는 내부에서 처리하지만, 미래 변경 대비
      } finally {
        if (!cancelled) setLoading(false);
      }
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
