/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { findNearestStation } from '../../nearest-station/utils/findNearestStation';
import { findRoute, calculateStaticETA, getFirstLeg, getRouteRemainingSeconds, isSameStationName, isStationOnRoute, updateRouteFromPosition, getStationsOnLine, arcIndexOf, computeHopWindowSize, isStationWithinHopWindow, getStationById } from '../../../shared/utils/stationRoute';
import { computeRouteArc } from '../../route/utils/routeProgress';
import { isPendingTrainCode } from '../../../shared/constants/boardingLock';
import { isInTripByEvidence } from '../../../shared/utils/boardingWait';
import { evaluateAlarmPhase, resolveAllTargets } from './stationAlarm';
import { updateStationNotification, fireLocalAlarmNotification, fireFgAuxStationPassedNotification } from './stationNotification';
import { isMinimalAlarmEnabled } from '../../../shared/constants/debugFlags';
import { distanceMetersBetween, estimateEtaSeconds, estimateTransitEtaSeconds } from '../../../shared/utils/stationEta';
import { cancelSafetyNetByStationKind } from './safetyNetScheduler';
import { getBoardingLock } from './boardingLockStorage';
import { getLastNotifiedStationId, setLastNotifiedStationId } from './notificationState';
import { getBgHopWindowStation, setBgHopWindowStation } from './hopWindowState';
import { useLegAdvanceStore } from '../store/useLegAdvanceStore';
import {
  logFiredAlarm,
  logSuppressedChannelAgnosticDedup,
  logSuppressedCrossCategoryDedup,
  logSuppressedCrossCategoryRecent,
  logSuppressedPhaseToPhaseDedup,
  logSuppressedDedupAlarm,
  logSuppressedDedupStation,
  logSuppressedDismissSilence,
  logSuppressedHopWindow,
  logSuppressedMovement,
  logSuppressedSleepFirstTransfer,
  logSuppressedSleepStationPassed,
  type AlarmLogSource,
} from './alarmLog';
import { evaluateMovement, MOVEMENT_TO_ALARM_LOG_REASON } from '../../nearest-station/utils/movementGate';
import {
  isAnyChannelRecentlyFired,
  isStationRecentlyFired,
  isPhaseToPhaseCrossStationRecentlyFired,
  isTripScopedCrossCategoryRecentlyFired,
  markStationFired,
} from './crossCategoryStationDedup';
import { isStationPassedFirstHop, shouldSuppressBySleepRule } from './shouldSuppressBySleepRule';
import { evaluateDismissSilence } from './dismissSilenceGate';
import { clearDismissSilence, getDismissSilence } from './dismissSilenceStorage';
import { MAX_STATION_DISTANCE_KM } from '../../../shared/constants/location';
import type { LineNumber, NearestStationResult, Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { AlarmEvent } from './stationAlarm';
import type { FusionSource } from '../../../shared/types/fusion';
import { resolveNotificationSource } from './notificationSource';

export interface NextTarget {
  nextStationName: string;
  stopsToNextStation: number;
  isTransfer: boolean;
  stopsToDestination: number;
}

/**
 * 현재 route 상태와 사용자 위치(currentLine)를 기반으로 다음 안내 타겟을 결정한다.
 *
 * #796 회귀(2026-06-03 실기기): multi-transfer에서 사용자가 첫 환승역에 도착한 순간
 * `transfers[0].stopsToTransfer === 0`이 되는데, 기존 로직은 이를 "통과했다"로 해석해
 * `transfers[1]`(다음-다음 환승)을 nextTarget으로 반환했다. 실제로는 두 가지 의미가 섞여 있다:
 *   A. 사용자가 환승역에 정확히 도착 — 아직 fromLine에 있음, 환승해야 함
 *   B. 사용자가 환승역을 지나 toLine으로 갈아탐 — 이미 통과
 *
 * 두 케이스를 데이터만으로는 구분할 수 없으므로 `currentLine`을 추가 신호로 받는다.
 * - currentLine === transfers[i].fromLine: 사용자는 segment[i]에 있으며 transfer[i] 방향. 무조건 transfer[i] 반환.
 * - currentLine === lastTransfer.toLine: 마지막 leg에 도달. destination 반환.
 * - currentLine 미전달 또는 unmatch: legacy(`stopsToTransfer > 0`) fallback.
 *
 * legacy 경로는 backward compat — 호출자가 점진적으로 currentLine을 전달하도록 한다.
 */
export function resolveNextTarget(
  route: Route,
  destinationName: string,
  currentLine?: LineNumber,
): NextTarget | null {
  if (!route) return null;

  if (route.type === 'direct') {
    return {
      nextStationName: destinationName,
      stopsToNextStation: route.stops,
      isTransfer: false,
      stopsToDestination: route.stops,
    };
  }

  if (route.type === 'transfer') {
    const stopsToDestination = route.stopsToTransfer + route.stopsFromTransfer;
    // currentLine === fromLine이면 사용자는 환승 전 segment에 있음. stopsToTransfer가 0(환승역 정확 도착)이어도 transfer 안내 유지.
    if (currentLine === route.fromLine) {
      return {
        nextStationName: route.transferName,
        stopsToNextStation: route.stopsToTransfer,
        isTransfer: true,
        stopsToDestination,
      };
    }
    if (currentLine === route.toLine) {
      return {
        nextStationName: destinationName,
        stopsToNextStation: route.stopsFromTransfer,
        isTransfer: false,
        stopsToDestination: route.stopsFromTransfer,
      };
    }
    // currentLine 미전달 또는 unmatch — legacy 폴백.
    if (route.stopsToTransfer > 0) {
      return {
        nextStationName: route.transferName,
        stopsToNextStation: route.stopsToTransfer,
        isTransfer: true,
        stopsToDestination,
      };
    }
    return {
      nextStationName: destinationName,
      stopsToNextStation: route.stopsFromTransfer,
      isTransfer: false,
      stopsToDestination: route.stopsFromTransfer,
    };
  }

  if (route.type === 'multi-transfer') {
    const { transfers } = route;
    // currentLine 우선 — 정확한 segment 식별.
    if (currentLine !== undefined) {
      for (let i = 0; i < transfers.length; i++) {
        if (transfers[i].fromLine === currentLine) {
          let remaining = route.stopsAfterLastTransfer;
          for (let j = i; j < transfers.length; j++) {
            remaining += transfers[j].stopsToTransfer;
          }
          return {
            nextStationName: transfers[i].transferName,
            stopsToNextStation: transfers[i].stopsToTransfer,
            isTransfer: true,
            stopsToDestination: remaining,
          };
        }
      }
      const lastTransfer = transfers[transfers.length - 1];
      if (lastTransfer && currentLine === lastTransfer.toLine) {
        return {
          nextStationName: destinationName,
          stopsToNextStation: route.stopsAfterLastTransfer,
          isTransfer: false,
          stopsToDestination: route.stopsAfterLastTransfer,
        };
      }
      // unmatched currentLine — legacy로 fallthrough.
    }
    // Legacy: 첫 stopsToTransfer > 0인 transfer 반환. currentLine 없는 호출자(테스트/임시 콜) 보존.
    for (let i = 0; i < transfers.length; i++) {
      const t = transfers[i];
      if (t.stopsToTransfer > 0) {
        let remaining = route.stopsAfterLastTransfer;
        for (let j = i; j < transfers.length; j++) {
          remaining += transfers[j].stopsToTransfer;
        }
        return {
          nextStationName: t.transferName,
          stopsToNextStation: t.stopsToTransfer,
          isTransfer: true,
          stopsToDestination: remaining,
        };
      }
    }
    return {
      nextStationName: destinationName,
      stopsToNextStation: route.stopsAfterLastTransfer,
      isTransfer: false,
      stopsToDestination: route.stopsAfterLastTransfer,
    };
  }

  return null;
}

export interface PipelineResult {
  alarmEvent: AlarmEvent | null;
  nearest: NearestStationResult | null;
}

export interface ProcessLocationInputs {
  lat: number;
  lng: number;
  destination: Station;
  firedAlarms: Set<string>;
  sleepMode: boolean;
  storedRoute?: Route;
  speedMps?: number | null;
  // 알람 로그 적재 시 발사 컨텍스트 — 호출자가 명시한다.
  // 기본값을 두지 않아 컴파일러가 컨텍스트 분류 누락을 잡도록 한다.
  source: AlarmLogSource;
  /** 사용자 노출 알람 본문에 부착할 데이터 출처 (#327).
   *  FG는 useFusedNearestStation의 source, BG는 'gps', silent push는 'position-train'.
   *  미지정 시 라벨 부착 안 함 — 점진 적용 안전. */
  fusionSource?: FusionSource;
  /** GPS 게이트 실패 등으로 위치가 불확실한 상태. true면 source를 무시하고 'uncertain' 라벨. */
  locationUncertain?: boolean;
  /**
   * #777 — 출발역(nearest.station)의 다음 열차 도착 정보. arrival API에서 추출.
   * 호출자가 제공하면 calculateStaticETA가 동적 대기 시간으로 사용, 미제공 시 DEFAULT_WAIT_MINUTES fallback.
   * 호출자(BG/FG) 통합은 점진적으로 진행 — 본 옵션이 없어도 회귀 없음.
   */
  arrivalAtOrigin?: { arrivalSeconds: number; receivedAtMs: number };
  /**
   * #778 — 각 환승역의 다음 열차 도착 정보 (transfer 순서). null/누락 element는 leg당 DEFAULT_WAIT_MINUTES fallback.
   * 호출자가 환승 leg마다 arrival을 제공하면 calculateStaticETA가 동적으로 합산.
   */
  arrivalsAtTransfers?: ReadonlyArray<{ arrivalSeconds: number; receivedAtMs: number } | null>;
}

/**
 * #2373 (Option A, RCA #2180) — FG의 검증된 station-passed hop-window 게이트를 BG 채널에 이식.
 *
 * 배경: BG(stationPipeline)는 findNearestStation의 raw GPS 좌표 최근접 스냅을 그대로 route/phase
 * 평가에 사용한다 — 매 tick 독립 계산, 이전 hop/경과시간 무관 = stateless. 지하 GPS drift가 실제보다
 * 앞선 역(예: 2 hop 전인데 1 hop 전 역)을 스냅하면 remainingStops가 즉시 줄어 transfer-early가
 * 조기 발사한다(2026-08-23 14분 조기 오발사 evidence, 2호선 건대입구 구간).
 *
 * FG(useStationAlarm.ts)는 D1 estimator의 currentHopIndex(부재 시 firedAlarms 기반 fallback)를
 * hop 기준으로 삼지만 BG는 estimator가 없는 stateless 함수다. 대신 직전 tick에 게이트를 통과한
 * nearestStation을 AsyncStorage에 영속화(hopWindowState.ts)해 다음 tick의 기준으로 쓴다.
 *
 * arcStations는 candidate와 같은 노선 전체 station 순서(getStationsOnLine)로 유도한다 — FG의
 * computeRouteArc(환승 양쪽 노선을 이어붙인 arc)를 그대로 쓰지 않는 이유: 기준 station과
 * candidate가 다른 노선이면(=방금 환승 완료) 그 자체가 정상 진행 신호이므로 게이트를 skip하고
 * 새 기준으로 채택한다. computeHopWindowSize/isStationWithinHopWindow는 FG와 동일 함수를
 * 그대로 재사용(shared 추출, 신규 게이트 로직 발명 아님) — route.type이 transfer/multi-transfer면
 * windowSize 동적 확장도 동일하게 적용된다.
 *
 * 반환:
 *   - null: 게이트 미적용(기준 없음 / 방금 환승 / arc 인덱스 미발견 / lock 확증 우회) — candidate를
 *     새 기준으로 채택.
 *   - { blocked: true, ... }: hop window 밖 — 기준 station 유지(overwrite 안 함), caller가 이번
 *     tick의 phase 알람 발사만 suppress한다. candidate 자체(route/notification)는 계속 갱신된다
 *     (FG와 동일 — hop window는 "발사"만 가드, "현재 위치 추정"은 가드하지 않음).
 *
 * #2478 (ADR-036 Phase 0 G0-3c) — lock 확증 forward 전진 우회.
 *
 * 배경: 지하 구간에서 GPS accuracy 게이트(gate-accuracy)로 중간역 tick 자체가 이 함수 호출까지
 * 못 미쳐(evaluateBgHopWindowGate가 아예 호출 안 됨) prevStation(기준점)이 origin(탑승역)에
 * stuck된 채 GPS가 지상 복귀하면, 정당한 다역 전진(예: gap=4)도 GPS drift와 구분 못 하고 그대로
 * 차단된다(2026-09-02 저녁 건대입구→용마산 evidence, `fireLocalAlarmNotification` 미호출).
 *
 * 이 함수는 lock/trainCode/arvlCd 신호를 원래 입력받지 않아(#2373 최초 설계, destinationId/
 * candidateStation/route뿐) drift와 정당 전진을 구분할 수 없었다 — active lock이 이미 확증한
 * trainCode(실코드, PENDING sentinel 아님)가 있으면 그 신뢰를 이 게이트에도 배선한다.
 *
 * 우회 조건 (#2373 방어 유지 — 아래 중 하나라도 미충족이면 기존 차단 그대로):
 *   1. lock 활성 (`lockForLineGuard`는 `processLocationUpdate`가 이미 fetch — 재조회 안 함)
 *   2. lock.trainCode가 실코드(`!isPendingTrainCode`) — fallback lock(미확정)은 신뢰 못 함(#2407과
 *      동일 취지, `evaluatePositionTrainFire`가 pending을 skip하는 것과 동일 가드)
 *   3. lock.destinationId === destinationId — 다른 trip의 stale lock 오매칭 방지
 *   4. candidate가 locked 경로 forward 전진 — `computeRouteArc(route, origin, destination)`로
 *      route 방향대로 정렬된 arc(bgPositionTrainFire.ts와 동일 패턴, `getStationsOnLine`의
 *      raw 노선 전체 순서와 달리 환승 포함 실제 trip 진행 방향)에서 prevStation → candidateStation
 *      인덱스가 감소하지 않아야 한다. off-route(arc 밖, 노선 이탈) 또는 역행(인덱스 감소)이면
 *      우회하지 않는다 — 이게 #2373 원취지(GPS drift 조기 발사) 방어의 핵심.
 *
 * `passesLockedStationGate`(#2383)를 그대로 재사용하지 않는 이유: 그 함수의
 * `LOCK_NEXT_HOP_WINDOW`(±3 hop)는 position-train candidate 선별용 좁은 창으로, 이 evidence
 * 케이스(탑승역 기준 4 hop 밖 목적지)조차 차단해 이 fix의 목적과 충돌한다. 이 게이트는 이미
 * hop-window 자체가 정상 진행을 별도로 bound하므로, lock 확증 우회는 "방향"만 검증하면 된다.
 */
async function evaluateBgHopWindowGate(params: {
  destinationId: string;
  destination: Station;
  candidateStation: Station;
  route: Route;
  lock: BoardingLock | null;
}): Promise<{ blocked: true; currentHopIndex: number; candidateIndex: number } | null> {
  const { destinationId, destination, candidateStation, route, lock } = params;
  const prevStation = await getBgHopWindowStation(destinationId);
  if (!prevStation || prevStation.line !== candidateStation.line) {
    // 기준 없음(첫 tick) 또는 방금 환승선 전환 — 게이트 미적용, candidate를 새 기준으로 채택.
    await setBgHopWindowStation(destinationId, candidateStation);
    return null;
  }

  const arcStations = getStationsOnLine(candidateStation.line);
  const currentHopIndex = arcIndexOf(arcStations, prevStation);
  const candidateIndex = arcIndexOf(arcStations, candidateStation);
  if (currentHopIndex < 0 || candidateIndex < 0) {
    await setBgHopWindowStation(destinationId, candidateStation);
    return null;
  }

  const windowSize = computeHopWindowSize(arcStations, route, currentHopIndex, candidateIndex, null);
  if (isStationWithinHopWindow(candidateStation, arcStations, currentHopIndex, windowSize)) {
    await setBgHopWindowStation(destinationId, candidateStation);
    return null;
  }

  if (
    lock &&
    lock.destinationId === destinationId &&
    !isPendingTrainCode(lock.trainCode) &&
    isLockConfirmedForwardHop(prevStation, candidateStation, lock, route, destination)
  ) {
    await setBgHopWindowStation(destinationId, candidateStation);
    return null;
  }

  return { blocked: true, currentHopIndex, candidateIndex };
}

/**
 * #2478 — prevStation → candidateStation이 lock 경로 방향으로 forward 전진인지(off-route/역행
 * 아닌지) 판정. `computeRouteArc`가 route 방향대로 정렬한 arc를 재사용해 방향을 확정한다
 * (`getStationsOnLine`의 raw 노선 순서는 진행 방향과 무관해 직접 비교 불가).
 */
function isLockConfirmedForwardHop(
  prevStation: Station,
  candidateStation: Station,
  lock: BoardingLock,
  route: Route,
  destination: Station,
): boolean {
  // 방어적 가드 — lock.boardingStationId는 계약상 항상 실존 Station.id지만(BoardingLock 계약),
  // station 데이터 drift/malformed route 대비로 명시 처리한다(#2478, bgPositionTrainFire.ts와
  // 동일 취지의 graceful degrade — 우회 실패 시 기존 #2373 차단 유지).
  const origin = getStationById(lock.boardingStationId);
  if (!origin) return false;

  const arc = computeRouteArc(route, origin, destination);
  const arcStations = arc?.stations ?? [];
  if (arcStations.length === 0) return false;

  const prevIndex = arcStations.findIndex((s) => s.id === prevStation.id);
  const candidateArcIndex = arcStations.findIndex((s) => s.id === candidateStation.id);
  if (prevIndex === -1 || candidateArcIndex === -1) return false;

  return candidateArcIndex >= prevIndex;
}

export async function processLocationUpdate(inputs: ProcessLocationInputs): Promise<PipelineResult> {
  const {
    lat,
    lng,
    destination,
    firedAlarms,
    sleepMode,
    storedRoute = null,
    speedMps = null,
    source,
    fusionSource,
    locationUncertain = false,
    arrivalAtOrigin,
    arrivalsAtTransfers,
  } = inputs;

  const notificationSource = fusionSource
    ? resolveNotificationSource(fusionSource, locationUncertain)
    : undefined;

  const nearest = findNearestStation(lat, lng, MAX_STATION_DISTANCE_KM);
  if (!nearest) return { alarmEvent: null, nearest: null };

  // #707용 lock을 여기서 미리 조회 — 아래 U1 off-route hold 가드가 currentLine 강등 로직보다
  // 먼저 lock 존재 여부를 알아야 한다. 중복 조회 방지를 위해 이 결과를 아래에서 재사용한다.
  const lockForLineGuard = await getBoardingLock();

  let route: Route = null;
  if (storedRoute) {
    route = updateRouteFromPosition(storedRoute, nearest.station, destination.id);
  }
  if (!route) {
    // #U1 (2026-08-31 실탑승 evidence) — 활성 boardingLock이 있는 trip 도중 단일 off-route
    // position(GPS drift/오분류 등)이 들어와 updateRouteFromPosition이 null을 반환하면, 그
    // off-route position으로 findRoute를 재탐색하지 않는다. 재탐색은 완전히 다른(엉뚱한 노선/
    // 방향) 경로를 만들어 그 route의 alarmEvent(phantom transfer/destination 안내)를 발사시킨다
    // — 뚝섬→신당 trip 중 잠실 방향 오탐 스냅으로 "잠실 환승하세요"가 잘못 발사된 사례.
    // 대신 storedRoute를 그대로 유지(hold)한다 — 다음 tick에 position이 route로 복귀하면
    // updateRouteFromPosition이 정상 성공해 자연 복구된다. lock 없는 자유 탐색(genuine reroute,
    // 예: 목적지 변경 직후 최초 route 탐색)은 기존대로 findRoute 재계산을 허용해야 하므로
    // storedRoute 존재 + lock 활성 조합일 때만 hold한다.
    route = storedRoute && lockForLineGuard ? storedRoute : findRoute(nearest.station.id, destination.id);
  }

  // #2373 (RCA #2180) — FG의 검증된 station-passed hop-window 게이트를 BG 채널에 이식.
  // route 없으면 게이트 대상 자체가 없다(evaluateAlarmPhase도 route=null이면 항상 alarmEvent=null).
  const hopWindowGate = route
    ? await evaluateBgHopWindowGate({
        destinationId: destination.id,
        destination,
        candidateStation: nearest.station,
        route,
        lock: lockForLineGuard,
      })
    : null;

  const distanceToDestM = distanceMetersBetween(lat, lng, destination.lat, destination.lng);
  // #2279 — route가 있으면 실측 hop 시간 합(getRouteRemainingSeconds)을 상한으로 clamp해
  // haversine 직선거리÷순간속도가 정거장수와 무관하게 부풀지 않도록 한다. route 없으면
  // (경로 미탐색) 기존 distance/speed 산식으로 graceful fallback.
  const etaSeconds = route
    ? estimateTransitEtaSeconds(distanceToDestM, speedMps, getRouteRemainingSeconds(route))
    : estimateEtaSeconds(distanceToDestM, speedMps);

  // #2204 (ADR-026 ①잔여, 적대적 검증 HOLE 대응) — BG 채널 movement 가드 누락 수정.
  // FG(`useStationAlarm`/evaluateMovement)는 정적 misfire 가드(movement-static-speed /
  // movement-motion-stationary 등)를 destination/transfer/station-passed 발사 전에 적용하지만,
  // 이 파일(BG 채널 SSOT)은 movementGate.ts를 전혀 참조하지 않아 무가드로 발사했다 —
  // 2026-08-07 07:38:21 `bg | fired | destination | early | 뚝섬` phantom fire evidence
  // (같은 구간 fg는 movement-static-speed로 반복 suppressed).
  // BG는 accuracyM/positionStability/motionStationary/trainProgressing/prevSpeedMps를
  // 이 함수 입력으로 갖지 않으므로 speedMps 단독으로만 평가(graceful — 미제공 신호는 자동 skip).
  const movementSignal = evaluateMovement({ speedMps: speedMps ?? undefined });

  // #707: BoardingLock 활성 시 currentLine을 lock.boardingLine으로 강등.
  // BG path는 fusion이 없어 nearest.station.line(raw GPS 최근접)이 환승역에서 옆 노선으로
  // 잘못 잡힐 수 있다. 사용자가 명시 탭한 lock.boardingLine을 source of truth로 신뢰 —
  // evaluateAlarmPhase의 approachLine 게이트(#579)와 맞물려 잘못된 leg 알람 발사를 차단.
  // lock 없으면 기존 동작(GPS line) 유지. lockForLineGuard는 위 U1 hold 가드에서 이미 조회했다
  // (중복 AsyncStorage read 방지 — 재사용).
  const currentLine = lockForLineGuard?.boardingLine ?? nearest.station.line;

  const suppressed: AlarmEvent[] = [];
  const alarmEvent = evaluateAlarmPhase(
    {
      route,
      destinationName: destination.name,
      etaSeconds,
      currentLine,
    },
    firedAlarms,
    undefined,
    suppressed,
  );

  for (const event of suppressed) logSuppressedDedupAlarm(source, event);

  // #746 — dismiss silence 게이트. BG path는 storage helper를 직접 read해 store와 동일 결과.
  // 한 cycle 안에서 phase + station-passed 분기가 모두 사용하므로 1회 read.
  const dismissSilenceState = await getDismissSilence();
  const silenceDecision = evaluateDismissSilence(
    dismissSilenceState,
    Date.now(),
    { lat, lng },
  );
  if (!silenceDecision.silenced && silenceDecision.expired) {
    await clearDismissSilence();
  }

  // alarmEvent && route 두 조건이 동시에 참일 때만 발사 분기 진입.
  // evaluateAlarmPhase는 route=null이면 항상 null이라 사실상 alarmEvent != null이면 route != null.
  // 명시 가드로 type narrowing 후 resolveAllTargets 호출 — non-null assertion 회피.
  // #746 — silence가 활성이면 phase 알람 발사는 skip하지만 UI 갱신(updateStationNotification)은
  //   계속 — silence는 "알람"만 차단, "현재 역 표시" 같은 정보 표시는 보존.
  let suppressedAlarmEvent = false;
  if (alarmEvent && route && silenceDecision.silenced) {
    logSuppressedDismissSilence({
      source,
      stationName: alarmEvent.stationName,
      kind: alarmEvent.type,
      phaseId: alarmEvent.phaseId,
    });
    suppressedAlarmEvent = true;
  }
  if (alarmEvent && route && !suppressedAlarmEvent) {
    // #750: 공통 sleep 룰 게이트. scheduler 사전 예약이 skip한 transfer를 BG 즉시 발사 path가
    // 우회 발사하던 회귀 차단. 첫 hop 판정은 route의 첫 waypoint와 stationName 일치로 — lock
    // 활성 동안 leg가 갱신되면 lock도 갱신되므로 route 첫 leg의 endName이 곧 현재 leg의 첫 hop.
    // Sleep rule 단일 gate (ADR-023). transfer/station-passed 첫 hop만 suppress. destination은 항상 fire.
    const isFirstHop = isSameStationName(getFirstLeg(route, destination.name).endName, alarmEvent.stationName);
    const suppressBySleep = shouldSuppressBySleepRule({
      lock: lockForLineGuard,
      event: { type: alarmEvent.type, stationName: alarmEvent.stationName },
      sleepMode,
      isFirstHop,
    });
    if (!movementSignal.reliable && !(isMinimalAlarmEnabled() && fusionSource === 'position-train')) {
      // #2204 — FG와 동일 정적 misfire 가드. destination/transfer early가 정적 사용자에게
      // 발사되던 phantom fire(뚝섬 evidence)를 차단.
      // #2379 — EXPO_PUBLIC_MINIMAL_ALARM ON일 때는 이 과억제 게이트를 우회한다(스펙 B).
      // #2483 — 우회를 arvlCd/열차 확증(fusionSource=position-train)으로 좁힌다. flag ON만으로는
      // 우회하지 않는다 — GPS-static 정적 phantom(fusionSource=gps 등)은 flag ON에서도 억제 유지.
      logSuppressedMovement({
        source,
        stationName: alarmEvent.stationName,
        kind: alarmEvent.type,
        phaseId: alarmEvent.phaseId,
        reason: MOVEMENT_TO_ALARM_LOG_REASON[movementSignal.reason],
      });
    } else if (hopWindowGate?.blocked) {
      // #2373 — candidate가 직전 tick 기준 station 대비 hop window 밖(GPS drift로 앞선 역 스냅).
      // transfer-early 14분 조기 오발사(2호선 건대입구 구간, 2026-08-23) 차단.
      logSuppressedHopWindow({
        source,
        stationName: alarmEvent.stationName,
        kind: alarmEvent.type,
        phaseId: alarmEvent.phaseId,
        currentHopIndex: hopWindowGate.currentHopIndex,
        candidateIndex: hopWindowGate.candidateIndex,
      });
    } else if (suppressBySleep) {
      logSuppressedSleepFirstTransfer({
        source,
        stationName: alarmEvent.stationName,
        phaseId: alarmEvent.phaseId,
      });
    } else if (
      isStationRecentlyFired(destination.id, alarmEvent.stationName, alarmEvent.type, Date.now())
    ) {
      // #1515 — cross-category station-level dedup. 같은 station에 직전 station-passed 발사가
      // 있었다면 phase 알람 차단(BG path 동등 가드). lock 활성/lockless 동급 (ADR-014).
      logSuppressedCrossCategoryDedup({
        source,
        stationName: alarmEvent.stationName,
        kind: alarmEvent.type,
        phaseId: alarmEvent.phaseId,
      });
    } else if (
      isTripScopedCrossCategoryRecentlyFired(
        destination.id,
        alarmEvent.stationName,
        alarmEvent.type,
        Date.now(),
      )
    ) {
      // #1643 — trip-scoped cross-category + cross-station 즉시 cascade. 같은 trip에 직전 5s 안에
      // **다른 station에서 cross-category(SP↔phase)** fire가 있었다면 phase 알람 차단. 2026-06-20
      // 12:31 어대 "군자 도착"(SP) + "곧 성수 도착"(D imminent) 회귀 차단. 같은 station 진행
      // (early→imminent)은 통과 — per-station dedup이 담당.
      logSuppressedCrossCategoryRecent({
        source,
        stationName: alarmEvent.stationName,
        kind: alarmEvent.type,
        phaseId: alarmEvent.phaseId,
      });
    } else if (
      isPhaseToPhaseCrossStationRecentlyFired(
        destination.id,
        alarmEvent.stationName,
        alarmEvent.type,
        Date.now(),
      )
    ) {
      // #1656 — phase↔phase cross-station 즉시 cascade(3s 윈도우). 같은 trip에 직전 3s 안에 다른
      // station에서 phase(transfer/destination) fire가 있었다면 차단. leg 전환 race 회귀:
      //   - 2026-06-20 12:32 어대: "곧 건대"(transfer) + "성수 도착"(destination)
      //   - 2026-06-19 15:37 BG: "곧 이수"(destination) + "다음 역 사당"(transfer)
      logSuppressedPhaseToPhaseDedup({
        source,
        stationName: alarmEvent.stationName,
        kind: alarmEvent.type,
        phaseId: alarmEvent.phaseId,
      });
    } else if (
      isAnyChannelRecentlyFired(
        destination.id,
        alarmEvent.stationName,
        alarmEvent.type,
        Date.now(),
        alarmEvent.phaseId,
      )
    ) {
      // #1901/#1900 (RC-7/RC-10a) — channel-agnostic 8분 backstop. silent state push + LA dirty
      // update의 cross-channel 같은 kind+phase 중복(2026-06-26 trip-3 동대문역사문화공원
      // 12:17:58/12:26:12)을 정확 매칭으로 차단. 정상 phase 진행(early→imminent)은 phaseId 다름 → 통과.
      logSuppressedChannelAgnosticDedup({
        source,
        stationName: alarmEvent.stationName,
        kind: alarmEvent.type,
        phaseId: alarmEvent.phaseId,
      });
    } else {
      markStationFired(
        destination.id,
        alarmEvent.stationName,
        alarmEvent.type,
        Date.now(),
        alarmEvent.phaseId,
      );
      // #2067 (Phase 2-device, D1) — sendAlarmNotification 제거. 알람 배너는 원격 visible push가
      // 담당(Phase 2-backend). BG pipeline은 dedup ledger 기록 + alarmLog 적재만 수행한다.
      // #2379 (Phase 2-device 복원, #2067 되돌리기) — 플래그 ON이면 BG가 스스로 device 로컬
      // visible 알림을 발사한다(잠금 화면에서 backend push 단독 의존 시 화면에 아무것도 안 뜨는
      // 회귀 대응). fire-once(markStationFired)는 위에서 이미 통과했으므로 중복 발사 없음.
      if (isMinimalAlarmEnabled()) {
        await fireLocalAlarmNotification(alarmEvent, notificationSource);
      }
      logFiredAlarm(source, alarmEvent);
    }
  }

  // 역 변경 감지 → per-station 알림. 단, 경로상 노선의 역만 (false alarm 방지)
  // 알림 상태는 notificationState 모듈(AsyncStorage)을 단일 출처로 사용해
  // Foreground/Background 양쪽에서 동일한 dedup이 적용된다.
  // #746 — station-passed도 dismiss silence 게이트. dedup(lastNotifiedStationId)보다 위에 두어
  //   silence 중에는 lastNotifiedStationId 갱신을 막아 silence 만료 직후 정상 발사를 보존한다.
  if (route && isStationOnRoute(nearest.station, route) && silenceDecision.silenced) {
    logSuppressedDismissSilence({
      source,
      stationName: nearest.station.name,
      kind: 'station-passed',
    });
  } else if (route && isStationOnRoute(nearest.station, route)) {
    // #1236 (Epic #1204 D8 wire) — station-passed sleep 룰 게이트.
    // lock 활성: candidate가 boardingStationId면 첫 hop → suppress (2026-06-12 22:11:56 사가정 회귀).
    // lockless BG: estimator output 부재 → currentHopIndex null로 전달, 게이트는 자동 비적용(보수적).
    // dedup(lastNotifiedStationId) 위에 위치 — sleep으로 차단되면 lastNotifiedStationId 갱신 안 함
    // → sleep OFF 토글 후 정상 첫 hop 알림이 재발사 가능.
    // Sleep rule 단일 gate (ADR-023). transfer/station-passed 첫 hop만 suppress. destination은 항상 fire.
    if (!movementSignal.reliable && !(isMinimalAlarmEnabled() && fusionSource === 'position-train')) {
      // #2204 — FG와 동일 정적 misfire 가드. 정적 사용자에게 station-passed가 발사되던 회귀 차단.
      // #2379 — EXPO_PUBLIC_MINIMAL_ALARM ON일 때는 이 과억제 게이트를 우회한다(스펙 B).
      // #2483 — 우회를 arvlCd/열차 확증(fusionSource=position-train)으로 좁힌다.
      logSuppressedMovement({
        source,
        stationName: nearest.station.name,
        kind: 'station-passed',
        reason: MOVEMENT_TO_ALARM_LOG_REASON[movementSignal.reason],
      });
    } else if (
      shouldSuppressBySleepRule({
        lock: lockForLineGuard,
        event: { type: 'station-passed', stationName: nearest.station.name },
        sleepMode,
        isFirstHop: isStationPassedFirstHop({
          lock: lockForLineGuard,
          candidateStationId: nearest.station.id,
          currentHopIndex: null,
        }),
      })
    ) {
      logSuppressedSleepStationPassed({ source, stationName: nearest.station.name });
    } else {
      const lastNotifiedStationId = await getLastNotifiedStationId(destination.id);
      if (nearest.station.id === lastNotifiedStationId) {
        logSuppressedDedupStation(source, nearest.station);
      } else if (
        isStationRecentlyFired(
          destination.id,
          nearest.station.name,
          'station-passed',
          Date.now(),
        )
      ) {
        // #1515 — cross-category dedup. lastNotifiedStationId가 다른 stationId여도 같은 stationName이
        // 직전 phase 알람(destination/transfer)에서 fire됐다면 BG station-passed 차단. FG phase fire와
        // BG station-passed가 같은 station에 거의 동시 fire하는 회귀 차단. lock/lockless 동급 (ADR-014).
        logSuppressedCrossCategoryDedup({
          source,
          stationName: nearest.station.name,
          kind: 'station-passed',
        });
      } else if (
        isTripScopedCrossCategoryRecentlyFired(
          destination.id,
          nearest.station.name,
          'station-passed',
          Date.now(),
        )
      ) {
        // #1643 — trip-scoped cross-category + cross-station 즉시 cascade. 같은 trip에 직전 5s 안에
        // **다른 station에서 phase 알람** fire가 있었다면 station-passed 차단. 어대 "곧 성수 도착"
        // 직후 어대 station-passed 발사 같은 회귀 차단. same-category(SP→SP) cross-station은 통과 —
        // 정상 trip 폴링 진행 보존.
        logSuppressedCrossCategoryRecent({
          source,
          stationName: nearest.station.name,
          kind: 'station-passed',
        });
      } else if (
        isAnyChannelRecentlyFired(
          destination.id,
          nearest.station.name,
          'station-passed',
          Date.now(),
        )
      ) {
        // #1901/#1900 (RC-7/RC-10a) — channel-agnostic 8분 backstop (BG path 동등 가드).
        // 같은 station + 같은 kind(station-passed)가 8분 안에 cross-channel(silent state push +
        // LA dirty update)로 재발사되는 회귀(2026-06-26 trip-3 동대문역사문화공원 12:17:58/12:26:12)
        // 를 BG path에서도 동등 차단. lock 활성/lockless 동급 (ADR-014).
        logSuppressedChannelAgnosticDedup({
          source,
          stationName: nearest.station.name,
          kind: 'station-passed',
        });
      } else {
        // #2064 (Phase 1-device) — 매역 알림은 backend visible push 단일 채널로 전환. 이 station-passed
        // 감지는 이제 사용자 노출 알림(sendStationPassedNotification)을 발사하지 않고 trip 진행
        // 상태 bookkeeping(dedup 갱신 + hop advance)만 수행한다. #796 currentLine 결정은 advanceHopWindow가
        // 정확한 통과 waypoint를 찾기 위해 여전히 필요.
        const target = resolveNextTarget(
          route,
          destination.name,
          lockForLineGuard?.boardingLine ?? nearest.station.line,
        );
        if (target) {
          // #1515 — cross-category 윈도우 갱신. category='station-passed'.
          markStationFired(destination.id, nearest.station.name, 'station-passed', Date.now());
          await setLastNotifiedStationId(destination.id, nearest.station.id);

          // #2379 (Phase 2-device 복원, #2067 되돌리기) — 플래그 ON이면 BG가 스스로 device 로컬
          // station-passed 배너를 발사한다. 기존 FG 보조 발사(`fireFgAuxStationPassedNotification`,
          // #2122)를 재사용 — count/targetKind/targetName은 위에서 이미 계산한 target(NextTarget)의
          // stopsToNextStation/isTransfer/nextStationName을 그대로 매핑(FG dispatchStationPassed의
          // deriveStationPassedTarget과 동일 의미). fire-once는 위 markStationFired로 이미 보장.
          if (isMinimalAlarmEnabled()) {
            await fireFgAuxStationPassedNotification(
              nearest.station.name,
              target.stopsToNextStation,
              target.isTransfer ? 'transfer' : 'destination',
              target.nextStationName,
            );
          }

          // #624 → #2089 — BG-safe stale alarm 차단. 통과한 waypoint의 safety-net 사전 예약을
          // 능동 cancel(더 이상 lock 필요 없음 — safetyNetScheduler는 tripToken 기반 lockless).
          // stationPipeline은 backgroundLocationTask에서도 호출되어 BG에서도 동일 청소가 일어난다.
          // cancelSafetyNetByStationKind는 idempotent. dedup 가드(lastNotifiedStationId) 안쪽에
          // 위치 — 동일 station 재보고 시 reentrant cancel 방지.
          const targets = resolveAllTargets(route, destination.name);
          const matched = targets.find((t) => isSameStationName(t.name, nearest.station.name));
          if (matched) {
            await cancelSafetyNetByStationKind(matched.name, matched.alarmType);
          }
        }
      }
    }
  }

  // #776: 도보 시간 합산. nearest.station을 출발역으로, 사용자 GPS(lat/lng)를 currentLocation으로.
  // 하차 도보는 미적용 — 현 시점 데이터 모델은 destination이 Station(=하차역)으로 사용자 최종 좌표와
  // 일치하므로 도보 0이 자명. 사용자 좌표를 별도로 보유하게 되면 destination/destinationStation 추가.
  // #777: arrivalAtOrigin 호출자가 제공 시 calculateStaticETA가 다음 열차 대기를 동적으로 계산.
  // #778: arrivalsAtTransfers 호출자가 제공 시 환승 leg마다 동적, 미제공 시 leg당 DEFAULT_WAIT_MINUTES.
  // #2290 — in-trip(출발 leg의 boarding 대기 소진 evidence)이면 대기를 제외한다.
  // P1-1 (PR #2295 리뷰): `Boolean(lockForLineGuard)`만으로 판정하면 user-tap lock이 승강장
  // 대기 중에도 "이미 탑승"으로 오판했다 — `hasConsumedOriginWait`로 일반화(device-side evidence
  // 즉시 소진 / user-tap은 initialEtaSeconds 경과분만). lockForLineGuard는 위에서 이미 조회한
  // boardingLock(신규 감지 경로 아님, 재사용). legAdvance stamp는 하차 응답=확정 evidence라 그대로 유지.
  // #2393 — firedAlarms(이 함수 입력으로 이미 존재, 신규 read 아님) non-empty도 in-trip 신호로 추가.
  // 이 trip에 station-passed/도착 알람이 이미 발사됐다면 device는 이미 주행 중으로 판단한 것이므로
  // ETA가 출발 대기를 계속 합산하는 자기모순(2026-08-27 성수→뚝섬 "1정거장 6분" evidence)을 차단한다.
  const isInTrip = isInTripByEvidence(
    lockForLineGuard,
    Date.now(),
    useLegAdvanceStore.getState().nextLine,
    firedAlarms.size > 0,
  );
  const eta = calculateStaticETA(route, {
    currentLocation: { lat, lng },
    originStation: { lat: nearest.station.lat, lng: nearest.station.lng },
    arrivalAtOrigin,
    arrivalsAtTransfers,
    excludeOriginWait: isInTrip,
  });
  // #746 — silence로 차단된 phase 알람은 sleep overlay에 노출하지 않음 (alarmEvent → null).
  const effectiveAlarmEvent = suppressedAlarmEvent ? null : alarmEvent;
  await updateStationNotification(
    nearest.station,
    Math.round(nearest.distanceKm * 1000),
    destination,
    route,
    eta,
    undefined,
    sleepMode ? effectiveAlarmEvent : null,
    notificationSource,
  );

  return { alarmEvent: effectiveAlarmEvent, nearest };
}
