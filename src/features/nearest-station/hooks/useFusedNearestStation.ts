/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useEffect, useMemo, useRef } from 'react';
import {
  pushFusionDebugEntry,
  type FusionCandidateMini,
} from '../utils/fusionDebugBuffer';
import { useNearestStation } from './useNearestStation';
import { useArrivalInfo } from '../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../route/hooks/useTrainPositions';
import { useRouteProgress } from '../../route/hooks/useRouteProgress';
import { usePositionStability } from './usePositionStability';
import { useFusedStationDetection } from './useFusedStationDetection';
import type { BarometerSignal } from '../../../shared/hooks/useBarometer';
import { findTopNearestStations } from '../utils/findNearestStation';
import { findActiveLines } from '../../route/utils/findActiveLines';
import { pickFusedStation, type FusionConfidence, type FusionSource } from '../utils/pickFusedStation';
import { shouldDowngradeFusion } from '../utils/movementGate';
import type { PositionStability } from '../utils/positionStaticDetector';
import { pickCandidateTrains, type CandidateTrain } from '../../arrival/utils/pickCandidateTrains';
import { trackTrainProgress } from '../../route/utils/trackTrainProgress';
import { haversine } from '../../../shared/utils/haversine';
import { isWithinArcWindow, passesFusionDistanceGate } from '../utils/fusionDistanceGate';
import { computeRouteArc } from '../../route/utils/routeProgress';
import {
  arcIndexOfStation,
  estimateStationProgress,
} from '../../route/utils/stationProgressEstimator';
import { hopTimeMsAt } from '../../route/utils/hopTime';
import { MAX_STATION_DISTANCE_KM } from '../../../shared/constants/location';
import {
  MAX_ACTIVE_LINES,
  MAX_FUSION_DELTA_KM,
  MAX_FUSION_DISTANCE_KM,
  POSITION_TRAIN_TTL_MS,
} from '../../../shared/constants/realtime';
import type { LinePositions } from '../api/positionApi';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { NearestStationResult, Station } from '../../../shared/types/station';
import type { ArrivalProvider } from '../../../shared/types/providers';
import type { PositionProvider } from '../providers/types';
import type { Route } from '../../../shared/utils/stationRoute';

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
  /** #852 — GPS watch 구독 활성 여부(FG only). BG/silent push wake 시 'bg' — 디버그 표기용. */
  gpsActive: import('../../../shared/constants/gpsStatus').GpsActiveState;
  /** #852 — 마지막 신뢰 fix epoch ms. null = 한 번도 fix 없음. 디버그 표기용. */
  lastFixAtMs: number | null;
  /**
   * #733 — 위치 이력 기반 정적/이동/판정불가. iOS가 speed=-1(미측정)을 보고하는 정적 케이스에서
   * movementGate fallback 신호로 사용. 호출자(useStationAlarm 등)가 evaluateMovement에 전달해
   * speed 부재 시에도 정적 misfire 차단을 가능하게 한다.
   */
  positionStability: PositionStability;
  /**
   * #1025 — stationProgressEstimator가 이번 render에서 채택한 전략.
   * BoardingLock 비활성 시 null. DebugModal Estimator State 섹션에서 사용.
   */
  estimatorStrategy: import('../../route/utils/stationProgressEstimator').StationProgressStrategy | null;
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

interface CandidateArrivalSlot {
  /** 폴링 시 사용한 후보 역명 — `useArrivalInfo`의 첫 인자와 동일. */
  stationName: string | null;
  /**
   * 폴링 시 사용한 후보 노선 — `useArrivalInfo`의 두 번째 인자와 동일. 같은 역명 다른 노선
   * 환승역(예: 충무로 3호선/4호선)에서 잘못된 슬롯이 픽되는 것을 차단하기 위해 사용. (#921 P1.4)
   */
  line: string | null;
  arrival: StationArrival | null;
}

/**
 * 다음 역(`arcStations[currentIdx+1]`)에 해당하는 ArrivalInfo 목록을 기존 `useArrivalInfo` 결과에서 추출.
 *
 * ADR-008 ② ArrivalEtaStrategy 입력(#745). 신규 폴링을 신설하지 않고 GPS 후보 슬롯(a0/a1/a2)에
 * 이미 받아둔 `StationArrival`에서 `(stationName, line)` 매칭으로 한 슬롯만 골라 `up + down`을 concat한다.
 *
 * 다음 역이 GPS 후보가 아니면(사용자가 다음 역에 충분히 가깝지 않은 dead zone) 빈 배열 반환 — 그
 * 사이클은 ② skip, ③(ReanchoredHop)이 자연 fallback. fusion 캐시 재사용만으로 ② 효과가 트립의
 * 마지막 ~500m 구간에 집중되도록 설계된 의도(추가 폴링 없이 정확도 ↑).
 */
