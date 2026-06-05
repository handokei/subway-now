import { useCallback, useEffect, useRef, useState } from 'react';
import type { StationArrival } from '../api/arrivalApi';
import type { ArrivalProvider } from '../providers/types';
import type { LineNumber } from '../../../shared/types/station';
import { createArrivalProvider } from '../providers/factory';
import { TtlCache } from '../../../shared/utils/ttlCache';
import { usePolling } from '../../../shared/hooks/usePolling';

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
  prefetchProvider = null;
}

/**
 * #814 prefetch 전용 모듈 싱글톤 provider. useArrivalInfo가 mount 전 또는 다른 station을
 * 폴링 중인 시점에 호출돼도 같은 캐시를 공유할 수 있도록 lazy 초기화.
 * (providerRef는 hook 인스턴스 단위라 prefetch caller가 직접 쓸 수 없음.)
 */
let prefetchProvider: ArrivalProvider | null = null;
function getPrefetchProvider(): ArrivalProvider {
  if (!prefetchProvider) prefetchProvider = createArrivalProvider();
  return prefetchProvider;
}

/**
 * 환승 등 임박 시점에 다음 노선 도착 정보를 사전 폴링해 warmup을 단축한다 (#814).
 * - cache TTL(30s) 내에 valid 엔트리가 있으면 no-op — 중복 네트워크 호출 방지.
 * - 결과는 useArrivalInfo와 같은 모듈 스코프 cache에 저장되어, 호출자(useTransferTrainList)가
 *   transferContext 활성화로 useArrivalInfo를 마운트할 때 첫 effect가 cache hit으로 즉시 표시.
 * - 호출자는 결과를 await할 필요 없음 — fire-and-forget. 실패 시 silent (다음 폴링이 재시도).
 */
export async function prefetchArrival(
  stationName: string | null,
  lineHint?: LineNumber | null,
): Promise<void> {
  if (!stationName) return;
  if (arrivalCache.get(stationName)) return;
  try {
    const data = await getPrefetchProvider().getArrival(stationName, {
      lineHint: lineHint ?? undefined,
    });
    if (!data.isMock) {
      arrivalCache.set(stationName, data);
    }
  } catch {
    // prefetch 실패는 무시 — 실제 useArrivalInfo 폴링이 재시도한다.
  }
}

function arrivalEqual(a: StationArrival | null, b: StationArrival): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface UseArrivalInfoReturn {
  arrival: StationArrival | null;
  loading: boolean;
  isMock: boolean;
  /**
   * 호출 즉시 한 번 강제 폴링을 트리거한다 (#814). 캐시 TTL과 무관하게 fetch — 환승 알람
   * dismiss 직후 다음 노선 list가 자연 polling 주기(5초)를 기다리지 않고 최신 데이터로
   * 갱신되도록 한다. stationName이 null이면 no-op.
   */
  refetch: () => void;
}

export function useArrivalInfo(
  stationName: string | null,
  lineHint?: LineNumber | null,
  provider?: ArrivalProvider,
): UseArrivalInfoReturn {
  const [arrival, setArrival] = useState<StationArrival | null>(null);
  const [loading, setLoading] = useState(false);
  const providerRef = useRef<ArrivalProvider>(provider ?? createArrivalProvider());
  const arrivalRef = useRef<StationArrival | null>(null);
  const stationNameRef = useRef(stationName);
  stationNameRef.current = stationName;
  // lineHint는 환승역 schedule fallback의 정확도용. 캐시 키에는 포함하지 않는다
  // (같은 역의 실시간 응답은 호선 무관 동일하므로 캐시 공유가 더 효율적).
  const lineHintRef = useRef(lineHint);
  lineHintRef.current = lineHint;

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
        const data = await providerRef.current.getArrival(stationName, {
          lineHint: lineHint ?? undefined,
        });
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
    // lineHint가 바뀌면 즉시 refetch — stale hint로 5초간 잘못된 호선 schedule이 보이는 것 방지.
  }, [stationName, lineHint]);

  const doPoll = useCallback(() => {
    const name = stationNameRef.current;
    if (!name) return;
    providerRef.current.getArrival(name, {
      lineHint: lineHintRef.current ?? undefined,
    }).then((data) => {
      if (name !== stationNameRef.current) return;
      if (!data.isMock) {
        arrivalCache.set(name, data);
      }
      updateArrival(data);
      setLoading(false);
    }).catch(() => {});
  }, [updateArrival]);

  usePolling(doPoll, POLL_INTERVAL_MS, { onResume: () => arrivalCache.clear() });

  return { arrival, loading, isMock: arrival?.isMock ?? false, refetch: doPoll };
}
