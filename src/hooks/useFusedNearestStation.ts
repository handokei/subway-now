import { useMemo } from 'react';
import { useNearestStation } from './useNearestStation';
import { useArrivalInfo } from './useArrivalInfo';
import { findTopNearestStations } from '../utils/findNearestStation';
import { pickFusedStation, type FusionConfidence } from '../utils/pickFusedStation';
import { MAX_STATION_DISTANCE_KM } from '../constants/location';
import type { NearestStationResult, Station } from '../types/station';
import type { ArrivalProvider } from '../providers/types';

/**
 * fusion 후보 개수. K=3 고정 — Rules of Hooks로 useArrivalInfo를 동적 개수로 호출할 수 없어
 * 명시적으로 풀어 쓴다(c0/c1/c2). 변경 시 본 파일의 hook 호출 라인도 함께 수정 필요.
 * 호출 비용은 useArrivalInfo의 모듈 스코프 캐시(arrivalCache)가 station name 단위로 dedup.
 */
const FUSION_CANDIDATE_LIMIT = 3;

interface UseFusedNearestStationReturn {
  /** GPS+arrival fusion으로 결정된 현재역. */
  result: NearestStationResult | null;
  /** GPS 원본 result — 비교/디버깅용. */
  gpsResult: NearestStationResult | null;
  /** fusion 신뢰도. arrival 신호로 확정/추정/없음. */
  confidence: FusionConfidence;
  /** GPS 환승역 변형(같은 이름 다른 노선) — 기존 useNearestStation 호환. */
  variants: Station[];
  userLocation: { lat: number; lng: number } | null;
  speedMps: number | null;
  accuracyMeters: number | null;
  loading: boolean;
  error: string | null;
  permissionDenied: boolean;
  refresh: () => Promise<void>;
}

/**
 * GPS 후보 상위 N개에 대해 realtimeStationArrival을 동시 폴링하고,
 * arvlCd 우선순위로 현재역을 fusion해 반환한다.
 *
 * 지하 구간 GPS 지연(이미 도착한 역인데 전역 표시)을 우회하는 것이 목적.
 * arrival 신호가 모두 약하면 GPS 최근접으로 자연 fallback.
 */
export function useFusedNearestStation(
  provider?: ArrivalProvider,
): UseFusedNearestStationReturn {
  const gps = useNearestStation();

  // GPS 좌표 → 거리순 후보 N개. 좌표 갱신 시에만 재계산.
  const candidates = useMemo<NearestStationResult[]>(() => {
    if (!gps.userLocation) return [];
    return findTopNearestStations(
      gps.userLocation.lat,
      gps.userLocation.lng,
      FUSION_CANDIDATE_LIMIT,
      MAX_STATION_DISTANCE_KM,
    );
  }, [gps.userLocation]);

  // 후보 K개에 대한 arrival 폴링 — hooks는 고정 순서 호출이 필요하므로 N=3 고정.
  // 후보 부족 시 null로 호출 → useArrivalInfo 내부에서 no-op.
  const c0 = candidates[0]?.station.name ?? null;
  const c1 = candidates[1]?.station.name ?? null;
  const c2 = candidates[2]?.station.name ?? null;
  const a0 = useArrivalInfo(c0, provider);
  const a1 = useArrivalInfo(c1, provider);
  const a2 = useArrivalInfo(c2, provider);

  const fused = useMemo(() => {
    if (candidates.length === 0) return null;
    const arrivals = [a0.arrival, a1.arrival, a2.arrival];
    return pickFusedStation(
      candidates.map((cand, i) => ({ candidate: cand, arrival: arrivals[i] ?? null })),
    );
  }, [candidates, a0.arrival, a1.arrival, a2.arrival]);

  return {
    result: fused?.result ?? gps.result,
    gpsResult: gps.result,
    confidence: fused?.confidence ?? 'gps-only',
    variants: gps.variants,
    userLocation: gps.userLocation,
    speedMps: gps.speedMps,
    accuracyMeters: gps.accuracyMeters,
    loading: gps.loading,
    error: gps.error,
    permissionDenied: gps.permissionDenied,
    refresh: gps.refresh,
  };
}