function pickArrivalsForStation(
  station: Station | null,
  slots: readonly CandidateArrivalSlot[],
): readonly ArrivalInfo[] {
  if (!station) return [];
  for (const { stationName, arrival } of slots) {
    if (!arrival) continue;
    if (stationName !== station.name) continue;
    // 같은 역명이라도 환승역이면 두 호선 응답이 섞일 수 있어 row.line으로 한 번 더 좁힌다.
    const matched = [...arrival.up, ...arrival.down].filter((row) => row.line === station.line);
    if (matched.length > 0) return matched;
  }
  return [];
}

/**
 * #921 — 채택된 result.station(name+line)과 매칭되는 후보 슬롯의 StationArrival을 반환.
 *
 * 신호 fusion 입력용 — slot에서 어떤 row가 lockedTrainCode와 매칭되는지는 호출자
 * (useFusedStationDetection)가 판정한다. 매칭 슬롯이 없으면 null — fusion 입력 unavailable.
 *
 * #957 (P1.4 follow-up): 환승역(같은 stationName 다른 line)에서 옆 노선 슬롯이 픽되는 회귀
 * 차단. `useArrivalInfo`는 `(stationName, line)`로 폴링하므로 슬롯의 line은 응답의 라인과
 * 동일하다. 따라서 result.station.line과 슬롯 line을 같이 비교해야 한다.
 */
