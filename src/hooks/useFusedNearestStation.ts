import { useEffect, useMemo, useRef } from 'react';
import {
  pushFusionDebugEntry,
  type FusionCandidateMini,
} from '../utils/fusionDebugBuffer';
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
import { passesFusionDistanceGate } from '../utils/fusionDistanceGate';
import { computeRouteArc } from '../utils/routeProgress';
import {
  arcIndexOfStation,
  interpolateBoardingLockStation,
} from '../utils/boardingLockInterpolation';
import { MAX_STATION_DISTANCE_KM } from '../constants/location';
import {
  MAX_ACTIVE_LINES,
  MAX_FUSION_DELTA_KM,
  MAX_FUSION_DISTANCE_KM,
  POSITION_TRAIN_TTL_MS,
} from '../constants/realtime';
import type { LinePositions } from '../api/positionApi';
import type { BoardingLock } from '../types/boardingLock';
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
  /** GPS 표시 게이트 drop으로 좌표가 정지된 상태. fusion에서 position/arrival 신호가 살아있어도
   *  GPS fallback 경로에 의존하는 호출자(예: 표시부)는 이 값으로 "위치 확인 중" UX를 띄울 수 있다. */
  locationUncertain: boolean;
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
  /**
   * 활성 BoardingLock의 trainCode. 사용자가 탭한 열차가 position-train으로 확인되면
   * source/confidence를 'boarding-lock'으로 승격 — UI/알람 dedup에서 최고 신뢰 신호로 식별.
   * null/undefined면 기존 우선순위 그대로.
   */
  lockedTrainCode?: string | null,
  /**
   * 활성 BoardingLock 전체 객체 (#621). 지하 GPS dead zone에서 GPS/realtimePosition API가
   * stale일 때 경과 시간 기반 interpolation으로 현재역을 ratchet forward 한다.
   * routeContext + boardingLock 둘 다 있어야 동작 — 한쪽이라도 없으면 기존 fusion 그대로.
   */
  boardingLock?: BoardingLock | null,
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
  // 각 후보의 호선을 lineHint로 함께 전달해 schedule fallback이 환승역에서 정확한
  // 호선을 사용하도록 한다 (#469).
  const c0 = candidates[0]?.station.name ?? null;
  const c1 = candidates[1]?.station.name ?? null;
  const c2 = candidates[2]?.station.name ?? null;
  const h0 = candidates[0]?.station.line ?? null;
  const h1 = candidates[1]?.station.line ?? null;
  const h2 = candidates[2]?.station.line ?? null;
  const a0 = useArrivalInfo(c0, h0, arrivalProvider);
  const a1 = useArrivalInfo(c1, h1, arrivalProvider);
  const a2 = useArrivalInfo(c2, h2, arrivalProvider);

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

  // #445: trainProgress 갱신 시각 추적 + TTL 만료 후 첫 갱신에서 sticky 락 해제.
  // 폴링 정지로 TTL이 지난 뒤 재개되면 trackTrainProgress가 stale sticky를 다시 픽업해
  // 잘못된 락이 반복되는 사이클을 끊는다 — 다음 사이클은 새 후보로 정상 disambiguation.
  const lastProgressTsRef = useRef<number>(0);
  useEffect(() => {
    if (!trainProgress) return;
    const now = Date.now();
    const prev = lastProgressTsRef.current;
    const ttlExpired = prev !== 0 && now - prev > POSITION_TRAIN_TTL_MS;
    if (ttlExpired) {
      lastConfirmedTrainNoRef.current = undefined;
    } else {
      lastConfirmedTrainNoRef.current = trainProgress.trainNo;
    }
    lastProgressTsRef.current = now;
  }, [trainProgress]);

  const positionTrainResult: NearestStationResult | null = useMemo(() => {
    if (!trainProgress) return null;
    const station = trainProgress.currentStation;
    // userLocation 부재(sticky 케이스 등) 시 placeholder 0. 신뢰도 보조 신호로 사용 금지 —
    // distanceKm은 화면 표시용이며 알람/정확도 판단은 source=='position-train'으로만 분기.
    const distanceKm = gps.userLocation
      ? haversine(gps.userLocation.lat, gps.userLocation.lng, station.lat, station.lng)
      : 0;

    // #445 TTL: trainProgress가 신선해야 함. stale하면 강등.
    // ref가 0이면 effect가 첫 ts를 commit하기 전 — useMemo는 pure하게 두기 위해 면제.
    if (
      lastProgressTsRef.current !== 0 &&
      Date.now() - lastProgressTsRef.current > POSITION_TRAIN_TTL_MS
    ) {
      return null;
    }
    // #444 거리 sanity — fused/route와 공통 헬퍼 재사용.
    const candidate = { station, distanceKm };
    if (
      !passesFusionDistanceGate({
        candidate,
        userLocation: gps.userLocation,
        accuracyMeters: gps.accuracyMeters,
        gpsNearest: candidates[0],
        maxAbsoluteKm: MAX_FUSION_DISTANCE_KM,
        maxDeltaKm: MAX_FUSION_DELTA_KM,
      })
    ) {
      return null;
    }
    return candidate;
  }, [trainProgress, gps.userLocation, gps.accuracyMeters, candidates]);

  const routeResult: NearestStationResult | null = progress.position
    ? {
        station: progress.position.current,
        distanceKm: progress.position.distanceToCurrentM / 1000,
      }
    : null;

  // 우선순위(Phase 1C 역전): position-train > position/arrival(fused) > route-progress > gps.
  // 기존: route-progress가 fused를 덮어쓰고 있었음.
  // #444: fused/route도 채택 직전 거리 sanity 통과 검사 — 미통과 시 다음 우선순위로.
  const gateOpts = {
    userLocation: gps.userLocation,
    accuracyMeters: gps.accuracyMeters,
    gpsNearest: candidates[0],
    maxAbsoluteKm: MAX_FUSION_DISTANCE_KM,
    maxDeltaKm: MAX_FUSION_DELTA_KM,
  };
  const fusedPasses =
    fused != null && passesFusionDistanceGate({ ...gateOpts, candidate: fused.result });
  const routePasses =
    routeResult != null && passesFusionDistanceGate({ ...gateOpts, candidate: routeResult });

  let result: NearestStationResult | null;
  let confidence: FusionConfidence;
  let source: FusionSource;
  if (positionTrainResult) {
    result = positionTrainResult;
    // #584 PR D2: position-train의 trainNo가 BoardingLock.trainCode와 일치하면 'boarding-lock'으로 승격.
    // 사용자가 탭한 바로 그 열차가 실시간 위치 API에 잡힌 상태 — 최고 신뢰 신호.
    // positionTrainResult가 non-null이면 trainProgress도 non-null (line 219 guard).
    const lockMatch =
      lockedTrainCode != null && trainProgress!.trainNo === lockedTrainCode;
    confidence = lockMatch ? 'boarding-lock' : 'position-train';
    source = lockMatch ? 'boarding-lock' : 'position-train';
  } else if (fused && fusedPasses) {
    result = fused.result;
    confidence = fused.confidence;
    source = fused.source;
  } else if (routeResult && routePasses) {
    result = routeResult;
    confidence = 'route-progress';
    source = 'route-progress';
  } else {
    result = gps.result;
    confidence = 'gps-only';
    source = 'gps';
  }

  // #621 BoardingLock 시간 interpolation — 지하 GPS stale ratchet forward.
  // arc상 시간 interp 위치가 현 채택된 결과보다 앞이거나, 채택 결과가 arc 밖이면 override.
  // 채택 결과가 더 앞이면 그대로(실제 신호 우선) — 역행 방지(monotone forward).
  // confidence/source는 #584 PR D2의 'boarding-lock'(position-train + trainCode 매칭)과
  // 구분하기 위해 'boarding-lock-interp' 별도 라벨 사용 — 측정·디버그 인프라에서 구분 가능.
  const arcStations = useMemo<Station[]>(() => {
    if (!routeContext || !routeContext.origin || !routeContext.destination) return [];
    const arc = computeRouteArc(
      routeContext.route,
      routeContext.origin,
      routeContext.destination,
    );
    return arc?.stations ?? [];
  }, [routeContext]);

  // useMemo로 감싸면 deps가 시간을 포함하지 않아 부모 리렌더가 없는 동안 stale.
  // interp는 findIndex 1회 + 정수 산술 — render마다 직접 계산해도 무비용.
  const interpResult = interpolateBoardingLockStation({
    lock: boardingLock ?? null,
    arcStations,
    now: Date.now(),
  });

  if (interpResult && arcStations.length > 0) {
    const chosenIdx = arcIndexOfStation(arcStations, result?.station ?? null);
    if (chosenIdx === -1 || interpResult.index > chosenIdx) {
      const distanceKm = gps.userLocation
        ? haversine(
            gps.userLocation.lat,
            gps.userLocation.lng,
            interpResult.station.lat,
            interpResult.station.lng,
          )
        : 0;
      result = { station: interpResult.station, distanceKm };
      confidence = 'boarding-lock-interp';
      source = 'boarding-lock-interp';
    }
  }

  // 측정(#443): 결정 변화(source/stationId/confidence) 시에만 push.
  // render 중 side-effect 회피 + 의존성 누락 은폐 회피를 위해 결정 key를 ref로 비교.
  const lastDecisionKeyRef = useRef<string | null>(null);
  const resultStationId = result?.station.id ?? null;
  const decisionKey = `${source}|${confidence}|${resultStationId}`;
  useEffect(() => {
    if (lastDecisionKeyRef.current === decisionKey) return;
    lastDecisionKeyRef.current = decisionKey;
    const candidates: FusionCandidateMini[] = [];
    if (positionTrainResult && trainProgress) {
      const { name, line } = positionTrainResult.station;
      // boarding-lock 매칭 근거: 어느 trainNo가 어떤 lock과 비교됐는지 사후 재구성.
      const { trainNo } = trainProgress;
      const lockMatch = lockedTrainCode != null && trainNo === lockedTrainCode;
      candidates.push({
        key: 'positionTrain',
        stationName: name,
        line,
        extra: {
          trainNo,
          lockedTrainCode: lockedTrainCode ?? null,
          lockMatch,
        },
      });
    }
    if (fused) {
      const { name, line } = fused.result.station;
      candidates.push({ key: 'fused', stationName: name, line, extra: { source: fused.source } });
    }
    if (routeResult) {
      const { name, line } = routeResult.station;
      candidates.push({ key: 'route', stationName: name, line });
    }
    if (gps.result) {
      const { name, line } = gps.result.station;
      candidates.push({
        key: 'gps',
        stationName: name,
        line,
        extra: { distanceKm: gps.result.distanceKm },
      });
    }
    pushFusionDebugEntry({
      kind: 'fusion',
      ts: Date.now(),
      source,
      confidence,
      stationName: result?.station.name ?? null,
      line: result?.station.line ?? null,
      distanceKm: result?.distanceKm ?? null,
      gpsAccuracyAtPushMeters: gps.accuracyMeters,
      candidates,
    });
  }, [decisionKey, source, confidence, result, positionTrainResult, fused, routeResult, gps.result, gps.accuracyMeters, trainProgress, lockedTrainCode]);

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
    locationUncertain: gps.locationUncertain,
    refresh: gps.refresh,
  };
}
