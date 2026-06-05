import { findNearestStation } from '../../../utils/findNearestStation';
import { findRoute, calculateStaticETA, isSameStationName, isStationOnRoute, updateRouteFromPosition } from '../../../utils/stationRoute';
import { evaluateAlarmPhase, resolveAllTargets } from './stationAlarm';
import { sendAlarmNotification, sendStationPassedNotification, updateStationNotification } from './stationNotification';
import { distanceMetersBetween, estimateEtaSeconds } from '../../../utils/stationEta';
import { advanceHopWindow } from './boardingLockScheduler';
import { getBoardingLock } from './boardingLockStorage';
import { getLastNotifiedStationId, setLastNotifiedStationId } from './notificationState';
import {
  logFiredAlarm,
  logFiredStationPassed,
  logSuppressedDedupAlarm,
  logSuppressedDedupStation,
  logSuppressedDismissSilence,
  logSuppressedSleepFirstTransfer,
  type AlarmLogSource,
} from './alarmLog';
import { shouldSuppressBySleepRule } from './shouldSuppressBySleepRule';
import { evaluateDismissSilence } from './dismissSilenceGate';
import { clearDismissSilence, getDismissSilence } from './dismissSilenceStorage';
import { MAX_STATION_DISTANCE_KM } from '../../../shared/constants/location';
import type { LineNumber, NearestStationResult, Station } from '../../../types/station';
import type { Route } from '../../../utils/stationRoute';
import type { AlarmEvent } from './stationAlarm';
import type { FusionSource } from '../../../utils/pickFusedStation';
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
  allowSpeaker?: boolean;
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

export async function processLocationUpdate(inputs: ProcessLocationInputs): Promise<PipelineResult> {
  const {
    lat,
    lng,
    destination,
    firedAlarms,
    sleepMode,
    allowSpeaker = true,
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

  let route: Route = null;
  if (storedRoute) {
    route = updateRouteFromPosition(storedRoute, nearest.station, destination.id);
  }
  if (!route) {
    route = findRoute(nearest.station.id, destination.id);
  }

  const distanceToDestM = distanceMetersBetween(lat, lng, destination.lat, destination.lng);
  const etaSeconds = estimateEtaSeconds(distanceToDestM, speedMps);

  // #707: BoardingLock 활성 시 currentLine을 lock.boardingLine으로 강등.
  // BG path는 fusion이 없어 nearest.station.line(raw GPS 최근접)이 환승역에서 옆 노선으로
  // 잘못 잡힐 수 있다. 사용자가 명시 탭한 lock.boardingLine을 source of truth로 신뢰 —
  // evaluateAlarmPhase의 approachLine 게이트(#579)와 맞물려 잘못된 leg 알람 발사를 차단.
  // lock 없으면 기존 동작(GPS line) 유지.
  const lockForLineGuard = await getBoardingLock();
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
    // 활성 동안 leg가 갱신되면 lock도 갱신되므로 route.targets[0]이 곧 현재 leg의 첫 hop.
    const firstHopName = resolveAllTargets(route, destination.name)[0].name;
    const isFirstHop = isSameStationName(firstHopName, alarmEvent.stationName);
    const suppressBySleep = shouldSuppressBySleepRule({
      lock: lockForLineGuard,
      event: { type: alarmEvent.type, stationName: alarmEvent.stationName },
      sleepMode,
      isFirstHop,
    });
    if (suppressBySleep) {
      logSuppressedSleepFirstTransfer({
        source,
        stationName: alarmEvent.stationName,
        phaseId: alarmEvent.phaseId,
      });
    } else {
      await sendAlarmNotification(alarmEvent, sleepMode, allowSpeaker, notificationSource);
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
    const lastNotifiedStationId = await getLastNotifiedStationId();
    if (nearest.station.id !== lastNotifiedStationId) {
      // #796: 환승역 도착 timing의 segment 정확 식별. evaluateAlarmPhase(:233)와 동일한
      // currentLine 결정 — lock.boardingLine 우선 → BG GPS jitter로 nearest가 옆 노선 station을
      // 잡아도 잘못된 다음-다음 transfer 안내를 차단. lock 없으면 nearest.station.line fallback.
      const target = resolveNextTarget(
        route,
        destination.name,
        lockForLineGuard?.boardingLine ?? nearest.station.line,
      );
      if (target) {
        // 알림 발송 성공 후에만 storage write — 발송 실패 시 다음 폴링에서 재시도 가능.
        await sendStationPassedNotification(
          nearest.station.name,
          destination.name,
          target,
          notificationSource,
        );
        await setLastNotifiedStationId(nearest.station.id);
        logFiredStationPassed(source, nearest.station);

        // #624 BG-safe stale alarm 차단 — 통과한 waypoint의 pre-scheduled bl:* 알람을
        // 능동 cancel. useBoardingLockAdvancer는 FG only(React hook)지만 stationPipeline은
        // backgroundLocationTask에서도 호출되어 BG에서도 동일 청소가 일어난다.
        // advanceHopWindow는 idempotent — FG advancer와 중복 호출돼도 안전.
        // dedup 가드(lastNotifiedStationId) 안쪽에 위치 — 동일 station 재보고 시
        // reentrant advance 방지. dedup 구조 리팩터 시 advance가 silent하게 사라지지 않게 주의.
        const lock = await getBoardingLock();
        if (lock && route) {
          const targets = resolveAllTargets(route, destination.name);
          const matched = targets.find((t) => isSameStationName(t.name, nearest.station.name));
          if (matched) {
            await advanceHopWindow({
              lock,
              route,
              destinationName: destination.name,
              passedStationName: matched.name,
              sleepMode,
            });
          }
        }
      }
    } else {
      logSuppressedDedupStation(source, nearest.station);
    }
  }

  // #776: 도보 시간 합산. nearest.station을 출발역으로, 사용자 GPS(lat/lng)를 currentLocation으로.
  // 하차 도보는 미적용 — 현 시점 데이터 모델은 destination이 Station(=하차역)으로 사용자 최종 좌표와
  // 일치하므로 도보 0이 자명. 사용자 좌표를 별도로 보유하게 되면 destination/destinationStation 추가.
  // #777: arrivalAtOrigin 호출자가 제공 시 calculateStaticETA가 다음 열차 대기를 동적으로 계산.
  // #778: arrivalsAtTransfers 호출자가 제공 시 환승 leg마다 동적, 미제공 시 leg당 DEFAULT_WAIT_MINUTES.
  const eta = calculateStaticETA(route, {
    currentLocation: { lat, lng },
    originStation: { lat: nearest.station.lat, lng: nearest.station.lng },
    arrivalAtOrigin,
    arrivalsAtTransfers,
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