export function pickArrivalForStationName(
  stationName: string,
  line: string,
  slots: readonly CandidateArrivalSlot[],
): StationArrival | null {
  for (const slot of slots) {
    if (
      slot.stationName === stationName &&
      slot.line === line &&
      slot.arrival !== null
    ) {
      return slot.arrival;
    }
  }
  return null;
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
  /**
   * #728 — CMMotionActivity(iOS) motion=stationary 신호. shouldDowngradeFusion이 speed=null인
   * 정적 사용자 케이스에서 positionStability보다 우선 적용. 미전달이면 기존 동작 유지.
   * #1013 — undefined는 warmup 상태(fg-hydrate 직후 ~30s). evaluateMovement로 전달되어
   * speed=null + positionStability=unknown과 동시 발생 시 'motion-warmup'으로 차단.
   */
  motionStationary?: boolean | undefined,
  /**
   * #903 (Seam G) + #921 — 기압계 신호 묶음.
   * - `subsurface`: dP/dt가 지하 진입을 시사하는지. true면 GPS-only 결과는 'gps-only-underground'로
   *   confidence 강등해 stationAlarm의 early/transfer phase 발사를 보류. sticky motion unlock과 동일.
   *   useNearestStation으로도 함께 prop drilling. 미전달이면 graceful (기압계 미지원/권한 거절 호환).
   * - `signal`: subsurface+stop을 모두 담은 전체 신호 — fusion(B1 후속 PR) 입력. 미전달이면 fusion
   *   'barometer-stop' 입력 unavailable로 흐른다(다른 신호로 합의 가능). subsurface와 분리한 이유:
   *   subsurface는 cascade 강등에 즉시 결합, signal은 측정 단계 분리.
   *
   * S107 회피를 위해 단일 객체로 묶었다. 어느 한 키만 줘도 됨.
   */
  barometer?: { subsurface?: boolean; signal?: BarometerSignal },
): UseFusedNearestStationReturn {
  const barometerSubsurface = barometer?.subsurface;
  const barometerSignal = barometer?.signal;
  const gps = useNearestStation({ barometerSubsurface });
  // #733 — 위치 이력 기반 정적 판정. shouldDowngradeFusion이 speed=null일 때 fallback으로 사용.
  // useNearestStation의 userLocation 변경마다 자동 누적/판정.
  const positionStability = usePositionStability(gps.userLocation);

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

  // #1017: arcStations를 trackTrainProgress forward-only 가드에 넘기기 위해 trainProgress 이전에 선언.
  // 기존 arcStations useMemo(ADR-008 estimator용)는 아래에서 이 값을 재사용한다.
  const arcStations = useMemo<Station[]>(() => {
    if (!routeContext || !routeContext.origin || !routeContext.destination) return [];
    const arc = computeRouteArc(
      routeContext.route,
      routeContext.origin,
      routeContext.destination,
    );
    return arc?.stations ?? [];
  }, [routeContext]);

  const trainProgress = useMemo(
    () =>
      trackTrainProgress({
        candidates: candidateTrains,
        userLocation: gps.userLocation,
        lastConfirmedTrainNo: lastConfirmedTrainNoRef.current,
        // #1017 forward-only 가드 — boardingLock이 있을 때만 적용.
        segmentStations: boardingLock ? arcStations : undefined,
        boardingStationId: boardingLock?.boardingStationId,
      }),
    [candidateTrains, gps.userLocation, boardingLock, arcStations],
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
    // #1016 hole (a): userLocation 없으면 distanceKm=0 placeholder 대신 null 반환.
    // placeholder는 거리 게이트를 자동 통과시켜 GPS가 전혀 없는 상태에서도 position-train이
    // 채택되는 hole을 만든다. userLocation 없으면 거리 sanity 자체가 불가하므로 강등.
    if (!gps.userLocation) return null;
    const station = trainProgress.currentStation;
    const distanceKm = haversine(gps.userLocation.lat, gps.userLocation.lng, station.lat, station.lng);

    // #445 TTL: trainProgress가 신선해야 함. stale하면 강등.
    // ref가 0이면 effect가 첫 ts를 commit하기 전 — useMemo는 pure하게 두기 위해 면제.
    if (
      lastProgressTsRef.current !== 0 &&
      Date.now() - lastProgressTsRef.current > POSITION_TRAIN_TTL_MS
    ) {
      return null;
    }
    // #444 거리 sanity — fused/route와 공통 헬퍼 재사용.
    // #1016 hole (b): boardingLock 활성 시 lockActive=true로 accuracy>200m bypass 거부.
    const candidate = { station, distanceKm };
    if (
      !passesFusionDistanceGate({
        candidate,
        userLocation: gps.userLocation,
        accuracyMeters: gps.accuracyMeters,
        gpsNearest: candidates[0],
        maxAbsoluteKm: MAX_FUSION_DISTANCE_KM,
        maxDeltaKm: MAX_FUSION_DELTA_KM,
        lockActive: boardingLock != null,
      })
    ) {
      return null;
    }
    // #662: BoardingLock 활성 시 trainProgress가 lock의 노선과 다르면 강등.
    // 환승역 정지(speed≈0)에서 trackTrainProgress가 옆 노선 통과 열차에 잠기는 케이스 방어 —
    // 사용자가 명시적으로 탭한 열차(lock.boardingLine, #663으로 정확)를 source of truth로 신뢰.
    // lock 없으면 (lock 생성 전 일반 trip) 기존 동작 유지.
    if (boardingLock && station.line !== boardingLock.boardingLine) {
      return null;
    }
    // #1016 hole (c): lock 활성 시 arc window 내 역만 허용.
    if (boardingLock && !isWithinArcWindow(arcStations, station.id, boardingLock.boardingStationId)) {
      return null;
    }
    return candidate;
  }, [trainProgress, gps.userLocation, gps.accuracyMeters, candidates, boardingLock, arcStations]);

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
  // #662: BoardingLock 활성 시 fused도 lock.boardingLine과 다른 노선이면 강등 — positionTrain과
  // 동일 정신. 환승역에서 GPS 후보가 두 노선 모두 잡아 fused가 옆 노선으로 fusion되는 케이스 방어.
  // race: createTransferLock으로 lock이 새 leg로 교체되는 순간 1 render cycle 동안 옛 lock 기준
  // 강등이 일어나 source가 한 번 gps로 flash 가능 — UX 임팩트 미미해 현재는 수용.
  const fusedPasses =
    fused != null &&
    passesFusionDistanceGate({ ...gateOpts, candidate: fused.result }) &&
    (!boardingLock || fused.result.station.line === boardingLock.boardingLine);
  // routeResult는 route arc(단일 노선 segment) 위 진행도라 옆 노선 station이 들어올 수 없음 → 가드 불필요.
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

  // ADR-008 stationProgressEstimator — 시간 적분 → 관측 구동 전환 (#739).
  // arc상 추정 위치가 현 채택된 결과보다 앞이거나, 채택 결과가 arc 밖이면 override.
  // 채택 결과가 더 앞이면 그대로(실제 신호 우선) — 역행 방지(monotone forward).
  // confidence/source는 #584 PR D2의 'boarding-lock'(position-train + trainCode 매칭)과
  // 구분하기 위해 'boarding-lock-interp' 별도 라벨 사용 — 측정·디버그 인프라에서 구분 가능.
  // arcStations는 positionTrainResult의 (c) 게이트가 참조하므로 위에서 미리 산출됨.

  // estimator/anchor에 넘기는 trainProgress는 fusion 게이트(TTL + distance)를 통과한 것만 신선 신호로 인정.
  // positionTrainResult가 null이면 trainProgress는 stale이거나 게이트 탈락 — Strategy ①(LivePosition)이
  // stale 좌표를 신선 관측으로 채택해 lastObserved 앵커를 과거 위치로 박는 사고 방지(#739 P1).
  const freshTrainProgress = positionTrainResult != null ? trainProgress : null;

  // ReanchoredHop 앵커 — LivePosition이 lock.trainCode와 매칭되며 arc 위에 있을 때마다 갱신.
  // 폴링 1회마다 앵커가 새로 찍히므로 LivePosition이 끊긴 dead zone에서도 보간 구간이 최대 1 hop.
  // ref로 보존 — LivePosition 끊긴 후에도 마지막 실관측을 estimator에 전달.
  const lastObservedRef = useRef<{ arcIndex: number; observedAtMs: number } | null>(null);
  useEffect(() => {
    if (!freshTrainProgress) return;
    if (lockedTrainCode == null) return;
    if (freshTrainProgress.trainNo !== lockedTrainCode) return;
    if (arcStations.length === 0) return;
    const idx = arcIndexOfStation(arcStations, freshTrainProgress.currentStation);
    if (idx === -1) return;
    lastObservedRef.current = { arcIndex: idx, observedAtMs: Date.now() };
  }, [freshTrainProgress, lockedTrainCode, arcStations]);

  // boardingLock이 release/교체되면 앵커도 리셋 — 이전 trip 관측이 새 trip에 흘러가는 것 방지.
  // race: createTransferLock으로 lock이 새 leg로 교체되는 순간 1 cycle 옛 앵커가 새 arc에 매칭될
  // 위험이 있으나, lock 자체 변화로 effect가 트리거되며 다음 render에서 새 앵커로 갱신된다.
  const prevLockKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = boardingLock
      ? `${boardingLock.trainCode}|${boardingLock.boardedAt}`
      : null;
    if (prevLockKeyRef.current !== key) {
      lastObservedRef.current = null;
      prevLockKeyRef.current = key;
    }
  }, [boardingLock]);

  // Strategy ②(ArrivalEta) 입력 — 신규 폴링 신설 금지(#745). currentIdxHint는 마지막 LivePosition
  // 관측(lastObservedRef) 또는 채택된 estimate의 직전 idx로 자연스럽게 흐른다. 본 hook은
  // lastObservedRef를 진입점으로 사용 — ①이 마지막에 본 위치를 기준으로 "다음 역"을 산정.
  // null이면 ② skip(estimator 내부 처리).
  const currentIdxHint = lastObservedRef.current?.arcIndex ?? null;
  const nextStationOnArc =
    currentIdxHint != null && currentIdxHint + 1 < arcStations.length
      ? arcStations[currentIdxHint + 1]
      : null;
  const nextStationArrivals = pickArrivalsForStation(nextStationOnArc, [
    { stationName: c0, line: h0, arrival: a0.arrival },
    { stationName: c1, line: h1, arrival: a1.arrival },
    { stationName: c2, line: h2, arrival: a2.arrival },
  ]);

  // useMemo로 감싸면 deps가 시간을 포함하지 않아 부모 리렌더가 없는 동안 stale.
  // estimator는 분기·정수 산술 위주 — render마다 직접 계산해도 무비용.
  // ADR-008 Stage 3(#779): boardingLock의 leg 노선(`boardingLine`)을 캡슐화한 hop time lookup을
  // estimator에 주입. lock이 없으면 estimator 자체가 비활성이므로 boardingLine은 lock present 시점에만
  // 의미가 있다 — null 분기에서는 fallback closure(uniform HOP_TIME_MS)를 넘겨 estimator의 ③④가
  // 호출되더라도 안전하게 종료(lock null 가드에서 이미 차단).
  const lockedLine = boardingLock?.boardingLine ?? null;
  const hopTimeMsForHop = lockedLine
    ? (fromIdx: number) => hopTimeMsAt(arcStations, fromIdx, lockedLine)
    : /* istanbul ignore next — estimator는 lock null이면 line 245에서 early return하므로 sentinel 도달 불가 */
      () => Number.POSITIVE_INFINITY;
  const estimate = estimateStationProgress({
    lock: boardingLock ?? null,
    arcStations,
    now: Date.now(),
    trainProgress: freshTrainProgress,
    lockedTrainCode: lockedTrainCode ?? null,
    lastObserved: lastObservedRef.current,
    hopTimeMsForHop,
    nextStationArrivals,
    arrivalEtaTtlMs: POSITION_TRAIN_TTL_MS,
    currentIdxHint,
  });

  // #662 invariant: estimate가 boardingLock이 active일 때만 만들어지고 arcStations(route segment)
  // 위로만 전진하므로 lock.boardingLine 외 노선이 들어올 수 없음 — #662 가드 별도 적용 불필요.
  //
  // ADR-008 #739 — monotone forward 가드 유지.
  // 'station-passed' 알람은 lastNotifiedStationId로 dedup하나, 통과한 역 id가 바뀌면 새 알람을 발사한다.
  // backward 정정 허용 시 이미 통과한 역의 알람이 재발사되어 사용자 혼란. ReanchoredHop이 적분을 1 hop으로
  // 제한해 잘못된 forward를 구조적으로 막으므로 forward 가드만으로도 ADR §원인 ③의 누적 drift는 해소된다.
  // LivePosition으로 fusion 자체가 이미 정정되는 경우(positionTrainResult branch)에는 estimator override
  // 자체가 일어나지 않으므로 backward 정정 손실 없음.
  if (estimate && arcStations.length > 0) {
    const chosenIdx = arcIndexOfStation(arcStations, result?.station ?? null);
    // Seam B (#898): hop-time 적분 전략(③④)에 forward observation ceiling 적용 —
    // LivePosition/ArrivalEta dead-zone에서 적분이 물리 위치보다 앞서 발산하면 알람·LA·위젯이
    // 모두 잘못된 "다음 역"을 소비(2026-06-05 13:19 transfer/early/건대입구 fired @ 성수).
    // 실시간 신호(①LivePosition·②ArrivalEta) 외 모든 strategy는 cap 대상 — 부정형 분기로
    // 신규 strategy(Seam G 등)가 추가될 때 기본 cap 적용 되도록 안전 방향 디폴트.
    const isInterpolated =
      estimate.strategy !== 'live-position' && estimate.strategy !== 'arrival-eta';
    let withinObservationCeiling = true;
    if (isInterpolated) {
      // positionTrainResult non-null → freshTrainProgress non-null → tryLivePosition='live-position' →
      // isInterpolated=false → 이 블록 도달 불가. positionTrainResult는 항상 null.
      // 향후 새 전략(non-live/non-arrival)이 추가될 때를 대비한 future-proofing.
      const livePositionIdx = /* istanbul ignore next */ positionTrainResult
        ? /* istanbul ignore next */ arcIndexOfStation(arcStations, positionTrainResult.station)
        : -1;
      const reanchoredObservedIdx = lastObservedRef.current?.arcIndex ?? -1;
      // estimate가 non-null이면 boardingLock도 non-null(estimator 245 가드) — false branch 도달 불가.
      const boardingIdx = boardingLock
        ? arcStations.findIndex((s) => s.id === boardingLock.boardingStationId)
        : /* istanbul ignore next */ -1;
      const lastRealObservedIdx = Math.max(
        livePositionIdx,
        reanchoredObservedIdx,
        boardingIdx,
      );
      withinObservationCeiling = estimate.index <= lastRealObservedIdx + 1;
    }
    if ((chosenIdx === -1 || estimate.index > chosenIdx) && withinObservationCeiling) {
      const distanceKm = gps.userLocation
        ? haversine(
            gps.userLocation.lat,
            gps.userLocation.lng,
            estimate.station.lat,
            estimate.station.lng,
          )
        : 0;
      result = { station: estimate.station, distanceKm };
      confidence = 'boarding-lock-interp';
      source = 'boarding-lock-interp';
    }
  }

  // #727 정적 misfire 가드 — shouldDowngradeFusion이 isStaticSpeedSignal + confidence가 fusion
  // 승격 라벨(position-train / boarding-lock / boarding-lock-interp / arrival-arriving #733)인지 한 번에 평가.
  // 정적+accuracy 정상이면 gps-only로 강등 + result/source도 GPS 원본으로 되돌림.
  //
  // #733 — speedMps=null인 정적 사용자(iOS Core Location 미보고) 케이스에 positionStability 신호 fallback.
  if (
    shouldDowngradeFusion({
      confidence,
      speedMps: gps.speedMps,
      accuracyM: gps.accuracyMeters,
      positionStability,
      motionStationary,
    })
  ) {
    confidence = 'gps-only';
    source = 'gps';
    result = gps.result;
  }

  // #903 (Seam G) — GPS-only 결과인데 기압계 dP/dt가 지하 진입을 시사하면 'gps-only-underground'로 강등.
  // 지하 GPS fix는 wifi/cell 삼각측량 fallback이 보고된 좌표일 가능성이 높아 stationAlarm 게이트에서
  // early/transfer 알람 발사를 별도 정책으로 보류. source는 그대로 'gps' — 신호원 자체는 동일.
  // 다른 confidence(position-train / boarding-lock / arrival-*)는 강등하지 않음 — 본인의 검증 신호로 우선.
  if (confidence === 'gps-only' && barometerSubsurface === true) {
    confidence = 'gps-only-underground';
  }

  // #921 — 신호 fusion(barometer-stop + motion-stationary + arvlcd-arrived) wire-up.
  // 본 PR에서는 cascade 비결합 — verdict만 측정 entry에 첨부. 후속 PR(별도 이슈)에서 cascade 결합.
  //
  // arrival 입력: 채택된 result의 station name과 매칭되는 후보 슬롯의 arrival을 사용. result가
  // 어떤 후보(c0/c1/c2)에서 왔든 같은 station name이면 한 슬롯에서 lockedTrainCode를 찾을 수 있다.
  // 매칭 슬롯이 없으면 (route-progress/interp 결과가 GPS top-3 밖) arrival=null → arvlcd 입력
  // unavailable로 흐른다.
  const fusionArrival = result
    ? pickArrivalForStationName(result.station.name, result.station.line, [
        { stationName: c0, line: h0, arrival: a0.arrival },
        { stationName: c1, line: h1, arrival: a1.arrival },
        { stationName: c2, line: h2, arrival: a2.arrival },
      ])
    : null;
  const detectionInput = useMemo(
    () => ({
      barometer: barometerSignal ?? null,
      motionStationary,
      arrival: fusionArrival,
      lockedTrainCode: lockedTrainCode ?? null,
    }),
    [barometerSignal, motionStationary, fusionArrival, lockedTrainCode],
  );
  const detectionVerdict = useFusedStationDetection(detectionInput);

  // 측정(#443): 결정 변화(source/stationId/confidence) 시에만 push.
  // render 중 side-effect 회피 + 의존성 누락 은폐 회피를 위해 결정 key를 ref로 비교.
  //
  // #963 — signalMask까지 포함해 신호 조합 변화(motion/barometer/arvlcd flip)도 별도 entry로
  // 보존. 이전엔 source/confidence/stationId만 비교해 같은 결정 안에서 신호 변화가 측정 데이터에서
  // 누락됐다 (PR #944 P1.2 follow-up).
  const lastDecisionKeyRef = useRef<string | null>(null);
  const resultStationId = result?.station.id ?? null;
  const decisionKey = `${source}|${confidence}|${resultStationId}|${detectionVerdict.signalMask}`;
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
      // #921 — 신호 fusion verdict. signalsAvailable=0이면 입력 자체가 없었음(null로 기록).
      detectionSignals:
        detectionVerdict.signalsAvailable === 0
          ? null
          : {
              detected: detectionVerdict.detected,
              confidence: detectionVerdict.confidence,
              signalsAgreed: detectionVerdict.signalsAgreed,
              signalsAvailable: detectionVerdict.signalsAvailable,
            },
    });
  }, [decisionKey, source, confidence, result, positionTrainResult, fused, routeResult, gps.result, gps.accuracyMeters, trainProgress, lockedTrainCode, detectionVerdict]);

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
    gpsActive: gps.gpsActive,
    lastFixAtMs: gps.lastFixAtMs,
    positionStability,
    estimatorStrategy: estimate?.strategy ?? null,
    refresh: gps.refresh,
  };
}
