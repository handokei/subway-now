import { useEffect, useMemo, useRef } from 'react';
import { useNearestStation } from './useNearestStation';
import { useArrivalInfo } from './useArrivalInfo';
import { useTrainPositions } from './useTrainPositions';
import { useRouteProgress } from './useRouteProgress';
import { findTopNearestStations } from '../utils/findNearestStation';
import { findActiveLines } from '../utils/findActiveLines';
import { pickFusedStation, type FusionConfidence, type FusionSource } from '../utils/pickFusedStation';
import { pickCandidateTrains, type CandidateTrain } from '../utils/pickCandidateTrains';
import { trackTrainProgress } from '../utils/trackTrainProgress';
import { haversine } from '../utils/haversine';
import { MAX_STATION_DISTANCE_KM } from '../constants/location';
import { MAX_ACTIVE_LINES } from '../constants/realtime';
import type { LinePositions } from '../api/positionApi';
import type { NearestStationResult, Station } from '../types/station';
import type { ArrivalProvider, PositionProvider } from '../providers/types';
import type { Route } from '../utils/stationRoute';

/**
 * fusion 후보 개수. MAX_ACTIVE_LINES와 동기화 — Rules of Hooks로 useArrivalInfo/useTrainPositions를
 * 동적 개수로 호출할 수 없어 본 파일의 hook 호출 라인(c0/c1/c2, l0/l1/l2)도 같이 풀어 쓴다.
 * 상수 변경 시 hook 호출도 함께 수정해야 한다(컴파일러가 catch 못함).
 * 호출 비용은 모듈 스코프 캐시(arrivalCache/positionCache)가 station name·line 단위로 dedup.
 */
const FUSION_CANDIDATE_LIMIT = MAX_ACTIVE_LINES;

