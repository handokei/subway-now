import { useCallback, useEffect, useRef, useState } from 'react';
import type { StationArrival } from '../api/arrivalApi';
import type { ArrivalProvider } from '../providers/types';
import { createArrivalProvider } from '../providers/factory';
import { TtlCache } from '../utils/ttlCache';
import { usePolling } from './usePolling';

const POLL_INTERVAL_MS = 5_000;
const CACHE_TTL_MS = 30_000;

/**
 * 모듈 스코프 싱글톤 — fusion에서 동일 station name을 여러 hook 인스턴스가 폴링할 때
 * 중복 네트워크 호출을 막기 위한 공유 캐시.
 */
const arrivalCache = new TtlCache<string, StationArrival>(CACHE_TTL_MS);

/** 테스트 격리용 — useArrivalInfo 사용처 외에는 호출하지 말 것. */
export function __resetArrivalCacheForTests(): void {
  arrivalCache.clear();
}

function arrivalEqual(a: StationArrival | null, b: StationArrival): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

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
  const providerRef = useRef<ArrivalProvider>(provider ?? createArrivalProvider());
  const arrivalRef = useRef<StationArrival | null>(null);
  const stationNameRef = useRef(stationName);
  stationNameRef.current = stationName;

  const updateArrival = useCallback((data: StationArrival) => {
    if (!arrivalEqual(arrivalRef.current, data)) {
      arrivalRef.current = data;
      setArrival(data);
    }
  }, []);

  useEffect(() => {
    if (!stationName) {
      arrivalRef.current = null;
      setArrival(null);
      setLoading(false);
      return;
    }

    const cached = arrivalCache.get(stationName);
    if (cached) {
      updateArrival(cached);
      setLoading(false);
    } else {
      arrivalRef.current = null;
      setArrival(null);
      setLoading(true);
    }
  }, [stationName]);

  useEffect(() => {
    if (!stationName) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const data = await providerRef.current.getArrival(stationName);
        if (cancelled) return;
        if (!data.isMock) {
          arrivalCache.set(stationName, data);
        }
        updateArrival(data);
      } catch {
        // Provider 내부에서 에러 처리하지만, 미래 변경 대비
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    poll();

    return () => {
      cancelled = true;
    };
  }, [stationName]);

  usePolling(
    () => {
      const name = stationNameRef.current;
      if (!name) return;
      providerRef.current.getArrival(name).then((data) => {
        if (name !== stationNameRef.current) return;
        if (!data.isMock) {
          arrivalCache.set(name, data);
        }
        updateArrival(data);
        setLoading(false);
      }).catch(() => {});
    },
    POLL_INTERVAL_MS,
    { onResume: () => arrivalCache.clear() },
  );

  return { arrival, loading, isMock: arrival?.isMock ?? false };
}
