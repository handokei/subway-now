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
 *
 * #1400 — 캐시 키는 `${stationName}|${lineHint ?? ''}` 형태로 호선을 포함한다. BFF 실시간 응답은
 * 호선 무관 동일하지만, 응답 실패/누락 시 `getFallbackArrival(stationName, ..., lineHint)`가 호선별로
 * 다른 schedule fallback을 반환한다. 호선 무관 키로 캐시하면 환승역에서 직전 호선의 schedule fallback이
 * 다음 호선 폴링에도 잔존해 "논현인데 3호선 신사행" 같은 호선 mis-display로 이어진다.
 */
const arrivalCache = new TtlCache<string, StationArrival>(CACHE_TTL_MS);

/**
 * `useArrivalInfo` 공유 캐시 키 빌더 — `(stationName, lineHint)` 조합으로 격리한다 (#1400).
 *
 * lineHint가 null/undefined인 호출(fusion 등 호선 미지정)은 빈 문자열로 정규화해 호선 미지정 케이스끼리만
 * 캐시를 공유한다. 호선 지정 호출(transfer list, 환승 컨텍스트)은 호선별로 독립 격리.
 */
function arrivalCacheKey(stationName: string, lineHint: LineNumber | null | undefined): string {
  return `${stationName}|${lineHint ?? ''}`;
}

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
  const key = arrivalCacheKey(stationName, lineHint);
  if (arrivalCache.get(key)) return;
  try {
    const data = await getPrefetchProvider().getArrival(stationName, {
      lineHint: lineHint ?? undefined,
    });
    if (!data.isMock) {
      arrivalCache.set(key, data);
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
  // #1400 — lineHint는 캐시 키에 포함된다. 환승역에서 같은 station name이라도 호선별 schedule
  // fallback이 다르므로 (현재역 도착정보가 잘못된 호선/방면을 표시하는 회귀 차단).
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

    const cached = arrivalCache.get(arrivalCacheKey(stationName, lineHint));
    if (cached) {
      updateArrival(cached);
      setLoading(false);
    } else {
      arrivalRef.current = null;
      setArrival(null);
      setLoading(true);
    }
    // lineHint가 바뀌면 새 (station, line) 키로 캐시 lookup. fusion 슬롯 교체 시 직전 호선
    // 캐시가 잔존해 잘못된 도착정보로 표시되는 회귀 차단(#1400).
  }, [stationName, lineHint, updateArrival]);

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
          arrivalCache.set(arrivalCacheKey(stationName, lineHint), data);
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
  }, [stationName, lineHint, updateArrival]);

  const doPoll = useCallback(() => {
    const name = stationNameRef.current;
    if (!name) return;
    const hint = lineHintRef.current;
    providerRef.current.getArrival(name, {
      lineHint: hint ?? undefined,
    }).then((data) => {
      if (name !== stationNameRef.current) return;
      if (!data.isMock) {
        arrivalCache.set(arrivalCacheKey(name, hint), data);
      }
      updateArrival(data);
      setLoading(false);
    }).catch(() => {});
  }, [updateArrival]);

  usePolling(doPoll, POLL_INTERVAL_MS, { onResume: () => arrivalCache.clear() });

  return { arrival, loading, isMock: arrival?.isMock ?? false, refetch: doPoll };
}
