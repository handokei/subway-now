import { useEffect, useRef, useState } from 'react';
import type { StationArrival } from '../api/arrivalApi';
import type { ArrivalProvider } from '../providers/types';
import { createArrivalProvider } from '../providers/factory';

const POLL_INTERVAL_MS = 30_000;

interface UseArrivalInfoReturn {
  arrival: StationArrival | null;
  loading: boolean;
  isMock: boolean;
}

export function useArrivalInfo(
  stationName: string | null,
  provider?: ArrivalProvider,
): UseArrivalInfoReturn {
  const [arrival, setArrival] = useState<StationArrival | null>(null);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined as unknown as ReturnType<typeof setInterval>);
  const cacheRef = useRef<Map<string, StationArrival>>(new Map());
  const providerRef = useRef<ArrivalProvider>(provider ?? createArrivalProvider());

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
        const data = await providerRef.current.getArrival(stationName);
        if (cancelled) return;
        if (!data.isMock) {
          cacheRef.current.set(stationName, data);
        }
        setArrival(data);
      } catch {
        // Provider 내부에서 에러 처리하지만, 미래 변경 대비
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
