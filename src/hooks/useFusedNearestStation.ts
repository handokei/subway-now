import { useEffect, useMemo, useRef } from 'react';
import {
  pushFusionDebugEntry,
  type FusionCandidateMini,
} from '../utils/fusionDebugBuffer';
import { useNearestStation } from './useNearestStation';
import { useArrivalInfo } from './useArrivalInfo';
import { useTrainPositions } from './useTrainPositions';
import { useRouteProgress } from './useRouteProgress';
import { usePositionStability } from './usePositionStability';
import { findTopNearestStations } from '../utils/findNearestStation';
import { findActiveLines } from '../utils/findActiveLines';
import { pickFusedStation, type FusionConfidence, type FusionSource } from '../utils/pickFusedStation';
import { shouldDowngradeFusion } from '../utils/movementGate';
import type { PositionStability } from '../utils/positionStaticDetector';
import { pickCandidateTrains, type CandidateTrain } from '../utils/pickCandidateTrains';
import { trackTrainProgress } from '../utils/trackTrainProgress';
import { haversine } from '../utils/haversine';
import { passesFusionDistanceGate } from '../utils/fusionDistanceGate';
import { computeRouteArc } from '../utils/routeProgress';
import {
  arcIndexOfStation,
  estimateStationProgress,
} from '../utils/stationProgressEstimator';
import { HOP_TIME_MS } from '../constants/boardingLock';
import { MAX_STATION_DISTANCE_KM } from '../constants/location';
import {
  MAX_ACTIVE_LINES,
  MAX_FUSION_DELTA_KM,
  MAX_FUSION_DISTANCE_KM,
  POSITION_TRAIN_TTL_MS,
} from '../constants/realtime';
import type { LinePositions } from '../api/positionApi';
import type { ArrivalInfo, StationArrival } from '../api/arrivalApi';
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
  /**
   * #733 — 위치 이력 기반 정적/이동/판정불가. iOS가 speed=-1(미측정)을 보고하는 정적 케이스에서
   * movementGate fallback 신호로 사용. 호출자(useStationAlarm 등)가 evaluateMovement에 전달해
   * speed 부재 시에도 정적 misfire 차단을 가능하게 한다.
   */
  positionStability: PositionStability;
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
   */
  motionStationary?: boolean,
): UseFusedNearestStationReturn {
  const gps = useNearestStation();
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
    // #662: BoardingLock 활성 시 trainProgress가 lock의 노선과 다르면 강등.
    // 환승역 정지(speed≈0)에서 trackTrainProgress가 옆 노선 통과 열차에 잠기는 케이스 방어 —
    // 사용자가 명시적으로 탭한 열차(lock.boardingLine, #663으로 정확)를 source of truth로 신뢰.
    // lock 없으면 (lock 생성 전 일반 trip) 기존 동작 유지.
    if (boardingLock && station.line !== boardingLock.boardingLine) {
      return null;
    }
    return candidate;
  }, [trainProgress, gps.userLocation, gps.accuracyMeters, candidates, boardingLock]);

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
  const arcStations = useMemo<Station[]>(() => {
    if (!routeContext || !routeContext.origin || !routeContext.destination) return [];
    const arc = computeRouteArc(
      routeContext.route,
      routeContext.origin,
      routeContext.destination,
    );
    return arc?.stations ?? [];
  }, [routeContext]);

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
    { stationName: c0, arrival: a0.arrival },
    { stationName: c1, arrival: a1.arrival },
    { stationName: c2, arrival: a2.arrival },
  ]);

  // useMemo로 감싸면 deps가 시간을 포함하지 않아 부모 리렌더가 없는 동안 stale.
  // estimator는 분기·정수 산술 위주 — render마다 직접 계산해도 무비용.
  const estimate = estimateStationProgress({
    lock: boardingLock ?? null,
    arcStations,
    now: Date.now(),
    trainProgress: freshTrainProgress,
    lockedTrainCode: lockedTrainCode ?? null,
    lastObserved: lastObservedRef.current,
    hopTimeMs: HOP_TIME_MS,
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
    if (chosenIdx === -1 || estimate.index > chosenIdx) {
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
    positionStability,
    refresh: gps.refresh,
  };
}