interface UseFusedNearestStationReturn {
  /** GPS+arrival+position fusion으로 결정된 현재역. */
  result: NearestStationResult | null;
  /** GPS 원본 result — 비교/디버깅용. */
  gpsResult: NearestStationResult | null;
  /** fusion 신뢰도. */
  confidence: FusionConfidence;
  /** fusion 신호 출처. position(가장 정확) > arrival(추정) > gps(거리). */
  source: FusionSource;
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
/**
 * 후보 역의 호선에 해당하는 LinePositions에서 해당 후보 역에 머무는 열차들을 추출.
 *
 * 매칭 키: `(line, statnNm)`.
 * stations.json의 `id`(예: "1-001")는 자체 포맷이고 서울 API `statnId`(예: "1002000201")는
 * 10자리 코드라 키 공간이 달라 직접 비교 불가. line은 외부 호출 시 이미 지정했으니 같은 lp 안에서는
 * 역명만으로 충분 — 한 호선의 같은 역명은 유일(같은 호선에 동명역 없음).
 *
 * 빈 배열이면 신호 없음(매칭 실패).
 */
function matchPositionsForCandidate(
  candidate: NearestStationResult,
  positions: (LinePositions | null)[],
): LinePositions['trains'] {
  for (const lp of positions) {
    if (!lp || lp.line !== candidate.station.line) continue;
    return lp.trains.filter((t) => t.statnNm === candidate.station.name);
  }
  return [];
}

/**
 * 경로 컨텍스트가 제공되면 useRouteProgress(1D map matching)를 기본으로 사용해
 * 단일 GPS 점프로 화면이 흔들리는 문제를 막는다. 경로가 없으면 기존 GPS+arrival fusion 유지.
 */
export interface FusedRouteContext {
  route: Route;
  origin: Station | null;
  destination: Station | null;
}

export function useFusedNearestStation(
  arrivalProvider?: ArrivalProvider,
  positionProvider?: PositionProvider,
  routeContext?: FusedRouteContext,
): UseFusedNearestStationReturn {
  const gps = useNearestStation();

  // Phase A: 경로가 설정되면 진행도 기반 현재역으로 GPS 결과를 덮어쓴다.
  // origin/destination이 빠지면 useRouteProgress가 arc를 만들지 못하고 null을 반환,
  // 기존 GPS fusion이 자연 fallback으로 살아난다.
  const progress = useRouteProgress({
    route: routeContext?.route ?? null,
    origin: routeContext?.origin ?? null,
    destination: routeContext?.destination ?? null,
    userLocation: gps.userLocation,
    speedMps: gps.speedMps,
    accuracyMeters: gps.accuracyMeters,
  });

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

  // arrival 폴링: 후보 역명 단위 K=3 고정.
  const c0 = candidates[0]?.station.name ?? null;
  const c1 = candidates[1]?.station.name ?? null;
  const c2 = candidates[2]?.station.name ?? null;
  const a0 = useArrivalInfo(c0, arrivalProvider);
  const a1 = useArrivalInfo(c1, arrivalProvider);
  const a2 = useArrivalInfo(c2, arrivalProvider);

  // position 폴링: 후보 역들의 호선만 dedup 후 K=3 고정 슬롯.
  // (대부분 1~2개 호선이지만 환승 인근에서 3개까지 가능)
  const activeLines = useMemo(() => findActiveLines(candidates), [candidates]);
  const l0 = activeLines[0] ?? null;
  const l1 = activeLines[1] ?? null;
  const l2 = activeLines[2] ?? null;
  const p0 = useTrainPositions(l0, positionProvider);
  const p1 = useTrainPositions(l1, positionProvider);
  const p2 = useTrainPositions(l2, positionProvider);

  const fused = useMemo(() => {
    if (candidates.length === 0) return null;
    const arrivals = [a0.arrival, a1.arrival, a2.arrival];
    const positions = [p0.positions, p1.positions, p2.positions];
    return pickFusedStation(
      candidates.map((cand, i) => ({
        candidate: cand,
        arrival: arrivals[i] ?? null,
        positionMatches: matchPositionsForCandidate(cand, positions),
      })),
    );
  }, [candidates, a0.arrival, a1.arrival, a2.arrival, p0.positions, p1.positions, p2.positions]);

  // Phase 1C: Position-first fusion.
  // 후보 trainNo들(pickCandidateTrains) → trackTrainProgress로 단일 trainNo·현재역 결정.
  // anchor = 각 호선의 GPS 최근접 후보. 후보 1개로 단정되거나 GPS로 disambiguation되면 채택.
  const lastConfirmedTrainNoRef = useRef<string | undefined>(undefined);
  const candidateTrains = useMemo<CandidateTrain[]>(() => {
    const lps: (LinePositions | null)[] = [p0.positions, p1.positions, p2.positions];
    const out: CandidateTrain[] = [];
    for (const lp of lps) {
      if (!lp) continue;
      const anchor = candidates.find((c) => c.station.line === lp.line)?.station.name;
      out.push(
        ...pickCandidateTrains({
          positions: [lp],
          line: lp.line,
          anchorStationName: anchor,
        }),
      );
    }
    return out;
  }, [candidates, p0.positions, p1.positions, p2.positions]);

  const trainProgress = useMemo(
    () =>
      trackTrainProgress({
        candidates: candidateTrains,
        userLocation: gps.userLocation,
        lastConfirmedTrainNo: lastConfirmedTrainNoRef.current,
      }),
    [candidateTrains, gps.userLocation],
  );

  useEffect(() => {
    if (trainProgress) lastConfirmedTrainNoRef.current = trainProgress.trainNo;
  }, [trainProgress]);

  const positionTrainResult: NearestStationResult | null = useMemo(() => {
    if (!trainProgress) return null;
    const station = trainProgress.currentStation;
    // userLocation 부재(sticky 케이스 등) 시 placeholder 0. 신뢰도 보조 신호로 사용 금지 —
    // distanceKm은 화면 표시용이며 알람/정확도 판단은 source=='position-train'으로만 분기.
    const distanceKm = gps.userLocation
      ? haversine(gps.userLocation.lat, gps.userLocation.lng, station.lat, station.lng)
      : 0;
    return { station, distanceKm };
  }, [trainProgress, gps.userLocation]);

  const routeResult: NearestStationResult | null = progress.position
    ? {
        station: progress.position.current,
        distanceKm: progress.position.distanceToCurrentM / 1000,
      }
    : null;

  // 우선순위(Phase 1C 역전): position-train > position/arrival(fused) > route-progress > gps.
  // 기존: route-progress가 fused를 덮어쓰고 있었음.
  let result: NearestStationResult | null;
  let confidence: FusionConfidence;
  let source: FusionSource;
  if (positionTrainResult) {
    result = positionTrainResult;
    confidence = 'position-train';
    source = 'position-train';
  } else if (fused) {
    result = fused.result;
    confidence = fused.confidence;
    source = fused.source;
  } else if (routeResult) {
    result = routeResult;
    confidence = 'route-progress';
    source = 'route-progress';
  } else {
    result = gps.result;
    confidence = 'gps-only';
    source = 'gps';
  }

  return {
    result,
    gpsResult: gps.result,
    confidence,
    source,
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
