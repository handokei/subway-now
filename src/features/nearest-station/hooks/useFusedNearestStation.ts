/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  pushFusionDebugEntry,
  type FusionCandidateMini,
} from '../utils/fusionDebugBuffer';
// #1902 (RC-18) — candidate reject 별 buffer. fusionDebugBuffer 200 cap 점령 자기 파괴 차단.
import { pushCandidateRejectEntry } from '../utils/candidateRejectBuffer';
// #1896 (RC-8) — boarding-lock drift 별 buffer. stuck 시나리오에서 매 cycle push되는 entry가
// fusionDebugBuffer를 점령하는 self-pollution 차단 (candidateRejectBuffer 패턴 동일).
import { pushBoardingLockDriftEntry } from '../utils/boardingLockDriftBuffer';
import { pushRawSignal, type MotionLabel } from '../../observability/utils/rawSignalBuffer';
import { getCurrentCellularTech } from '../utils/cellularTech';
import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';
import { pushEstimatorEntry } from '../../route/utils/estimatorDebugBuffer';
import { useNearestStation } from './useNearestStation';
import { useCellularTech } from './useCellularTech';
import { useAccelerometerFingerprint } from './useAccelerometerFingerprint';
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
import { estimateArcStationsFromRoute } from '../../route/utils/arcEstimation';
import {
  logFusionCandidateDistanceReject,
  logFusionCandidateLineReject,
  logFusionPickerTier,
  logSuppressedLocklessForwardOnly,
} from '../../alarm/utils/alarmLog';
import { haversine } from '../../../shared/utils/haversine';
import { findStationByName, findStationByNameAndLine } from '../../../shared/utils/stationLookup';
import { isWithinArcWindow, passesFusionDistanceGate } from '../utils/fusionDistanceGate';
import {
  checkStationProgression,
  requiresPositionTrainConsensus,
} from '../utils/positionTrainConsensus';
import { surfaceSSOTConsensus } from '../utils/surfaceSSotConsensus';
import { undergroundSSOTConsensus } from '../utils/undergroundSSotConsensus';
import { inferEnvironment, type Environment, type InferEnvironmentResult } from '../utils/inferEnvironment';
import { recordEnvironmentTransition } from '../../../shared/infra/monitoring/breadcrumb';
import { computeRouteArc } from '../../route/utils/routeProgress';
import {
  arcIndexOfStation,
  estimateStationProgress,
} from '../../route/utils/stationProgressEstimator';
import { hopTimeMsAt } from '../../route/utils/hopTime';
import { getTripStartedAt } from '../../alarm/utils/tripStartStorage';
import {
  readBackendSsotMirror,
  type BackendSsotMirrorEntry,
} from '../../alarm/utils/backendSsotMirror';
import { MAX_STATION_DISTANCE_KM } from '../../../shared/constants/location';
import { ARRIVAL_CODE } from '../../../shared/constants/arrivalCodes';
import {
  ARVL_CD_ARRIVED_MAX_AGE_MS,
  BACKEND_SSOT_MIRROR_MAX_AGE_MS,
  CANDIDATE_ANCHOR_WINDOW_DEFAULT,
  CANDIDATE_ANCHOR_WINDOW_EXPANDED,
  CANDIDATE_REJECT_ANCHOR_EXPAND_THRESHOLD,
  DETECTION_FUSED_MAX_DISTANCE_KM,
  GPS_DERIVED_ACCURACY_MAX_M,
  GPS_DERIVED_FIX_MAX_AGE_MS,
  GPS_DERIVED_ROUTE_MATCH_MAX_KM,
  GPS_FALLBACK_STALE_MAX_AGE_MS,
  LOCK_GPS_DRIFT_THRESHOLD_M,
  MAX_ACTIVE_LINES,
  MAX_FUSION_DELTA_KM,
  MAX_FUSION_DISTANCE_KM,
  PICKER_HOP_ANOMALY_THRESHOLD,
  PICKER_STUCK_MAX_AGE_MS,
  POSITION_TRAIN_TTL_MS,
  WIFI_SSID_MAX_DISTANCE_KM,
} from '../../../shared/constants/realtime';
import { hopsOnLine } from '../../../shared/utils/lineLoopPath';
import type { LinePositions } from '../api/positionApi';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { LineNumber, NearestStationResult, Station } from '../../../shared/types/station';
import type { ArrivalProvider } from '../../../shared/types/providers';
import type { PositionProvider } from '../providers/types';
import {
  allowedLinesFromRoute,
  getStationById,
  getStationsOnLine,
  type Route,
} from '../../../shared/utils/stationRoute';

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
  /**
   * #1568 (T8b, Epic ADR-017 #1553) — sticky override 없는 raw GPS 최근접.
   *
   * 위젯 mirror(useWidgetMirror)는 본 값을 사용해 sticky:locked가 위젯에 stuck되는 회귀를 차단한다.
   * fire path 채택 SSOT는 본 hook의 `result`(cascade 산출). 본 필드는 표시·sticky 격리 전용.
   * 미정의 시 null (GPS dead zone 또는 권한 미부여).
   */
  liveResult: NearestStationResult | null;
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
  /**
   * #1208 (Epic #1204 D2) — 현재 채택된 estimator의 arc 위 hop index.
   * useStationAlarm이 station-passed 게이트(`isStationWithinHopWindow`)의 SSOT로 사용.
   * #1235 (D9 wire) — DebugModal Trip 섹션 currentHopIndex row의 SSOT도 동일.
   * estimator 미채택 시 null — 호출자가 firedAlarms 등의 fallback으로 추정.
   *
   * #1437 (E4 / ADR-015 §2) — 시간 적분 strategy(default-hop / lockless-route-hop / reanchored-hop)는
   * 본 필드에서 박탈된다(null로 노출). 시간 적분이 fire path 게이트의 SSOT가 되면
   * 사용자 실제 위치를 추월해 false station-passed fire/dedup 누적 회귀를 일으킨다.
   * UI 추적용으로는 displayOnlyEstimate를 사용.
   */
  currentHopIndex: number | null;
  /**
   * #1437 (E4 / ADR-015 §2) — estimator 결과의 표시 전용 채널.
   * DebugModal/UI 위치 추적용. fire path는 본 필드를 읽지 않는다 (시간 적분 결과의 fire 권한 박탈).
   * 모든 strategy(live-position / arrival-eta / reanchored-hop / default-hop / lockless-route-hop)가
   * 그대로 노출돼 디버그 인프라에서 strategy 라벨 추적이 가능하다.
   */
  displayOnlyEstimate: {
    station: Station;
    strategy: import('../../route/utils/stationProgressEstimator').StationProgressStrategy;
    index: number;
  } | null;
  /**
   * #1208 — 현재 trip의 arc(탑승역~다음 waypoint) station 배열.
   * useStationAlarm의 hop window 게이트 입력 및 firedAlarms 기반 fallback hop 계산용.
   * #1235 (D9 wire) — DebugModal Trip 섹션 route hop count row가 length로 사용.
   * route/trip 없으면 빈 배열.
   */
  arcStations: readonly Station[];

  /**
   * #1235 (D9 wire) — useFusedStationDetection이 산출한 verdict.confidence.
   * 'high' | 'medium' | 'low'. signalsAvailable=0이어도 항상 정의된다.
   */
  detectionTier: import('../../../shared/utils/stationDetectionFusion').StationDetectionConfidence;
  /**
   * #1235 (D9 wire) — useFusedStationDetection이 산출한 signalMask 문자열.
   * 신호 미주입 시 빈 문자열.
   */
  detectionSignalMask: string;
  /**
   * #1235 (D9 wire) — 호출자가 주입한 barometer.subsurface 패스스루.
   * 미전달이면 undefined.
   */
  subsurface: boolean | undefined;
  /**
   * #1290 — 지하(subsurface=true) + fusion verdict detected(≥2 신호 합의) + 역 근접 게이트 통과.
   * true일 때 호출자는 GPS/arrival 독립적으로 station-passed 발사 트리거로 사용 가능.
   * false positive 방어: ≥2 신호 합의(barometer-stop/motion-stationary/arvlcd-arrived)
   * + result.distanceKm ≤ MAX_FUSION_DISTANCE_KM 근접 게이트 동시 충족 필요.
   */
  subsurfaceStationDetected: boolean;
  /**
   * #1817 — 현재 estimator strategy가 시간 적분(lockless-route-hop / default-hop / reanchored-hop)인지.
   * true이면 fusion station이 GPS 실관측 station과 다를 수 있어 destination/transfer early fire 차단.
   * useStationAlarm이 phase ETA effect 진입 게이트로 사용한다.
   */
  estimatorIsTimeIntegration: boolean;
  /**
   * #1401 (Epic #1396 sub 5/6) — 직전 tick 대비 fusion result가 arc 위에서 advance(idx 증가)했는지.
   * true일 때 호출자(useStationAlarm/silentPushTask/backgroundLocationTask)는 evaluateMovement에
   * trainProgressing=true로 전달해 device 모션/GPS speed 정적 신호 가드를 우회시킨다.
   *
   * 판정 조건(모두 충족):
   *   1. arcStations.length > 0 (활성 trip)
   *   2. 직전 tick에 채택된 result의 arc idx가 있었음 (첫 tick은 false)
   *   3. 현재 result의 arc idx > 직전 arc idx
   *
   * forward-only(idx 증가만). idx 감소/동일은 false.
   * arcKey(trip arc id pair) 변경 시 리셋 — 새 trip의 첫 tick은 false.
   *
   * false positive 방어:
   *   - arc는 명시적 trip 경로(origin→destination, 또는 transfer leg) 위 station 배열 — 자유 fusion이
   *     아니라 lock/origin/destination 컨텍스트가 산출한 segment. arc 위에서 idx가 증가하는 건
   *     사용자가 실제 진행했거나, 잘못된 lock으로 인한 false advance 둘 중 하나인데, 후자는 #1400
   *     (route/lock 정확성)이 일차 방어선. 본 게이트는 device 신호의 *잘못된 정적 판정*을 무효화하는
   *     것이지 lock 무결성을 보장하지 않는다 — ADR-010 두 실패 모드 동급 원칙에 따른 분리 책임.
   */
  trainProgressing: boolean;
  /**
   * #1418 — fusion arbitration이 추정한 환경.
   * 'surface' / 'underground' / 'unknown'. DebugModal Environment Inference 섹션 표시용.
   */
  environment: Environment;
  /**
   * #1860 — 옵션 C barometer-stop 힌트 발동 원인.
   * 'barometer-stop' = tripActive + barometerStop=true + subsurface=false + SSOT 없음 조합.
   * undefined이면 힌트 없음. DebugModal environment 라인에 함께 노출.
   */
  environmentHintReason: InferEnvironmentResult['hintReason'];
  /** #1418 — 지상 Tier 1 SSOT(GPS+Arrival) 합의 활성 여부. */
  surfaceSSOTActive: boolean;
  /** #1418 — 지하 Tier 1 SSOT(WiFi/Position-Train + Arrival) 합의 활성 여부. */
  undergroundSSOTActive: boolean;
  /**
   * #1421 — PR-AutoLock-1 측정 인프라. SSOT 합의 객체 그대로 노출 (boolean만으로는 trainCode/
   * stationId가 누락돼 device-side auto-lock candidate 산출이 불가). DebugModal Auto-lock 섹션이
   * 직접 inferAutoLockCandidate에 넘긴다. 본 PR은 측정만 — lock 산출/sync 호출 없음.
   */
  surfaceSSOT: { station: import('../../../shared/types/station').Station; trainCode: string } | null;
  undergroundSSOT: { station: import('../../../shared/types/station').Station; trainCode: string } | null;
  /**
   * #1486 (ADR-015 §2) — sticky lock 정보 표시 전용 채널 (useNearestStation 패스스루).
   *
   * sticky lock 활성 시 lock된 station만 노출. 비활성/없음 시 null.
   * fire path 진입 금지 — DebugModal/UI 추적 신호 표시에만 사용.
   *
   * displayOnlyEstimate(estimator 표시 채널)와 같은 패턴: 시간 적분/jitter 흡수 신호는
   * fire path SSOT(result/confidence/source)에서 분리되어 표시 채널로만 노출된다.
   */
  stickyDisplayOnly: import('../../../shared/types/station').Station | null;
  /**
   * #1621 (Phase B) — backend SSoT mirror가 fresh일 때 currentStationId, 미존재/stale일 때 null.
   *
   * `useV1MismatchDetector(uiCurrentStationId, ssotCurrentStationId)`의 두 번째 입력.
   * cascade picker 내부 polling(5s)을 재사용해 별도 폴링 중복 방지 — consumer는 이 값만 받으면
   * V1 mismatch 자동 측정에 충분.
   */
  backendSsotCurrentStationId: string | null;
  /**
   * #1678 — CMMotionManager 60s window RMS magnitude 분류 결과.
   * DebugModal Fusion 섹션 + raw signal dump motion 필드의 SSOT.
   * 'automotive' = train 진동 env vote 1표, 'unknown' = 미수렴/미지원.
   * EAS rebuild 전에는 native module이 없어 항상 'unknown'.
   */
  accelerometerPattern: import('../utils/accelerometerFingerprint').AccelerometerPattern;
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
  /**
   * #1286 — useWifiStation이 반환한 SSID 매칭 결과.
   * barometerSubsurface===true(지하 GPS dead zone)일 때 fusion cascade 최우선으로 채택.
   * 지상 / no-match(null)이면 기존 cascade로 자연 fallback.
   *
   * 환승역 호선 해소: wifiSsidLookup은 역명으로 첫 번째 호선의 Station을 반환하므로,
   * boardingLock.boardingLine 또는 routeContext로 호선을 보정한다.
   * 교차 신호가 없으면 lookupStationBySsid 결과 그대로 채택(단일 호선 역 / 호선 미확정).
   */
  wifiStation?: Station | null,
  /**
   * #1677 — silent push 건강 상태 (useSilentPushHealthCheck 출력).
   *
   * false 시 `backendSsotAccepts` 강제 false — backend SSoT mirror tier를 cascade에서 제거.
   * 기존 tier(wifi / positionTrain / fused / gps)가 자연 fallback.
   *
   * 미전달(undefined) = 기존 동작 유지(healthy로 간주).
   * true 또는 undefined = `backendSsotAccepts` 판정에 영향 없음.
   *
   * 정책 정합:
   * - 신규 폴링 추가 없음 — 기존 arrival/position 30s cycle 그대로.
   * - FG 상태에서만 효과 — BG에서는 silentPushHealthy를 true로 유지(호출자 책임).
   * - backendSsotAccepts=false이므로 backend mirror가 fresh여도 cascade 채택 안 함.
   */
  silentPushHealthy?: boolean,
): UseFusedNearestStationReturn {
  const barometerSubsurface = barometer?.subsurface;
  const barometerSignal = barometer?.signal;
  // D6 (#1212) — trip 활성(origin+destination+route 모두 채워진 상태)을 sticky 게이트에 전달.
  // routeContext는 HomeScreen에서 trip 시작 시 채워지고 종료 시 undefined로 돌아간다.
  const tripActive = routeContext != null;
  const gps = useNearestStation({ barometerSubsurface, tripActive });
  // #733 — 위치 이력 기반 정적 판정. shouldDowngradeFusion이 speed=null일 때 fallback으로 사용.
  // useNearestStation의 userLocation 변경마다 자동 누적/판정.
  const positionStability = usePositionStability(gps.userLocation);

  // #1574 (ADR-017 T11) — CTRadioAccessTechnology 환경 vote. iOS BG에서도 동작
  // (CTServiceRadioAccessTechnologyDidChangeNotification observer). underground SSOT 4-signal
  // 합의의 환경-확정 vote로 사용. 미지원(Android/jest/web) 시 'unknown' 고정 → vote 미투표.
  const cellularEnvironmentVote = useCellularTech();

  // #1542 (ADR-016 S9) — CMMotionManager raw accelerometer 60s window RMS magnitude 분류.
  // 'automotive' (RMS ≥ 2.0 m/s²)이면 train 진동 환경 vote 1표 — undergroundSSotConsensus 5번째 signal.
  // BG location piggyback (backgroundLocationTask가 별 start 호출)로 BG에서도 동작.
  // V1 BG 지하 천장 70 → 90% (Transit App 90% / SubwayPS 학술 85% baseline).
  const accelerometerPattern = useAccelerometerFingerprint();

  // #1568 (T8b, Epic ADR-017 #1553) — backend SSoT mirror 폴링.
  //
  // silent push handler가 BACKEND_SSOT_MIRROR_KEY에 영속화한 권위 스냅샷을 읽어 cascade picker가
  // `backend-ssot` tier(최상위)로 채택할 수 있게 한다. 5s 간격 폴링 — backend는 cycle(~30s)마다
  // 발사하므로 충분히 빈번하며 매 render read를 피해 AsyncStorage I/O 폭주를 방지.
  // 미존재 / parse 실패 / staleness(60s 초과) 시 null로 두어 cascade는 기존 tier fallback (graceful).
  const [backendSsotMirror, setBackendSsotMirror] = useState<BackendSsotMirrorEntry | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      void readBackendSsotMirror().then((entry) => {
        if (cancelled) return;
        // 무의미한 state update로 인한 추가 render 방지 — receivedAt이 같으면 동일 entry.
        // 미존재(null) → 미존재(null) 전이도 setState skip.
        setBackendSsotMirror((prev) => {
          if (prev === null && entry === null) return prev;
          if (
            prev !== null &&
            entry !== null &&
            prev.receivedAt === entry.receivedAt &&
            prev.currentStationId === entry.currentStationId
          ) {
            return prev;
          }
          return entry;
        });
      });
    };
    // 첫 read는 5s interval 첫 tick에 맡긴다 — 마운트 직후 동기 read의 microtask resolve가
    // 첫 render commit phase와 겹쳐 act() warning을 발생시키는 회귀 차단(jest-expo setup).
    const id = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

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

  // #1436 — trip route에 포함된 노선 집합. 후보 단계에서 trip 외 노선 entry 차단.
  // trip 비활성(route 없음)이면 undefined → filter 미적용으로 자유 화면 동작 보존.
  const allowedLines = useMemo(
    () => allowedLinesFromRoute(routeContext?.route),
    [routeContext?.route],
  );

  // GPS 좌표 → 거리순 후보 N개. 좌표 갱신 시에만 재계산.
  const candidates = useMemo<NearestStationResult[]>(() => {
    if (!gps.userLocation) return [];
    return findTopNearestStations(
      gps.userLocation.lat,
      gps.userLocation.lng,
      FUSION_CANDIDATE_LIMIT,
      MAX_STATION_DISTANCE_KM,
      allowedLines,
    );
  }, [gps.userLocation, allowedLines]);

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

  // #1748 — candidate-reject 연속 카운트. 같은 noLine 5+ cycle 연속 reject → anchor window 2배 확장.
  // key: LineNumber, value: 연속 reject 횟수. 채택 성공 시 해당 line 카운트 리셋.
  const consecutiveRejectByLineRef = useRef<Map<string, number>>(new Map());

  const candidateTrains = useMemo<CandidateTrain[]>(() => {
    const lps: (LinePositions | null)[] = [p0.positions, p1.positions, p2.positions];
    const out: CandidateTrain[] = [];
    // #1616 (R12-a): candidate별 GPS 거리 hard gate. userLocation + line별 station 좌표 lookup을
    // pickCandidateTrains에 전달해 anchor GPS drift 시 잘못된 영역 train 후보 진입을 차단.
    // candidateRejectBuffer로 reject 측정 — DebugModal에서 'reject:candidate-distance' 표시.
    //
    // #1902 (RC-18): trip route 활성 line 필터. allowedLines(`allowedLinesFromRoute`)에 없는
    //   line은 enumerate 단계에서 차단해 무차별 후보 reject(T4 evidence: 5/6/7호선 + 공항철도 +
    //   경의중앙선 18건 mega-blast)와 fusionDebugBuffer 자기 점령을 차단. allowedLines undefined
    //   (trip 비활성/route 없음)일 때는 자유 화면 동작 보존(기존 fusion 흐름 그대로).
    //   환승역 cross-line은 `allowedLinesFromRoute`가 transfer.fromLine + toLine을 모두 포함하므로
    //   자연 허용 — paradigm Phase 4(호선 자동 전환) 정합.
    for (const lp of lps) {
      if (!lp) continue;
      if (allowedLines && !allowedLines.has(lp.line)) {
        // #1902 (RC-18) — trip route 외 line 후보를 enumerate 단계에서 차단.
        pushCandidateRejectEntry({
          kind: 'candidate-reject',
          ts: Date.now(),
          reason: 'candidate-line',
          line: lp.line,
        });
        // alarmLog mirror — `/admin/alarm-log-stats` 운영 가시성용.
        logFusionCandidateLineReject({ line: lp.line });
        continue;
      }
      const anchor = candidates.find((c) => c.station.line === lp.line)?.station.name;
      const lineStations = getStationsOnLine(lp.line);
      const stationCoordinates = new Map<string, { lat: number; lng: number }>(
        lineStations.map((s) => [s.name, { lat: s.lat, lng: s.lng }]),
      );
      // #1748 — 연속 reject 5+ cycle 시 anchor window 2배 확장.
      const rejectCount = consecutiveRejectByLineRef.current.get(lp.line) ?? 0;
      const windowStations =
        rejectCount >= CANDIDATE_REJECT_ANCHOR_EXPAND_THRESHOLD
          ? CANDIDATE_ANCHOR_WINDOW_EXPANDED
          : CANDIDATE_ANCHOR_WINDOW_DEFAULT;
      const picked = pickCandidateTrains({
        positions: [lp],
        line: lp.line,
        anchorStationName: anchor,
        windowStations,
        userLocation: gps.userLocation,
        stationCoordinates,
        onCandidateDistanceReject: (info) => {
          // #1748 — reject 카운트 누적 (useMemo 내부라 ref 직접 수정은 side-effect지만
          // 이 값은 다음 render cycle의 window 계산에만 사용 — 현재 render에 영향 없음).
          consecutiveRejectByLineRef.current.set(
            info.line,
            (consecutiveRejectByLineRef.current.get(info.line) ?? 0) + 1,
          );
          // #1902 — candidate-reject 별 buffer로 이전. fusionDebugBuffer 200 cap 보호.
          pushCandidateRejectEntry({
            kind: 'candidate-reject',
            ts: Date.now(),
            reason: 'candidate-distance',
            trainNo: info.trainNo,
            stationName: info.stationName,
            line: info.line,
            distanceKm: info.distanceKm,
          });
          // #1628 — alarmLog kind에도 mirror 적재. `/admin/alarm-log-stats`는 kind='alarmLog'만
          // 카운트하므로 R12-a reject 효과를 측정하려면 alarmLog 적재가 필수.
          logFusionCandidateDistanceReject({ stationName: info.stationName });
        },
      });
      // #1748 — 이번 cycle에 후보가 채택됐으면(reject 없이 통과) 해당 line 카운트 리셋.
      if (picked.length > 0) {
        consecutiveRejectByLineRef.current.delete(lp.line);
      }
      out.push(...picked);
    }
    return out;
  }, [candidates, p0.positions, p1.positions, p2.positions, gps.userLocation, allowedLines]);

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

  // #1616 (R8a) — lockless 시 forward-only 가드 활성화.
  // boardingLock이 있으면 기존 동작(#1017): arcStations + lock.boardingStationId 그대로 사용.
  // 없으면 estimateArcStationsFromRoute로 route + GPS 위치 기준 추정 윈도우 산출 — backward
  // jump 차단 안전망. 추정 실패 시(route/origin/destination/GPS 없음) undefined로 fallback해
  // 기존 lockless 동작 유지(회귀 0).
  const locklessGuard = useMemo(() => {
    if (boardingLock) return undefined;
    return estimateArcStationsFromRoute({
      route: routeContext?.route ?? null,
      origin: routeContext?.origin ?? null,
      destination: routeContext?.destination ?? null,
      userLocation: gps.userLocation,
    });
  }, [boardingLock, routeContext, gps.userLocation]);

  const trainProgress = useMemo(
    () =>
      trackTrainProgress({
        candidates: candidateTrains,
        userLocation: gps.userLocation,
        lastConfirmedTrainNo: lastConfirmedTrainNoRef.current,
        // #1017 + #1616 (R8a) forward-only 가드.
        //   - boardingLock 활성: 기존 (#1017) arcStations + lock.boardingStationId.
        //   - lockless: estimateArcStationsFromRoute 결과 (없으면 undefined → 가드 OFF graceful).
        segmentStations: boardingLock ? arcStations : locklessGuard?.segmentStations,
        boardingStationId: boardingLock?.boardingStationId ?? locklessGuard?.boardingStationId,
        // #1616 (R8a) — lockless 시 forward-only 가드가 backward를 reject한 케이스만 alarmLog 적재.
        // boardingLock 활성 시는 기존 (#1017) 가드와 동일 동작 — 별도 측정 X (lock 신호가 이미 강한 근거).
        onFilteredBackward: boardingLock
          ? undefined
          : (info) => {
              logSuppressedLocklessForwardOnly({
                rejectedStationName: info.stationName,
                rejectedTrainNo: info.trainNo,
              });
            },
      }),
    [candidateTrains, gps.userLocation, boardingLock, arcStations, locklessGuard],
  );

  // #445: trainProgress 갱신 시각 추적 + TTL 만료 후 first 갱신에서 sticky 락 해제.
  // 폴링 정지로 TTL이 지난 뒤 재개되면 trackTrainProgress가 stale sticky를 다시 픽업해
  // 잘못된 락이 반복되는 사이클을 끊는다 — 다음 사이클은 새 후보로 정상 disambiguation.
  const lastProgressTsRef = useRef<number>(0);

  // #1749 — station hop 추적: 직전 cycle result. #1926 (F-fix) lockless position-train
  // station progression check도 동일 ref 재사용. 같은 noLine에서 hop > PICKER_HOP_ANOMALY_THRESHOLD면
  // silent skip (prev 유지). update는 cascade 채택 직후(아래 cascadePicker 분기).
  const prevCascadeResultRef = useRef<NearestStationResult | null>(null);
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

  // #1450 (B2): lock 활성 trip에서 매 arrival 폴링마다 lock.trainCode와 동일한 후보가
  // 계속 관찰되면 traincode strong C가 TTL 만료로 강등되는 사이클을 끊는다.
  // 위 effect는 trainProgress 의존이라 trainProgress가 일시적으로 null(GPS 끊김 등)이거나
  // 동일 ref면 발화하지 않아 TTL이 자연 만료된다. lockless trip에서는 기존 #445 sticky-락
  // 해제 동작이 유지되어야 하므로 본 refresh는 lock 활성 + lockedTrainCode 일치 시만 발화.
  // ADR-015 §3 지하 분기 strong C 합의 게이트.
  // boardingLock.trainCode가 이번 폴링 candidateTrains에서 관찰되면 strong C 살아있음.
  // 두 값 중 하나라도 빠지면 null → effect는 비활성 + positionTrainResult TTL 게이트 정상 적용.
  const aliveLockedTrainCode = useMemo<string | null>(() => {
    const code = boardingLock?.trainCode;
    if (code == null) return null;
    return candidateTrains.some((c) => c.trainNo === code) ? code : null;
  }, [candidateTrains, boardingLock]);
  const lockedTrainCodeAlive = aliveLockedTrainCode != null;
  useEffect(() => {
    if (aliveLockedTrainCode == null) return;
    lastProgressTsRef.current = Date.now();
    lastConfirmedTrainNoRef.current = aliveLockedTrainCode;
  }, [aliveLockedTrainCode]);

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
    // #1450 (B2): lock 활성 + lockedTrainCode가 이번 폴링 candidateTrains에서 관찰되면
    // TTL 게이트 면제 — strong C 신호가 살아있다고 보고 강등하지 않는다. lockless trip은 기존대로.
    if (
      lastProgressTsRef.current !== 0 &&
      Date.now() - lastProgressTsRef.current > POSITION_TRAIN_TTL_MS &&
      !lockedTrainCodeAlive
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
    // #1926 (F-fix): lockless 4-signal consensus.
    // lockless trip은 기존 L782/786/797 boardingLock-conditional 게이트가 모두 비활성이라
    // distance gate(0.6km)만으로 채택되는 hole이 있다 (6/27 15:49:35 trip evidence: pt=강남 jump).
    // 사용자 명시 의향 신호(boardingLock)가 없으면 device-side self-contained 4-signal consensus
    // (barometer / accelerometer / cellular) 필수 — GPS는 의사결정에 미사용
    // (`feedback_no_gps_for_decision`).
    if (
      !requiresPositionTrainConsensus(
        { barometerSubsurface, accelerometerPattern, cellularEnvironmentVote },
        boardingLock ?? null,
      )
    ) {
      return null;
    }
    // #1926 (F-fix): lockless 시 station progression check (±1 hop).
    // 직전 cascade result 기준 candidate 역이 2 hop+ jump면 X10 위반(fusion picker output ≠ input).
    // boardingLock 활성 시는 기존 forward-only / arc-window 가드(L807~)가 boarding index 기준으로
    // 더 정확한 진행 제약을 강제하므로 본 progression check를 우회한다 (false negative 차단).
    // arc 밖(cross-line) 또는 prev null(첫 cycle) 시 helper 내부에서 면제.
    if (
      boardingLock == null &&
      !checkStationProgression(station.id, prevCascadeResultRef.current, arcStations)
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
    // #1016 hole (c): lock 활성 시 arc window 내 역만 허용 (arc 밖 또는 window 초과 시 차단).
    if (boardingLock && !isWithinArcWindow(arcStations, station.id, boardingLock.boardingStationId)) {
      return null;
    }
    // #1015 forward-only 검증 — boarding index보다 이전(backward)이면 차단.
    // isWithinArcWindow는 window 초과만 막으므로, backward jump는 별도 검사가 필요.
    if (boardingLock && arcStations.length > 0) {
      const boardingIdx = arcStations.findIndex(
        (s) => s.id === boardingLock.boardingStationId,
      );
      if (boardingIdx !== -1) {
        const stationIdx = arcIndexOfStation(arcStations, station);
        if (stationIdx !== -1 && stationIdx < boardingIdx) {
          return null;
        }
      }
    }
    return candidate;
  }, [
    trainProgress,
    gps.userLocation,
    gps.accuracyMeters,
    candidates,
    boardingLock,
    arcStations,
    lockedTrainCodeAlive,
    // #1926 (F-fix) — lockless 4-signal consensus deps.
    barometerSubsurface,
    accelerometerPattern,
    cellularEnvironmentVote,
  ]);

  const routeResult: NearestStationResult | null = progress.position
    ? {
        station: progress.position.current,
        distanceKm: progress.position.distanceToCurrentM / 1000,
      }
    : null;

  // 우선순위(Phase 1C 역전): position-train > position/arrival(fused) > route-progress > gps.
  // 기존: route-progress가 fused를 덮어쓰고 있었음.
  // #444: fused/route도 채택 직전 거리 sanity 통과 검사 — 미통과 시 다음 우선순위로.
  // R13-a (#1612): lockActive를 fused/route caller에도 전달 — lock 활성 trip의 fused/route는
  // strict bad-accuracy 가드 면제 (positionTrain caller와 동일 정신). lockless trip은 lockActive=false로
  // R13-a strict reject 자연 적용 — 지하 dead zone 누수 차단.
  const gateOpts = {
    userLocation: gps.userLocation,
    accuracyMeters: gps.accuracyMeters,
    gpsNearest: candidates[0],
    maxAbsoluteKm: MAX_FUSION_DISTANCE_KM,
    maxDeltaKm: MAX_FUSION_DELTA_KM,
    lockActive: boardingLock != null,
  };
  // #1723 — GPS fix staleness 게이트 (5분+ stale 거부).
  //
  // gps-only confidence(arrival/position 신호 부재 시 pickFusedStation이 GPS top-1로 fallback)는
  // 사실상 GPS 좌표만으로 station을 산출하므로 GPS가 stale이면 stale station을 cascade로 흘려보낸다
  // (사용자 6/23 13:56 evidence: trip 종료 후 을지로3가 stuck, GPS lastFix 6분 전 → fused tier가
  // gps-only로 stale 좌표 채택). arrival/position 신호가 있는 fused는 GPS 좌표와 무관하게 신뢰
  // 가능하므로 본 게이트 비적용.
  const nowForGpsFallback = Date.now();
  const gpsFallbackStale =
    typeof gps.lastFixAtMs === 'number' &&
    nowForGpsFallback - gps.lastFixAtMs > GPS_FALLBACK_STALE_MAX_AGE_MS;

  // #662: BoardingLock 활성 시 fused도 lock.boardingLine과 다른 노선이면 강등 — positionTrain과
  // 동일 정신. 환승역에서 GPS 후보가 두 노선 모두 잡아 fused가 옆 노선으로 fusion되는 케이스 방어.
  // race: createTransferLock으로 lock이 새 leg로 교체되는 순간 1 render cycle 동안 옛 lock 기준
  // 강등이 일어나 source가 한 번 gps로 flash 가능 — UX 임팩트 미미해 현재는 수용.
  // #1723: fused.confidence='gps-only' + GPS stale → 게이트 실패 → cascade 다음 우선순위(routeResult /
  //   verdict / GPS fallback) 시도. arrival/position 신호 있는 fused는 본 게이트 비적용 (gps-only만).
  const fusedPasses =
    fused != null &&
    passesFusionDistanceGate({ ...gateOpts, candidate: fused.result }) &&
    (!boardingLock || fused.result.station.line === boardingLock.boardingLine) &&
    !(fused.confidence === 'gps-only' && gpsFallbackStale);
  // routeResult는 route arc(단일 노선 segment) 위 진행도라 옆 노선 station이 들어올 수 없음 → 가드 불필요.
  // #1723: route-progress는 progress 알고리즘이 user GPS와 arc를 fusion한 결과 — GPS stale이면
  //   arc 위 progress 추정도 stale이므로 거부 (gps-only fused와 동일 정신).
  const routePasses =
    routeResult != null &&
    passesFusionDistanceGate({ ...gateOpts, candidate: routeResult }) &&
    !gpsFallbackStale;

  // #1286 — WiFi SSID 역 매칭 → fusion cascade.
  // wifiSsidLookup은 역명 → 첫 번째 호선 Station을 반환하므로, 환승역 호선 보정:
  //   1) boardingLock.boardingLine — 사용자가 명시적으로 탑승한 노선 (가장 정확).
  //   2) 해당 보정 결과가 없으면 wifiStation 그대로 사용 (단일 호선 역 or 호선 미확정).
  //
  // #1398 — barometer subsurface SPOF 분리.
  //   기존: `if (!barometerSubsurface || !wifiStation) return null;` — barometer가 unavailable이면
  //         WiFi 매칭 자체가 무력화되어 dump1/dump2 케이스(signalMask 첫 글자 'U')에서 현재역 붕괴.
  //   변경: WiFi SSID 매칭(정규식 + 네이티브 SSID) 자체 신뢰도만으로 채택. barometer는 보조 가중치.
  //
  // false positive 방어 (지상에서 카페/지하상가 WiFi 오매칭 차단):
  //   1. SSID 매칭 신뢰도 — wifiSsidLookup의 정규식 패턴(`T_subway_<역명>` 등 지하철 SSID 명명규칙)이
  //      이미 1차 게이트. 비-지하철 SSID는 매칭 자체가 안 됨.
  //   2. 거리 게이트 — WiFi 결과가 GPS와 WIFI_SSID_MAX_DISTANCE_KM 이상 떨어지면 거부.
  //      GPS userLocation 자체가 없으면(지하 dead zone) 면제 — WiFi가 유일 신호이므로 통과.
  //
  // 지상 + SSID 매칭 + 거리 정합 케이스: WiFi가 GPS보다 정확할 수 있으므로 채택 허용.
  // SSID 무매칭(wifiStation=null) → null 반환(기존 cascade).
  const wifiStationResolved: NearestStationResult | null = (() => {
    if (!wifiStation) return null;
    // BoardingLock의 노선으로 환승역 호선 보정 시도.
    const targetLine = boardingLock?.boardingLine ?? null;
    const resolvedStation =
      targetLine && targetLine !== wifiStation.line
        ? (findStationByNameAndLine(wifiStation.name, targetLine) ?? wifiStation)
        : wifiStation;
    // 거리 게이트 — GPS가 있을 때만 적용. dead zone(null)은 자동 면제.
    if (gps.userLocation) {
      const distanceKm = haversine(
        gps.userLocation.lat,
        gps.userLocation.lng,
        resolvedStation.lat,
        resolvedStation.lng,
      );
      if (distanceKm > WIFI_SSID_MAX_DISTANCE_KM) return null;
      return { station: resolvedStation, distanceKm };
    }
    return { station: resolvedStation, distanceKm: 0 };
  })();

  // #1513 (ADR-015 §3) — multi-signal verdict cascade 결합 prereq.
  //
  // detectionVerdict(barometer-stop + motion-stationary + arvlcd-arrived ≥2 합의)를 cascade picker
  // 내부에서 참조하기 위해 cascade *이전*에 산출. 입력 arrival은 후보 우선순위(wifi > positionTrain >
  // fused > GPS top-1) 중 가장 신뢰되는 station을 키로 사용 — cascade가 어떤 분기로 떨어지든 verdict는
  // 같은 후보를 평가한다.
  //
  // fused가 거리 게이트(`fusedPasses=false`)로 거부됐어도 verdict가 detected면 verdict-driven 채택을
  // 허용해 지하 GPS drop 환경에서도 currentStation을 확정한다 (issue #1513 2026-06-19 어린이대공원역
  // station-passed fire 0건 evidence).
  const verdictCandidateStation: Station | null =
    wifiStationResolved?.station ??
    positionTrainResult?.station ??
    fused?.result.station ??
    gps.liveResult?.station ??
    null;
  const verdictArrival = verdictCandidateStation
    ? pickArrivalForStationName(
        verdictCandidateStation.name,
        verdictCandidateStation.line,
        [
          { stationName: c0, line: h0, arrival: a0.arrival },
          { stationName: c1, line: h1, arrival: a1.arrival },
          { stationName: c2, line: h2, arrival: a2.arrival },
        ],
      )
    : null;
  const detectionInput = useMemo(
    () => ({
      barometer: barometerSignal ?? null,
      motionStationary,
      arrival: verdictArrival,
      lockedTrainCode: lockedTrainCode ?? null,
    }),
    [barometerSignal, motionStationary, verdictArrival, lockedTrainCode],
  );
  const detectionVerdict = useFusedStationDetection(detectionInput);

  // #1513 — verdict가 fused candidate를 채택할 수 있는 cascade slot 가드.
  //
  // 게이트 (false positive 방어 — ADR-010 두 실패 모드 동급):
  //   1. fused 후보 존재 — arrival 신호 기반 fusion 결과가 있어야 station identity가 명확.
  //      (GPS userLocation=null 완전 dead zone에서는 candidates=[]가 되어 fused=null →
  //       본 슬롯 자연 비활성. station identity는 wifi/positionTrain/lock cascade가 담당.)
  //   2. detectionVerdict.detected — ≥2 신호 합의 (fuseStationDetectionSignals AGREEMENT_THRESHOLD).
  //   3. 근접 게이트 — fused.result.distanceKm ≤ DETECTION_FUSED_MAX_DISTANCE_KM(0.5km).
  //      지하 GPS drop 환경(accuracy 1~2km+)은 좌표 자체는 보고되지만 fusedPasses=false로 거부되는
  //      케이스가 evidence (2026-06-19 어린이대공원). 본 게이트는 0.5km 근접만 통과시켜
  //      false positive(먼 역의 정차 신호 오매칭)를 차단한다.
  //
  // 노선 가드: lock 활성 시 fused.result.station.line이 lock.boardingLine과 일치해야 채택 (cross-line
  // false positive 차단, ADR-015 §9 정신).
  const detectionVerdictAccepts =
    fused != null &&
    detectionVerdict.detected &&
    fused.result.distanceKm <= DETECTION_FUSED_MAX_DISTANCE_KM &&
    (!boardingLock || fused.result.station.line === boardingLock.boardingLine);

  // #1568 (T8b, Epic ADR-017 #1553) — backend SSoT mirror cascade 채택 자격.
  //
  // 게이트 (false positive 방어):
  //   1. mirror entry 존재 + station name이 stations.json로 resolve 가능.
  //   2. lastAdvanceAt 기준 staleness 60s 이하 — backend cycle(~30s) 2회 + margin.
  //      stale entry는 backend가 trip을 잊었거나 device가 silent push를 한동안 못 받은 상태 →
  //      cascade 채택 시 사용자 실제 위치를 뒤덮을 risk가 있어 자연 fallback.
  //   3. 노선 가드 — lock 활성 시 resolved station이 lock.boardingLine과 일치해야 채택.
  //      lockless trip은 노선 가드 없이 backend가 advance한 station을 신뢰(보조 cross-check 없음).
  const ssotStation = useMemo<Station | null>(() => {
    if (!backendSsotMirror) return null;
    if (boardingLock) {
      // lock 활성: lock.boardingLine으로 단일화 (기존 동작).
      return findStationByNameAndLine(
        backendSsotMirror.currentStationId,
        boardingLock.boardingLine,
      );
    }
    // #1705 — lockless trip: backend가 forward한 currentStationLine이 있으면 line 정확 매칭.
    // 동명 환승역(합정 2/6호선, 공덕 5/6호선 등) cross-line confusion 차단.
    // currentStationLine 부재(legacy v1 mirror) 시 name-only fallback (기존 동작).
    // cast: backend의 Waypoint.line 어휘는 device LineNumber union과 동일 값 집합.
    if (backendSsotMirror.currentStationLine !== undefined) {
      return findStationByNameAndLine(
        backendSsotMirror.currentStationId,
        backendSsotMirror.currentStationLine as LineNumber,
      );
    }
    return findStationByName(backendSsotMirror.currentStationId);
  }, [backendSsotMirror, boardingLock]);
  const nowMsForSsot = Date.now();
  const ssotFresh =
    backendSsotMirror !== null &&
    nowMsForSsot - backendSsotMirror.lastAdvanceAt <= BACKEND_SSOT_MIRROR_MAX_AGE_MS;
  // #1677 — silent push 60s+ 미수신 시 backend SSoT mirror tier 강제 비활성.
  // silentPushHealthy=false → backend가 silent push를 전달 못 하는 환경이므로
  // mirror가 fresh여도 cascade에서 제거 → wifi/positionTrain/fused 등 device tier fallback.
  // silentPushHealthy=undefined는 기존 동작 유지(healthy로 간주).
  const backendSsotAccepts =
    ssotStation !== null && ssotFresh && silentPushHealthy !== false;

  // #1646 — positionTrain 1순위 승격 (3-of-3 합의 + positionTrainResult 전제).
  //
  // True일 때 positionTrain을 backend SSoT mirror보다 1순위로 승격한다.
  // 사용자 trip evidence(2026-06-22 14:28/14:30/14:33): backend silent push 5-10s + cron 5s + APNs 처리
  // 본질적 10-30s lag로 b역 도착해도 mirror 도착 전까지 cascade가 채택하지 않아 1역 lag 발생.
  // positionTrain은 Seoul realtimePosition + lockedTrainCode 매칭 = 사용자가 명시적으로 탭한 열차의
  // 실시간 위치 → backend SSoT mirror가 forward되기 전에도 advance를 1차 신호로 확정 가능.
  //
  // 전제: positionTrainResult != null (이미 모든 positionTrain 게이트 통과 — distance/arc/forward).
  //
  // 3-of-3 합의 (Strategy ① 6 fail mode 차단 — ADR-010 두 실패 모드 동급):
  //   1. lockMatch — trainProgress.trainNo === lockedTrainCode (trainCode 오선택 / API stale 차단)
  //   2. barometerSubsurface === true (지하 환경 명시 — surface GPS 가용 시 GPS fast-path 우선)
  //   3. boardingLock != null (사용자 명시 의향 trip 한정 — lockless trip은 본 승격 적용 X)
  //
  // backward-compat: 합의 미충족 시 기존 cascade 그대로 (backendSsotAccepts → wifi → positionTrain ...).
  // positionTrainResult가 non-null이면 trainProgress도 non-null (line 219 guard).
  const positionTrainBoardingLockMatch =
    positionTrainResult != null &&
    lockedTrainCode != null &&
    trainProgress!.trainNo === lockedTrainCode &&
    barometerSubsurface === true &&
    boardingLock != null;

  // #1657 — GPS-derived advance fast-path (지상 lock 활성 보완).
  //
  // PR #1646 보완 — 지상 lock 활성 + GPS 신선 케이스.
  // 지상(subsurface===false)에서 GPS가 신선(accuracy ≤ 50m, age ≤ 30s)하면
  // GPS-nearest station을 backend SSoT mirror보다 1순위로 채택.
  // backend mirror 10-30s lag를 GPS 실시간 신호로 우회한다.
  //
  // 4-gate 3-of-3 합의 (false positive 방어 — ADR-010 두 실패 모드 동급):
  //   1. boardingLock != null — 사용자 명시 의향 trip 한정 (lockless trip 미적용).
  //   2. barometerSubsurface === false — 지상 환경 명시. 지하에서는 PR #1646이 담당.
  //   3. GPS 신선 — accuracy ≤ GPS_DERIVED_ACCURACY_MAX_M(50m) AND fix age ≤ 30s.
  //      stale GPS(lastFixAtMs === null)는 게이트 실패 → 기존 cascade.
  //   4. 노선 정합 — candidates[0].station.line === boardingLock.boardingLine AND
  //      candidates[0].distanceKm ≤ GPS_DERIVED_ROUTE_MATCH_MAX_KM(100m).
  //      옆 노선 역 drift(GPS 정확도 한계로 인접 노선 역이 candidates[0]가 되는 케이스) 차단.
  //
  // candidates[0]는 GPS userLocation 기준 최근접 역(haversine 정렬, allowedLines 필터 적용).
  // boardingLine 일치 + 100m 이내이면 GPS 좌표가 해당 역에 있다고 판단 가능.
  //
  // GPS 결정 권한 X 룰 정합 (memory/feedback_no_gps_for_decision.md):
  //   - 지상(subsurface===false 명시)에서만 적용 — 지하 GPS는 WiFi/cell 삼각측량 fallback일
  //     가능성이 높아 결정 권한 금지 룰 적용.
  //   - 이 tier는 지상 open-sky GPS fix에서만 활성되므로 룰 위반 아님.
  //
  // 트레이드오프 완화:
  //   - GPS drift false advance → accuracy 50m + boardingLine 정합 100m 이중 gate.
  //   - 지상↔지하 환경 전환 race → subsurface false → cascade 진입 X (자연 fallback).
  //   - 사용자 하차 후 lock 잔존 → useMisBoardingDetector 90s absent 가드 (별도 seam).
  const gpsTopCandidate = candidates[0] ?? null;
  const gpsDerivedFastPath =
    boardingLock != null &&
    barometerSubsurface === false &&
    gps.accuracyMeters !== null &&
    gps.accuracyMeters <= GPS_DERIVED_ACCURACY_MAX_M &&
    gps.lastFixAtMs !== null &&
    Date.now() - gps.lastFixAtMs <= GPS_DERIVED_FIX_MAX_AGE_MS &&
    gpsTopCandidate !== null &&
    gpsTopCandidate.station.line === boardingLock.boardingLine &&
    gpsTopCandidate.distanceKm <= GPS_DERIVED_ROUTE_MATCH_MAX_KM;

  // #1668 — arvlCd=1(ARRIVED) + lock.trainCode 매칭 즉시 SSoT 채택.
  //
  // Seoul realtimeStationArrival API가 직접 확정한 "열차 도착" 신호 + 사용자가 탑승한 trainCode와 매칭.
  // backend SSoT mirror lag(10-30s) 없이 arrival API 30s cycle에서 즉시 advance 가능.
  //
  // 3-of-3 합의 (ADR-010 두 실패 모드 동급 — false positive/miss 동급 방어):
  //   1. boardingLock 활성 + lockedTrainCode 존재 — 사용자 명시 의향 trip 한정 (lockless 미적용).
  //   2. arrival row: arrivalCode === ARRIVED(1) AND trainCode === lock.trainCode.
  //   3. arrival row: receivedAtMs age ≤ ARVL_CD_ARRIVED_MAX_AGE_MS(35s) — stale 신호 채택 차단.
  //      (receivedAtMs === 0 = mock/미상 → 신선도 판정 불가 → 거부)
  //
  // 채택 station: boardingLock.boardingLine에 일치하는 candidates 슬롯의 station.
  //   - candidates는 GPS 좌표 기준 거리순 정렬 — 가장 가까운 매칭 역을 우선 채택.
  //   - lockless trip(boardingLock=null)은 본 분기 미진입 → 기존 cascade.
  //
  // 트레이드오프 완화:
  //   - trainCode 중복 운행(같은 코드 다른 회차): age ≤ 35s 가드로 최근 cycle 신호만 채택.
  //   - ARRIVED 신호 짧음(~30s): 본 tier 이후 positionTrain/backend-ssot 등 cascade가 유지.
  //   - 사용자 하차 후 lock 잔존: useTrainCodeMismatchDetector(#1659) 90s 가드 별도 방어.
  //   - receivedAtMs === 0(mock/schedule API 응답): 거부해 테스트/schedule fallback 오채택 차단.
  //
  // PR #1646/#1662 보완 관계:
  //   - #1646: lock + 지하 + positionTrain lockMatch → positionTrain 1순위
  //   - #1662: lock + 지상 + GPS 신선 → GPS-derived 1순위 (gpsDerivedFastPath, 위)
  //   - 본 PR: lock + ARRIVED + trainCode 매칭 + 신선 → arrival-ssot 1순위 (지상/지하 무관)
  //   셋 합쳐 lock 활성 환경 3 path 커버.
  const arvlCdArrivedMatch = (() => {
    if (!boardingLock || !lockedTrainCode) return null;
    const now = Date.now();
    const candidateSlots = [
      { candidate: candidates[0] ?? null, arrival: a0.arrival },
      { candidate: candidates[1] ?? null, arrival: a1.arrival },
      { candidate: candidates[2] ?? null, arrival: a2.arrival },
    ];
    for (const { candidate, arrival } of candidateSlots) {
      if (!candidate || !arrival) continue;
      if (candidate.station.line !== boardingLock.boardingLine) continue;
      const allRows = [...arrival.up, ...arrival.down];
      for (const row of allRows) {
        if (row.arrivalCode !== ARRIVAL_CODE.ARRIVED) continue;
        if (row.trainCode !== lockedTrainCode) continue;
        if (row.receivedAtMs === 0) continue;
        if (now - row.receivedAtMs > ARVL_CD_ARRIVED_MAX_AGE_MS) continue;
        return candidate;
      }
    }
    return null;
  })();

  // #1723 — GPS fallback 정제: stale 거부 (환승역 line 보정은 post-cascade에서 처리).
  //
  // useNearestStation.liveResult는 sticky override 없는 GPS 최근접 결과. cascade 최종 fallback
  // (모든 device tier 실패) 또는 shouldDowngradeFusion 강등 후 GPS 원본 fallback에서 사용. stale GPS
  // 6분 전 fix가 BG/지하 dead zone 후에도 남아 사용자 실제 위치와 무관한 stale station을 표시하는
  // 회귀를 차단 (사용자 6/23 13:56 evidence: trip 종료 후 을지로3가 stuck).
  //
  // gpsFallbackStale는 위(fusedPasses/routePasses)에서 이미 계산. 본 helper도 같은 신선도 게이트
  // 공유 — gps-only 모든 cascade tier(fused gps-only / routeProgress / 최종 fallback)에서 일관 적용.
  //
  // 환승역 line drift 보정은 cascade picker 직후 post-cascade 단계에서 source 화이트리스트
  // (`source === 'gps' || source === 'route-progress'`) 기반으로 처리 — 본 helper는 stale gate만 담당.
  const gpsFallbackResult: NearestStationResult | null = gpsFallbackStale
    ? null
    : gps.liveResult;

  // #1747 — cascade picker stuck: 같은 station 5분 max 보유 추적.
  // 같은 stationId가 이 ref에 기록된 시각으로부터 PICKER_STUCK_MAX_AGE_MS 초과 시:
  //   - boardingLock 활성: lock.boardingStationId 역으로 강제 대체 (lock mitigation).
  //   - lockless: null 반환(다음 cycle에서 재계산).
  const pickerStuckRef = useRef<{ stationId: string; adoptedAt: number } | null>(null);

  // #1749 — station hop > 5 detect는 prevCascadeResultRef(상단 선언) 사용.
  // #1926 (F-fix) lockless position-train station progression check가 동일 ref를 공유.

  // #1896 (RC-8) — boarding-lock GPS displacement gate.
  //
  // positionTrainBoardingLockMatch / arvlCdArrivedMatch 두 분기에서 lock 활성 + lockMatch라도
  // GPS와 lock 결과 station의 거리가 LOCK_GPS_DRIFT_THRESHOLD_M(1000m)을 초과하면
  // lock 1순위 승격을 포기하고 하위 cascade tier(backendSsotAccepts → wifi → positionTrain …)로 fallback.
  //
  // "GPS 결정 권한 X" 룰 정합 (memory/feedback_no_gps_for_decision.md):
  //   - 본 gate는 lock 무효화(1순위 강등) 판단만. station 선택 자체는 cascade에 위임.
  //   - GPS 없는 dead zone(gps.userLocation=null)은 drift 계산 불가 → gate 통과 (lock 유지).
  //     GPS dead zone에서 lock이 유일한 신호인 경우를 보호.
  //
  // Evidence: T2 trip 12:19 GPS=신당(979m), lock=동대문역사문화공원(78m) → lock stuck 8분.
  const lockGpsDriftMeters = (lockStation: Station): number | null => {
    // 호출자는 positionTrainBoardingLockMatch(positionTrainResult != null → userLocation 필수) 또는
    // arvlCdArrivedMatch(candidates != null → userLocation 필수) 조건 하에서만 호출 —
    // userLocation=null은 실용적으로 도달 불가. 방어적 guard 유지, 커버리지 면제.
    /* istanbul ignore next */
    if (!gps.userLocation) return null;
    return (
      haversine(
        gps.userLocation.lat,
        gps.userLocation.lng,
        lockStation.lat,
        lockStation.lng,
      ) * 1000
    );
  };

  // positionTrainBoardingLockMatch drift 사전 계산 — 두 곳(gate + debug log)에서 재사용.
  const positionTrainDriftM =
    positionTrainBoardingLockMatch && positionTrainResult
      ? lockGpsDriftMeters(positionTrainResult.station)
      : null;
  const positionTrainDriftBlocked =
    positionTrainDriftM !== null && positionTrainDriftM > LOCK_GPS_DRIFT_THRESHOLD_M;

  // arvlCdArrivedMatch drift 사전 계산.
  const arvlCdDriftM =
    arvlCdArrivedMatch ? lockGpsDriftMeters(arvlCdArrivedMatch.station) : null;
  const arvlCdDriftBlocked =
    arvlCdDriftM !== null && arvlCdDriftM > LOCK_GPS_DRIFT_THRESHOLD_M;

  // drift block 발생 시 boardingLockDriftBuffer에 entry push. 별 buffer라 fusionDebugBuffer
  // self-pollution 회귀 차단 (#1902 candidateRejectBuffer 패턴).
  // positionTrainBoardingLockMatch 분기의 drift block은 positionTrainResult의 거리 게이트(0.6km) 때문에
  // 실용적으로 도달 불가능하다 (거리 게이트 < drift threshold). 보존성 구현이지만 단위 테스트 커버 불가.
  /* istanbul ignore next */
  if (positionTrainBoardingLockMatch && positionTrainDriftBlocked && positionTrainResult) {
    pushBoardingLockDriftEntry({
      kind: 'boarding-lock-drift',
      ts: Date.now(),
      branch: 'positionTrain',
      lockStationName: positionTrainResult.station.name,
      lockStationLine: positionTrainResult.station.line,
      driftMeters: positionTrainDriftM,
    });
  }
  if (arvlCdArrivedMatch && arvlCdDriftBlocked) {
    pushBoardingLockDriftEntry({
      kind: 'boarding-lock-drift',
      ts: Date.now(),
      branch: 'arvlCdArrived',
      lockStationName: arvlCdArrivedMatch.station.name,
      lockStationLine: arvlCdArrivedMatch.station.line,
      driftMeters: arvlCdDriftM,
    });
  }

  let result: NearestStationResult | null;
  let confidence: FusionConfidence;
  let source: FusionSource;
  if (positionTrainBoardingLockMatch && !positionTrainDriftBlocked) {
    // #1646 — 사용자 명시 의향 + 지하 + lockMatch 3-of-3 합의 시 positionTrain 1순위.
    // backend SSoT mirror lag(10-30s)에 의한 현재역 1역 뒤쳐짐 회귀 차단.
    // confidence/source는 #584 PR D2와 동일한 'boarding-lock' (lockMatch 매칭 경로).
    // #1896 — GPS drift > 1km 시 본 분기 미진입 → cascade fallback.
    result = positionTrainResult!;
    confidence = 'boarding-lock';
    source = 'boarding-lock';
  } else if (gpsDerivedFastPath) {
    // #1657 — 지상 + GPS 신선 + 노선 정합 4-gate 합의 시 GPS-derived station 1순위.
    // backend SSoT mirror lag(10-30s)를 지상 open-sky GPS 실시간 신호로 우회한다.
    // candidates[0]는 이미 boardingLine + 100m 게이트를 통과 — gps-only와 달리 노선 정합 강화.
    result = gpsTopCandidate!;
    confidence = 'gps-only';
    source = 'gps';
  } else if (arvlCdArrivedMatch && !arvlCdDriftBlocked) {
    // #1668 — ARRIVED + trainCode 매칭 + 신선 3-of-3 합의 시 arrival-ssot 1순위.
    // Seoul API 직접 도착 확정 신호 — backend SSoT mirror 10-30s lag 우회.
    // boardingLock.boardingLine 일치 + 거리 기준 가장 가까운 candidates 슬롯 station 채택.
    // confidence='boarding-lock' (사용자 탭한 열차가 도착 확정된 가장 강한 신호).
    // #1896 — GPS drift > 1km 시 본 분기 미진입 → cascade fallback.
    result = arvlCdArrivedMatch;
    confidence = 'boarding-lock';
    source = 'boarding-lock';
  } else if (backendSsotAccepts) {
    // #1568 (T8b) — backend SSoT 권위 mirror. backend advance 게이트가
    // ADR-017 6단(seed/repeat/motion-stop/cross-validation 등)을 이미 통과한 결과이므로
    // device-side cascade tier보다 신뢰도가 높다. lock 활성/lockless 모두 동일 우선순위.
    // #1646 — 3-of-3 합의(lock+지하+lockMatch) 시 positionTrain에 양보 (위 분기).
    // #1657 — 지상 GPS 신선 합의 시 gpsDerivedFastPath에 양보 (위 분기).
    // #1668 — ARRIVED+trainCode 합의 시 arvlCdArrivedMatch에 양보 (위 분기).
    result = { station: ssotStation!, distanceKm: 0 };
    confidence = 'backend-ssot';
    source = 'backend-ssot';
  } else if (wifiStationResolved) {
    result = wifiStationResolved;
    confidence = 'wifi-ssid';
    source = 'wifi-ssid';
  } else if (positionTrainResult) {
    result = positionTrainResult;
    // #584 PR D2: position-train의 trainNo가 BoardingLock.trainCode와 일치하면 'boarding-lock'으로 승격.
    // 사용자가 탭한 바로 그 열차가 실시간 위치 API에 잡힌 상태 — 최고 신뢰 신호.
    // positionTrainResult가 non-null이면 trainProgress도 non-null (line 219 guard).
    //
    // #1891 (paradigm Phase 1 보강) — RC-1 autoLock self-fire 차단:
    //   `boardingLock != null` gate 추가. 사용자 의향 표명(boardingPrompt 응답 / BoardingTrainList
    //   직접 탭) 없이 lockedTrainCode가 stale로 남아 있을 때 'boarding-lock' source 승격을 금지.
    //   lock=null이면 'position-train'으로 유지 → station-passed/transfer 알림의 src='boarding-lock'
    //   자기 발화 chain을 끊는다. parent #1745 acceptance: `autoLock_fired_count = 0`.
    const lockMatch =
      boardingLock != null &&
      lockedTrainCode != null &&
      trainProgress!.trainNo === lockedTrainCode;
    confidence = lockMatch ? 'boarding-lock' : 'position-train';
    source = lockMatch ? 'boarding-lock' : 'position-train';
  } else if (fused && fusedPasses) {
    result = fused.result;
    confidence = fused.confidence;
    source = fused.source;
  } else if (detectionVerdictAccepts) {
    // #1513 — fusedPasses 거리 게이트가 거부했어도 multi-signal verdict 합의로 fused 후보 채택.
    // 지하 GPS drop 환경에서 currentStation 확정 경로. 우선순위: arrival-confirmed > 본 슬롯 > routeProgress > GPS.
    result = fused!.result;
    confidence = 'detection-fused';
    source = fused!.source;
  } else if (routeResult && routePasses) {
    result = routeResult;
    confidence = 'route-progress';
    source = 'route-progress';
  } else {
    // #1486 (ADR-015 §2) — sticky:locked fire 권한 영구 박탈.
    // useNearestStation은 sticky lock 활성 시 exposed.result를 sticky station으로 override한다
    // (useNearestStation:487-504). 그대로 gps.result를 사용하면 sticky station이 fire path
    // cascade fallback에 들어가 station-passed/imminent fire의 nearestStation 입력이 된다.
    // gps.liveResult는 sticky override 없는 GPS 최근접 결과 — sticky:locked가 fire path 진입 차단.
    // 표시 채널은 gps.stickyDisplayOnly로 별 노출(아래 return).
    // #1723 — stale GPS 거부 + 환승역 line 보정 (gpsFallbackResult helper).
    //   gps.liveResult를 직접 쓰지 않고 정제된 helper를 사용해 stale fix stuck + cross-line drift 회귀 차단.
    result = gpsFallbackResult;
    confidence = 'gps-only';
    source = 'gps';
  }

  // #1693 — cascade picker가 채택한 tier를 alarmLog에 적재 (측정 보강 3차).
  // dedup 1s — 같은 tier 연속 폴링 cycle에서 1건만 적재.
  // PR #1650/#1662/#1674 효과(지하 positionTrain/GPS-derived/arvlCd tier 채택률) 검증.
  // #1896 — drift-blocked 케이스는 실제 채택 tier(backendSsot 등)로 기록됨 — drift 자체는
  //   fusionDebugBuffer boarding-lock-drift entry로 별도 측정.
  if (positionTrainBoardingLockMatch && !positionTrainDriftBlocked) {
    logFusionPickerTier('positionTrainBoardingLockMatch');
  } else if (gpsDerivedFastPath) {
    logFusionPickerTier('gpsDerivedFastPath');
  } else if (arvlCdArrivedMatch && !arvlCdDriftBlocked) {
    logFusionPickerTier('arvlCdArrivedMatch');
  } else if (backendSsotAccepts) {
    logFusionPickerTier('backendSsotAccepts');
  } else if (wifiStationResolved) {
    logFusionPickerTier('wifiStationResolved');
  } else if (positionTrainResult) {
    logFusionPickerTier('positionTrain');
  } else if (fused && fusedPasses) {
    logFusionPickerTier('fused');
  } else if (detectionVerdictAccepts) {
    logFusionPickerTier('detectionVerdictAccepts');
  } else if (routeResult && routePasses) {
    logFusionPickerTier('routeResult');
  } else {
    logFusionPickerTier('gpsFallback');
  }

  // #1723 — 환승역 line drift 보정 (post-cascade + 강등 후 fallback 공통).
  //
  // gps 또는 route-progress source로 산출된 result는 stations.json entry order 의존이라 환승역에서
  // 잘못된 line이 채택될 수 있다 (사용자 6/23 14:20 evidence: 광흥창 부근에서 신내/합정 toggle).
  // 이미 line-validated된 tier(boarding-lock / backend-ssot / wifi-ssid / position-train)는 본 보정
  // 미적용 — source 화이트리스트로 강등.
  //
  // 보정 정책:
  //   1. lock 활성 → boardingLock.boardingLine 선호
  //   2. lockless + allowedLines size=1 (direct route 또는 단일 leg) → 그 line 선호
  //   3. lockless + allowedLines size≥2 (환승 route) → 보정 없음 (어느 line 선호인지 불명확)
  //   4. lockless + allowedLines undefined (trip 비활성) → 보정 없음 (자유 화면)
  //
  // 매칭 실패(target line에 해당 name 없음) 시 원본 그대로 (graceful, 회귀 0).
  //
  // distanceKm: 환승역 line별 좌표 미세 차이(예: 합정 line2 vs line6 ~25m)는 보존된 distanceKm로
  // 흡수. fusion 거리 게이트 임계(0.5~0.6km)에 비해 미세해 false positive/negative 임팩트 무시 가능.
  // 정확한 distanceKm 갱신은 후속 cycle GPS userLocation 변화 시 자연 재산출.
  const applyTransferLineCorrection = (
    candidate: NearestStationResult | null,
    sourceForCheck: FusionSource,
  ): NearestStationResult | null => {
    if (candidate == null) return null;
    if (sourceForCheck !== 'gps' && sourceForCheck !== 'route-progress') return candidate;
    const preferredLine: LineNumber | null =
      boardingLock?.boardingLine ??
      (allowedLines && allowedLines.size === 1
        ? Array.from(allowedLines)[0]
        : null);
    if (preferredLine === null) return candidate;
    if (candidate.station.line === preferredLine) return candidate;
    const reresolved = findStationByNameAndLine(candidate.station.name, preferredLine);
    if (!reresolved) return candidate;
    return { station: reresolved, distanceKm: candidate.distanceKm };
  };
  result = applyTransferLineCorrection(result, source);

  // #1418 — Tier 1 SSOT 합의 판정 + 환경 추정.
  //
  // 목적: lockless-route-hop / default-hop(시간 적분 = Tier 5)이 실측 신호가 살아 있는 동안
  // forward ratchet으로 result를 덮어쓰는 회귀 차단.
  //
  // Tier 정의 (cascade는 그대로 두고, Tier 5 reject 게이트만 추가):
  //   Tier 1 (지상) — surfaceSSOT: GPS(acc<30m) + Arrival(arvlCd 1/2/3/5) 합의
  //   Tier 1 (지하) — undergroundSSOT: WiFi+Arrival / Position-Train+Arrival 합의
  //   Tier 2~4     — lastObservedRef / boardingLock / positionTrainResult (cascade가 채택)
  //   Tier 5       — 시간 적분 (lockless-route-hop / default-hop)
  //
  // Tier 5 reject 게이트: Tier 5 advance는 Tier 1~4 모두 null일 때만 허용.
  // 실측 신호(SSOT/lastObserved/lock/position-train)가 하나라도 활성이면 시간 적분의 forward ratchet
  // 자체를 차단해 청담/중곡/사가정 류 false fire를 막는다.
  const arrivalSlots = [
    { stationName: c0, line: h0, arrival: a0.arrival },
    { stationName: c1, line: h1, arrival: a1.arrival },
    { stationName: c2, line: h2, arrival: a2.arrival },
  ];
  // #1486 (ADR-015 §2) — surface SSOT 산출도 sticky 격리. sticky:locked가 gps.result에 들어가면
  // 잘못된 station의 arrival을 pick해 consensus가 sticky station을 SSOT로 산출할 수 있다.
  // gps.liveResult는 sticky override 없는 live GPS 최근접 — Tier 1 SSOT 산출의 fire path 영향 차단.
  const surfaceArrival = gps.liveResult
    ? pickArrivalForStationName(gps.liveResult.station.name, gps.liveResult.station.line, arrivalSlots)
    : null;
  const surfaceSSOT = surfaceSSOTConsensus({
    gpsResult: gps.liveResult,
    gpsAccuracy: gps.accuracyMeters,
    arrival: surfaceArrival,
  });
  const undergroundCandidate = wifiStationResolved?.station ?? positionTrainResult?.station ?? null;
  const undergroundArrival = undergroundCandidate
    ? pickArrivalForStationName(undergroundCandidate.name, undergroundCandidate.line, arrivalSlots)
    : null;
  const undergroundSSOT = undergroundSSOTConsensus({
    wifiStation: wifiStationResolved?.station ?? null,
    positionTrainResult,
    arrival: undergroundArrival,
    // #1574 (ADR-017 T11) — BG WiFi 갭 해소: barometer-stop + cellular env vote 보강.
    // barometerSignal.stop=undefined(warmup) / cellular 'unknown'은 vote 미투표.
    barometerStop: barometerSignal?.stop,
    cellularEnvironmentVote,
    // #1542 (ADR-016 S9) — accelerometer fingerprint env vote. 'automotive' = train 진동 1표,
    // 'stationary'/'walking'/'unknown'은 vote 미투표. 미지원/warmup 60s 동안 'unknown' fallback.
    accelerometerPattern,
    // #1821 — warmup quorum 완화: trip 시작 후 60s 이내 station pair 단독 채택 허용.
    // lock 활성 시 boardedAt 사용. lockless는 locklessTripStartRef 선언 이후 별도 처리.
    tripStartedAt: boardingLock?.boardedAt,
  });
  // #1860 — 옵션 C barometer-stop 힌트. tripActive + barometerStop 전달.
  const environmentResult: InferEnvironmentResult = inferEnvironment({
    subsurface: barometerSubsurface,
    surfaceSSOT: surfaceSSOT !== null,
    undergroundSSOT: undergroundSSOT !== null,
    tripActive,
    barometerStop: barometerSignal?.stop,
  });
  const environment: Environment = environmentResult.label;

  // S13(#1546) — 환경 전환 Sentry breadcrumb. delta-only emit.
  // dedup은 recordEnvironmentTransition 내부에서 처리(prev === next 시 no-op).
  const prevEnvironmentRef = useRef<Environment | undefined>(undefined);
  useEffect(() => {
    recordEnvironmentTransition(prevEnvironmentRef.current, environment);
    prevEnvironmentRef.current = environment;
  }, [environment]);

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

  // #1207 (Epic #1204 D1) — lockless trip 앵커. boardingLock이 없고 arc가 산출됐을 때
  // trip 시작 시각을 estimator(LocklessRouteHop)에 전달한다.
  // arc(destination/origin) 변화 또는 lock 활성으로 전환되면 ref를 리셋 — 새 trip context 시작.
  //
  // SSOT: `tripStartStorage`(AsyncStorage) — destination 설정 시 `setTripStartedAt`이 기록.
  // cold restart 직후에도 직전 trip 시작 시각을 복구할 수 있다.
  // hydration이 완료되기 전(또는 storage 키 부재 시)에는 첫 render 시각(`Date.now()`)을 fallback.
  // 비동기 hydration 1회 → render-time 합성은 항상 ref.current를 동기 읽기.
  const arcKey = arcStations.length > 0
    ? `${arcStations[0].id}|${arcStations[arcStations.length - 1].id}`
    : null;
  const locklessTripStartRef = useRef<number | null>(null);
  const prevArcKeyRef = useRef<string | null>(null);
  const prevLockActiveRef = useRef<boolean>(false);
  useEffect(() => {
    const lockActive = boardingLock != null;
    // arc 변화(목적지/출발지 전환) 또는 lock 상태 전환 시 앵커 리셋.
    if (prevArcKeyRef.current !== arcKey || prevLockActiveRef.current !== lockActive) {
      locklessTripStartRef.current = null;
      prevArcKeyRef.current = arcKey;
      prevLockActiveRef.current = lockActive;
    }
    // lockless trip(lock 없음) + arc 준비됨 + 앵커 비어있음 → 1) SSOT(storage)에서 복구 시도,
    //   2) 미존재면 첫 render 시각으로 fallback. 비동기 hydration이라 race 가능 — race에서 storage
    //   값이 도착하면 fallback을 덮어쓴다 (오래된 trip의 진짜 시작 시각을 우선).
    if (!lockActive && arcKey != null && locklessTripStartRef.current === null) {
      // 동기 fallback을 먼저 둬 첫 render 직후부터 estimator가 동작 — race로 storage 값이 도착하면
      // 더 정확한 SSOT 값으로 갱신.
      const fallbackNow = Date.now();
      locklessTripStartRef.current = fallbackNow;
      let cancelled = false;
      void getTripStartedAt().then((stored) => {
        if (cancelled) return;
        // hydration 도착 시점에 trip context가 여전히 같다면(앵커가 fallback 값 그대로) storage 값으로 갱신.
        // 그 사이 reset이 일어났다면(arc 변화/lock 활성) 덮어쓰지 않는다.
        if (stored != null && locklessTripStartRef.current === fallbackNow) {
          locklessTripStartRef.current = stored;
        }
      });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [arcKey, boardingLock]);

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
  // estimator에 주입. #1207 (Epic #1204 D1): lockless 분기에서는 arc 각 hop의 출발역 노선을
  // 동적으로 사용 (lock.boardingLine이 없으므로). 환승 leg가 섞인 arc에서도 segment별 hop time을
  // 정확히 누적한다.
  const lockedLine = boardingLock?.boardingLine ?? null;
  const hopTimeMsForHop = lockedLine
    ? (fromIdx: number) => hopTimeMsAt(arcStations, fromIdx, lockedLine)
    : // lockless: arc 위 hop의 시작 역 노선을 사용 (lock.boardingLine 부재). hopsElapsedFrom은
      // fromIdx < arcLength-1일 때만 본 closure를 호출하므로 arcStations[fromIdx]는 항상 정의됨 —
      // arc 경계 / 미커버 노선 fallback은 hopTimeMsAt 내부에서 처리.
      (fromIdx: number) => hopTimeMsAt(arcStations, fromIdx, arcStations[fromIdx].line);
  const locklessTrip =
    !boardingLock && locklessTripStartRef.current != null
      ? { tripStartedAt: locklessTripStartRef.current }
      : null;
  const estimate = estimateStationProgress({
    lock: boardingLock ?? null,
    locklessTrip,
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

  // #1437 (E4 / ADR-015 §2) — interp/sticky/route-hop fire 권한 영구 박탈.
  //
  // estimator(default-hop / lockless-route-hop / reanchored-hop)는 모두 시간 적분 기반 추정 신호다.
  // 2026-06-18 trip dump L335 13:26:14 `interp 뚝섬 d=827m, gp=성수, rt=성수` 케이스가 보여주듯,
  // 시간 적분이 사용자 실제 위치를 추월해 false station-passed fire를 일으키고, dedup 누적으로
  // 실측 신호 도착 시 알람이 빠지는 회귀를 만든다.
  //
  // ADR-015 §2: estimator 결과는 fire path 입력(result/confidence/source/currentHopIndex)에서 분리.
  //   - fire path 입력: 실측 신호(SSOT / lastObservedRef / positionTrainResult / lock + arrival)만 채택.
  //   - 표시 채널: estimator 결과는 `displayOnlyEstimate`로만 노출 — DebugModal/UI 추적에 유지.
  //
  // 이전 정책(#1418 Tier 5 reject 게이트, lockless/default만 reject + reanchored override 허용,
  // #1207 D2 hop window 게이트가 estimate.index를 currentHopIndex로 사용) 모두 본 PR로 박탈.
  // estimator 호출과 디버그 buffer push(아래)는 유지 — UI/측정 인프라용.
  //
  // 관련:
  //   - lesson_lockless_route_hop_time_integration_ssot_assumption.md (시간 적분 SSOT 가정 결함)
  //   - lesson_train_progressing_source_strategy_blindness.md (upstream fusion arbitration에서 차단)
  const estimatorIsTimeIntegration =
    estimate?.strategy === 'lockless-route-hop'
    || estimate?.strategy === 'default-hop'
    || estimate?.strategy === 'reanchored-hop';
  const fireSafeHopIndex =
    estimate != null && !estimatorIsTimeIntegration ? estimate.index : null;

  // #1401 — 열차 진행(trainProgressing) 신호. 직전 tick 대비 fusion result.station이 arc 위에서
  // advance(idx 증가)했는지. forward-only: 동일/감소는 false. arcKey 변경(새 trip arc) 시 리셋 —
  // 새 trip 첫 tick은 false. 본 신호는 호출자(useStationAlarm 등)가 evaluateMovement에
  // trainProgressing=true로 전달해 device 모션/GPS speed 정적 신호 가드를 우회시킨다.
  // 지하철 내부에서 device 신호 불신뢰성 보완(13:37 역삼 미발사 회귀).
  //
  // 강등(shouldDowngradeFusion) 전의 result를 기준으로 판정 — 강등이 일어나면 그 자체가
  // 정적 판정이라 trainProgressing 우회와 모순되지 않게, 강등 *입력*으로 미리 판정.
  // (모순 회피: trainProgressing=true → shouldDowngradeFusion=false → 강등 X.
  //  trainProgressing=false → 기존 정책 그대로 동작.)
  //
  // #1808 — 시간 적분 strategy(lockless-route-hop / default-hop / reanchored-hop) 활성 시
  // trainProgressing=false 강제. 실측 신호 없이 시간 적분만 active일 때 GPS 좌표 jitter로
  // arc idx가 advance하면 trainProgressing=true가 되어 motion-stationary 가드가 우회 →
  // ADR-014 §4 위반(fire path 진입). 실관측(boarding-lock / backend-ssot / position-train /
  // wifi-ssid / fused / route-progress) 기반 advance만 trainProgressing=true 허용.
  const currentResultArcIdx =
    result != null && arcStations.length > 0
      ? arcIndexOfStation(arcStations, result.station)
      : -1;
  const prevArcIdxRef = useRef<number>(-1);
  const prevArcKeyForProgressRef = useRef<string | null>(null);
  const trainProgressing =
    !estimatorIsTimeIntegration &&
    arcStations.length > 0 &&
    arcKey === prevArcKeyForProgressRef.current &&
    prevArcIdxRef.current !== -1 &&
    currentResultArcIdx !== -1 &&
    currentResultArcIdx > prevArcIdxRef.current;

  // #727 정적 misfire 가드 — shouldDowngradeFusion이 isStaticSpeedSignal + confidence가 fusion
  // 승격 라벨(position-train / boarding-lock / boarding-lock-interp / arrival-arriving #733)인지 한 번에 평가.
  // 정적+accuracy 정상이면 gps-only로 강등 + result/source도 GPS 원본으로 되돌림.
  //
  // #733 — speedMps=null인 정적 사용자(iOS Core Location 미보고) 케이스에 positionStability 신호 fallback.
  // #1401 — trainProgressing=true면 정적 신호 합의여도 강등 금지(arc advance 우선).
  if (
    shouldDowngradeFusion({
      confidence,
      speedMps: gps.speedMps,
      accuracyM: gps.accuracyMeters,
      positionStability,
      motionStationary,
      trainProgressing,
    })
  ) {
    confidence = 'gps-only';
    source = 'gps';
    // #1486 (ADR-015 §2) — 강등 후 GPS 원본 fallback도 sticky 격리.
    // 위 cascade fallback과 동일 패턴: gps.liveResult가 sticky override 없는 GPS 최근접.
    // #1723 — 정제된 gpsFallbackResult helper (stale 거부) + 환승역 line 보정 동시 적용.
    //   강등 후 source가 'gps'로 flip되므로 post-cascade 단계에서 놓친 transfer correction을
    //   본 분기에서 다시 적용해 환승역 line drift 회귀 차단 (lock 활성 trip 보호).
    result = applyTransferLineCorrection(gpsFallbackResult, 'gps');
  }

  // #1749 — station hop > 5 detect → silent skip.
  //
  // 종합운동장 → 역삼 10 station skip evidence (2026-06-24 14:02:00): cascade picker가
  // 1 cycle 안에 10 hop을 점프해 잘못된 station-passed fire 발생.
  //
  // 적용 조건:
  //   1. 같은 noLine 안에서 hop > PICKER_HOP_ANOMALY_THRESHOLD(5) — anomaly 판정.
  //   2. 결과 source가 weak-only(gps / route-progress): 실측 강한 신호(boarding-lock /
  //      backend-ssot / position-train / wifi-ssid / detection-fused)가 tier upgrade로
  //      hop이 큰 것은 정상 advance — 면제. 약한 신호(gps / route-progress)만 hop 체크.
  //      이유: 배경 GPS stuck 후 backend mirror가 다른 역을 권위 산출하면 큰 hop이
  //      발생해도 tier 승격이므로 legitimate. gps / route-progress 는 GPS 좌표 drift
  //      문제로 skip.
  //
  // 게이트 면제 조건:
  //   - prevCascadeResultRef.current가 null (첫 cycle).
  //   - result가 null.
  //   - source가 강한 tier (boarding-lock / backend-ssot / position-train / wifi-ssid / detection-fused).
  //   - 다른 노선으로 전환.
  const hopCheckApplies =
    result != null &&
    prevCascadeResultRef.current != null &&
    (source === 'gps' || source === 'route-progress');
  if (hopCheckApplies) {
    const prev = prevCascadeResultRef.current!;
    if (result!.station.line === prev.station.line) {
      const lineStationsForHop = getStationsOnLine(result!.station.line);
      const nameToIdx = new Map<string, number>();
      lineStationsForHop.forEach((s, i) => nameToIdx.set(s.name, i));
      const fromIdx = nameToIdx.get(prev.station.name);
      const toIdx = nameToIdx.get(result!.station.name);
      /* istanbul ignore next -- getStationsOnLine에 존재하는 station은 nameToIdx에 반드시 있다는 invariant */
      if (fromIdx !== undefined && toIdx !== undefined) {
        const hop = hopsOnLine(lineStationsForHop, fromIdx, toIdx, result!.station.line);
        if (hop > PICKER_HOP_ANOMALY_THRESHOLD) {
          // silent skip — 이전 result 유지, 이번 cycle 건너뜀.
          result = prev;
        }
      }
    }
  }
  // #1749 — prev result 갱신 (hop 체크 후 result가 결정된 뒤 업데이트).
  prevCascadeResultRef.current = result;

  // #1747 — cascade picker stuck: 같은 station 5분 max + lock active mitigation.
  //
  // 종합운동장 8분 stuck evidence (2026-06-24 PM trip): cascade picker가 종합운동장에
  // 8분간 lock → 사용자 실제 이동했지만 fusion picker가 고착 → 역삼 10 hop skip 유발.
  //
  // 적용 조건 (false positive 방어):
  //   - boardingLock 활성 전용: boardingLock 없는 lockless trip은 GPS에서 user가 같은 역에
  //     5분+ 있는 것이 완전히 정상(예: 역 대기, 갈아타기). lockless stuck은 별도 신호 없이
  //     time-based invalidate X → false null 회피.
  //   - weak source 전용 (gps / route-progress): 실측 강한 tier가 이미 stuck을 방지하므로
  //     boarding-lock / backend-ssot / position-train / wifi-ssid source는 면제.
  //
  // boardingLock 활성 + weak source + 5분+ 같은 stationId:
  //   → lock.boardingStationId 역으로 대체 (lock mitigation).
  //     lock.boardingStation = 사용자 탑승역 — 적어도 탑승역에서 다시 시작.
  //
  // 면제 → ref 리셋:
  //   - result가 null: 이미 cascade가 null.
  //   - boardingLock 없음 (lockless).
  //   - 강력한 tier (source 화이트리스트).
  const pickerStuckImmune =
    !boardingLock ||
    source === 'boarding-lock' ||
    source === 'backend-ssot' ||
    source === 'position-train' ||
    source === 'wifi-ssid';
  if (result != null && !pickerStuckImmune) {
    const now = Date.now();
    const stationId = result.station.id;
    if (pickerStuckRef.current?.stationId !== stationId) {
      // 새 station — timestamp 갱신.
      pickerStuckRef.current = { stationId, adoptedAt: now };
    } else if (now - pickerStuckRef.current.adoptedAt > PICKER_STUCK_MAX_AGE_MS) {
      // boardingLock 활성 + 같은 station 5분+ stuck → lock.boardingStationId 역으로 대체.
      const lockStation = getStationById(boardingLock!.boardingStationId);
      if (lockStation) {
        result = { station: lockStation, distanceKm: result.distanceKm };
        pickerStuckRef.current = { stationId: lockStation.id, adoptedAt: now };
      }
    }
  } else {
    // result null 또는 면제 조건 → stuck ref 리셋 (else = ¬(result != null && !pickerStuckImmune)).
    pickerStuckRef.current = null;
  }

  // #1401 — prev arc idx 갱신. 최종 result 결정 후(강등 후 station이 바뀌었을 수 있음) idx 다시 계산.
  // arcKey 변경 시 신규 trip 진입으로 ref 리셋 — 첫 tick의 trainProgressing은 false 보장.
  // forward-only: backward jump는 prev 보존(다음 tick에 다시 forward해야 progressing=true).
  const finalResultArcIdx =
    result != null && arcStations.length > 0
      ? arcIndexOfStation(arcStations, result.station)
      : -1;
  useEffect(() => {
    if (prevArcKeyForProgressRef.current !== arcKey) {
      prevArcKeyForProgressRef.current = arcKey;
      prevArcIdxRef.current = finalResultArcIdx;
      return;
    }
    if (finalResultArcIdx > prevArcIdxRef.current) {
      prevArcIdxRef.current = finalResultArcIdx;
    }
  }, [arcKey, finalResultArcIdx]);

  // #903 (Seam G) — GPS-only 결과인데 기압계 dP/dt가 지하 진입을 시사하면 'gps-only-underground'로 강등.
  // 지하 GPS fix는 wifi/cell 삼각측량 fallback이 보고된 좌표일 가능성이 높아 stationAlarm 게이트에서
  // early/transfer 알람 발사를 별도 정책으로 보류. source는 그대로 'gps' — 신호원 자체는 동일.
  // 다른 confidence(position-train / boarding-lock / arrival-*)는 강등하지 않음 — 본인의 검증 신호로 우선.
  if (confidence === 'gps-only' && barometerSubsurface === true) {
    confidence = 'gps-only-underground';
  }

  // #921 / #1398 / #1513 — 신호 fusion verdict 산출은 cascade picker 이전으로 이동
  // (verdictCandidateStation / verdictArrival / detectionInput / detectionVerdict 참조).
  // cascade 결합 단계가 verdict를 인식하기 위해 사전 산출이 필요.
  //
  // #1290 — 지하 도착 확정 cascade.
  // subsurface=true(지하 진입 확정) + fusion verdict detected(≥2 신호 합의) + 역 근접 게이트 통과
  // → station-passed 발사 트리거. GPS/arrival 독립 경로 — 지하 GPS 동결 구간에서도 발사 가능.
  // false positive 방어:
  //   1. ≥2 신호 합의(AGREEMENT_THRESHOLD) — 단일 오발 차단.
  //   2. result.distanceKm ≤ MAX_FUSION_DISTANCE_KM — 현재역이 실제로 가까운 역임을 보장.
  const subsurfaceStationDetected =
    barometerSubsurface === true &&
    detectionVerdict.detected &&
    result != null &&
    result.distanceKm <= MAX_FUSION_DISTANCE_KM;

  // #1398 — cascade verdict 결합. `gps-only-underground` 강등 결과에 verdict 합의가 결합되면
  //   `detection-fused`로 confidence 라벨 승격. source는 'gps' 유지(좌표 신호원 자체는 동일).
  //   subsurfaceStationDetected에 이미 ≥2 신호 합의 + 근접 게이트가 포함되어 false positive 방어
  //   동일 조건. 다른 confidence(boarding-lock / position-train / arrival-* / wifi-ssid)는
  //   본인의 검증 신호로 우선 — 승격 대상 아님.
  if (confidence === 'gps-only-underground' && subsurfaceStationDetected) {
    confidence = 'detection-fused';
  }

  // #1605 — Backend SSoT 권위 override (option C — Estimator backend SSoT 우선 + estimator fallback).
  //
  // backend SSoT mirror가 fresh(≤180s, BACKEND_SSOT_MIRROR_MAX_AGE_MS)이고 station이 resolve되면
  // estimator(lockless-route-hop 등 시간 적분 strategy)의 결과를 override해 displayOnlyEstimate /
  // estimator buffer push의 SSOT로 채택한다. mirror stale/null/lock line mismatch면 estimator
  // 결과 그대로 fallback (graceful).
  //
  // 사용자 가치(2026-06-20 trip dump 21:16:05 evidence): lockless-route-hop이 destination 성수(idx=6)를
  // 가리켰으나 사용자 실제 위치는 origin 용마산(idx=0). estimator 시간 적분 SSOT 가정 결함
  // (lesson_lockless_route_hop_time_integration_ssot_assumption) 때문에 잘못된 station 표시. backend
  // SSoT는 ADR-017 6단 advance 게이트(seed/repeat/motion-stop/cross-validation 등)를 이미 통과한
  // 권위 신호이므로 estimator보다 신뢰도가 높다.
  //
  // 본 override는 fire path(result/source/confidence/currentHopIndex)와는 분리 — 위 cascade가
  // backend-ssot tier로 이미 fire path를 점유하므로 본 분기는 *표시 채널*만 갱신한다.
  // - effectiveEstimate: displayOnlyEstimate에 노출 (DebugModal/UI 추적용).
  // - estimator buffer: strategy='backend-ssot-override'로 push해 "어떤 estimator strategy를 어떤
  //   backend SSoT가 override했나" 사후 분석 가능.
  //
  // arc index 계산: ssotStation이 arc 위에 있으면 그 idx, 아니면 estimator의 idx 유지 (사용자가
  // arc 밖 station에 있는 case는 estimator idx fallback이 더 의미 있는 추적값).
  const effectiveEstimate: {
    station: Station;
    strategy: import('../../route/utils/stationProgressEstimator').StationProgressStrategy;
    index: number;
  } | null = (() => {
    if (backendSsotAccepts && ssotStation) {
      const ssotArcIdx = arcIndexOfStation(arcStations, ssotStation);
      return {
        station: ssotStation,
        strategy: 'backend-ssot-override' as const,
        index: ssotArcIdx === -1 ? (estimate?.index ?? 0) : ssotArcIdx,
      };
    }
    if (estimate) {
      return { station: estimate.station, strategy: estimate.strategy, index: estimate.index };
    }
    return null;
  })();

  // #1025 — Estimator 전략 변화 시 debug buffer에 push.
  // estimate key: strategy|stationId|arcIndex. null estimate는 strategy=null로 기록.
  // estimateRef: effect 내부에서 estimate를 deps 없이 최신값으로 읽기 위한 ref.
  // estimateKey만 deps에 두면 key 변화 시 최신 estimate를 ref로 안전하게 참조 가능.
  //
  // #1605 — effectiveEstimate(backend SSoT override 결합)를 push해 DebugModal Estimator State 섹션이
  // SSoT 권위 결과를 그대로 표시. estimator 자체 결과는 ref로 보관해 sanity 비교 가능.
  const estimateRef = useRef(effectiveEstimate);
  estimateRef.current = effectiveEstimate;
  const estimateKey = effectiveEstimate
    ? `${effectiveEstimate.strategy}|${effectiveEstimate.station.id}|${effectiveEstimate.index}`
    : 'null';
  useEffect(() => {
    const est = estimateRef.current;
    pushEstimatorEntry({
      ts: Date.now(),
      strategy: est ? est.strategy : null,
      stationName: est ? est.station.name : null,
      stationLine: est ? est.station.line : null,
      arcIndex: est ? est.index : null,
    });
  }, [estimateKey]);

  // 측정(#443): 결정 변화(source/stationId/confidence) 시에만 push.
  // render 중 side-effect 회피 + 의존성 누락 은폐 회피를 위해 결정 key를 ref로 비교.
  //
  // #963 — signalMask까지 포함해 신호 조합 변화(motion/barometer/arvlcd flip)도 별도 entry로
  // 보존. 이전엔 source/confidence/stationId만 비교해 같은 결정 안에서 신호 변화가 측정 데이터에서
  // 누락됐다 (PR #944 P1.2 follow-up).
  const lastDecisionKeyRef = useRef<string | null>(null);
  const resultStationId = result?.station.id ?? null;
  const decisionKey = `${source}|${confidence}|${resultStationId}|${detectionVerdict.signalMask}`;

  // #1501 (ADR-015 §10 P5 / PR-A) — 직전 cycle stationId 추적해 변화 시 exit + enter stamp.
  // corrId는 in-memory cache에서 sync read (setTripCorrId/clear 시 cache 갱신 보장).
  const lastStationIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastDecisionKeyRef.current === decisionKey) return;
    lastDecisionKeyRef.current = decisionKey;
    const candidates: FusionCandidateMini[] = [];
    if (wifiStationResolved) {
      const { name, line } = wifiStationResolved.station;
      candidates.push({ key: 'wifiSsid', stationName: name, line });
    }
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

    // #1501 (ADR-015 §10 P5 / PR-A) — device raw signal dump.
    // fusionDebugBuffer는 in-memory 전용(강제종료 시 소실). rawSignalBuffer는 영속화돼
    // 7일 cold-launch 회귀 사후 분석에 사용. 동일 결정 변화 keyed cycle에서 함께 push.
    // 가용 신호를 최대한 채워야 P5 학습 입력으로 활용 가능 (review P1-1).
    const gpsForDump = gps.userLocation
      ? {
          lat: gps.userLocation.lat,
          lng: gps.userLocation.lng,
          accM: gps.accuracyMeters,
          speedMps: gps.speedMps,
        }
      : null;
    // #1678 — accelerometerPattern이 concrete(unknown 아님)이면 우선 채택.
    // 'automotive' / 'walking' / 'stationary'는 raw signal dump에 직접 반영.
    // 'unknown' (60s window 미수렴 / 미지원)이면 boolean motionStationary fallback.
    let motionForDump: MotionLabel | null = null;
    if (accelerometerPattern !== 'unknown') {
      motionForDump = accelerometerPattern;
    } else if (motionStationary === true) {
      motionForDump = 'stationary';
    } else if (motionStationary === false) {
      motionForDump = 'unknown';
    }
    // arvlCd: up 방향 첫 슬롯 우선, 없으면 down 첫 슬롯. 둘 다 없으면 null.
    // 후속 PR에서 up/down 둘 다 기록하도록 entry shape 확장 검토.
    // result station에 해당하는 arrival을 arrivalSlots에서 추출 (cascade 재구조화로
    // 본 effect 내부에서 산출 — #1517 PR-A merge 시 scope 조정).
    const fusionArrival = result
      ? pickArrivalForStationName(result.station.name, result.station.line, arrivalSlots)
      : null;
    const arvlCdForDump =
      fusionArrival?.up[0]?.arrivalCode ?? fusionArrival?.down[0]?.arrivalCode ?? null;
    const arcProgressForDump = progress.progressM ?? null;
    const ts = Date.now();
    // #1859 — CTRadioAccessTechnology 스냅샷. tech는 native 캐시에서 동기 읽기.
    // vote는 useCellularTech()가 이미 산출한 값을 그대로 사용(재분류 없음).
    const cellularForDump = { tech: getCurrentCellularTech(), vote: cellularEnvironmentVote };
    const prevStationId = lastStationIdRef.current;
    const nextStationId = resultStationId;
    if (prevStationId !== null && result !== null && nextStationId !== null && prevStationId !== nextStationId) {
      pushRawSignal({
        ts,
        corrId: getCurrentTripCorrIdSync(),
        kind: 'exit',
        gps: gpsForDump,
        motion: motionForDump,
        accelPattern: accelerometerPattern,
        cellular: cellularForDump,
        subsurface: barometerSubsurface ?? null,
        arvlCd: arvlCdForDump,
        line: null,
        dir: null,
        arcIdx: null,
        arcProgress: arcProgressForDump,
        stationId: prevStationId,
        source: null,
        confidence: null,
      });
      pushRawSignal({
        ts,
        corrId: getCurrentTripCorrIdSync(),
        kind: 'enter',
        gps: gpsForDump,
        motion: motionForDump,
        accelPattern: accelerometerPattern,
        cellular: cellularForDump,
        subsurface: barometerSubsurface ?? null,
        arvlCd: arvlCdForDump,
        line: result.station.line,
        dir: null,
        arcIdx: null,
        arcProgress: arcProgressForDump,
        stationId: nextStationId,
        source,
        confidence,
      });
    }
    lastStationIdRef.current = nextStationId;
    pushRawSignal({
      ts,
      corrId: getCurrentTripCorrIdSync(),
      kind: 'cycle',
      gps: gpsForDump,
      motion: motionForDump,
      accelPattern: accelerometerPattern,
      cellular: cellularForDump,
      subsurface: barometerSubsurface ?? null,
      arvlCd: arvlCdForDump,
      line: result?.station.line ?? null,
      dir: null,
      arcIdx: null,
      arcProgress: arcProgressForDump,
      stationId: nextStationId,
      source,
      confidence,
    });
  }, [decisionKey, source, confidence, result, wifiStationResolved, positionTrainResult, fused, routeResult, gps.result, gps.accuracyMeters, gps.userLocation, gps.speedMps, trainProgress, lockedTrainCode, detectionVerdict, barometerSubsurface, resultStationId, motionStationary, accelerometerPattern, a0.arrival, a1.arrival, a2.arrival, c0, c1, c2, h0, h1, h2, progress.progressM]);

  return {
    result,
    gpsResult: gps.result,
    liveResult: gps.liveResult,
    confidence,
    source,
    variants: gps.variants,
    userLocation: gps.userLocation,
    speedMps: gps.speedMps,
    accuracyMeters: gps.accuracyMeters,
    loading: gps.loading,
    error: gps.error,
    permissionDenied: gps.permissionDenied,
    // #1723 — GPS lastFix 5분+ stale 시 locationUncertain hoist. HomeScreen lastFusedStationRef +
    //   effectiveOrigin cascade가 stale station을 사용자에게 stuck으로 노출하지 않도록 신호 전파.
    locationUncertain: gps.locationUncertain || gpsFallbackStale,
    gpsActive: gps.gpsActive,
    lastFixAtMs: gps.lastFixAtMs,
    positionStability,
    estimatorStrategy: estimate?.strategy ?? null,
    // D2(#1208) + #1235 (D9 wire) — useStationAlarm hop window 게이트 + DebugModal Trip/Fusion/GPS 섹션 SSOT.
    // #1437 (E4 / ADR-015 §2) — 시간 적분 strategy(default-hop / lockless-route-hop / reanchored-hop)는
    // fire path 입력에서 박탈. estimator 결과는 displayOnlyEstimate로만 노출.
    currentHopIndex: fireSafeHopIndex,
    // #1437 — UI/DebugModal 추적용 별 채널. fire path는 본 필드를 읽지 않는다.
    // #1605 — backend SSoT mirror가 fresh면 estimator 결과를 backend-ssot-override로 대체. mirror
    // null/stale 시 estimator 그대로 fallback. effectiveEstimate가 두 케이스를 모두 캡슐화.
    displayOnlyEstimate: effectiveEstimate,
    arcStations,
    detectionTier: detectionVerdict.confidence,
    detectionSignalMask: detectionVerdict.signalMask,
    subsurface: barometerSubsurface,
    subsurfaceStationDetected,
    // #1817 — phase alarm false fire 차단 입력. useStationAlarm이 시간 적분 활성 시 ETA phase 진입을 차단.
    estimatorIsTimeIntegration,
    trainProgressing,
    environment,
    environmentHintReason: environmentResult.hintReason,
    surfaceSSOTActive: surfaceSSOT !== null,
    undergroundSSOTActive: undergroundSSOT !== null,
    // #1421 — DebugModal Auto-lock 측정 섹션이 SSOT 객체를 inferAutoLockCandidate에 직접 전달.
    surfaceSSOT,
    undergroundSSOT,
    // #1678 — DebugModal Fusion 섹션 + raw signal dump에서 accelerometer vote 상태 확인.
    accelerometerPattern,
    // #1486 (ADR-015 §2) — sticky 표시 채널 패스스루. useNearestStation이 sticky.locked를 노출하고
    // 본 hook은 그대로 통과. fire path는 본 필드는 읽지 않는다.
    stickyDisplayOnly: gps.stickyDisplayOnly,
    // #1621 (Phase B) — V1 mismatch 자동 측정용. silent push handler가 영속화한 backend SSoT
    // currentStationId를 그대로 노출. mirror null/stale 시 null. consumer는
    // `useV1MismatchDetector(uiCurrentStationId, ssotCurrentStationId)` 한 줄로 wire.
    backendSsotCurrentStationId: backendSsotMirror?.currentStationId ?? null,
    refresh: gps.refresh,
  };
}
