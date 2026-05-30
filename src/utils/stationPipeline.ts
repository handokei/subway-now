import { findNearestStation } from './findNearestStation';
import { findRoute, calculateStaticETA, isSameStationName, isStationOnRoute, updateRouteFromPosition } from './stationRoute';
import { evaluateAlarmPhase, resolveAllTargets } from './stationAlarm';
import { sendAlarmNotification, sendStationPassedNotification, updateStationNotification } from './stationNotification';
import { distanceMetersBetween, estimateEtaSeconds } from './stationEta';
import { advanceHopWindow } from './boardingLockScheduler';
import { getBoardingLock } from './boardingLockStorage';
import { getLastNotifiedStationId, setLastNotifiedStationId } from './notificationState';
import {
  logFiredAlarm,
  logFiredStationPassed,
  logSuppressedDedupAlarm,
  logSuppressedDedupStation,
  type AlarmLogSource,
} from './alarmLog';
import { MAX_STATION_DISTANCE_KM } from '../constants/location';
import type { NearestStationResult, Station } from '../types/station';
import type { Route } from './stationRoute';
import type { AlarmEvent } from './stationAlarm';
import type { FusionSource } from './pickFusedStation';
import { resolveNotificationSource } from './notificationSource';

export interface NextTarget {
  nextStationName: string;
  stopsToNextStation: number;
  isTransfer: boolean;
  stopsToDestination: number;
}

export function resolveNextTarget(route: Route, destinationName: string): NextTarget | null {
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

  const suppressed: AlarmEvent[] = [];
  const alarmEvent = evaluateAlarmPhase(
    {
      route,
      destinationName: destination.name,
      etaSeconds,
      currentLine: nearest.station.line,
    },
    firedAlarms,
    undefined,
    suppressed,
  );

  for (const event of suppressed) logSuppressedDedupAlarm(source, event);

  if (alarmEvent) {
    await sendAlarmNotification(alarmEvent, sleepMode, allowSpeaker, notificationSource);
    logFiredAlarm(source, alarmEvent);
  }

  // 역 변경 감지 → per-station 알림. 단, 경로상 노선의 역만 (false alarm 방지)
  // 알림 상태는 notificationState 모듈(AsyncStorage)을 단일 출처로 사용해
  // Foreground/Background 양쪽에서 동일한 dedup이 적용된다.
  if (route && isStationOnRoute(nearest.station, route)) {
    const lastNotifiedStationId = await getLastNotifiedStationId();
    if (nearest.station.id !== lastNotifiedStationId) {
      const target = resolveNextTarget(route, destination.name);
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

  const eta = calculateStaticETA(route);
  await updateStationNotification(
    nearest.station,
    Math.round(nearest.distanceKm * 1000),
    destination,
    route,
    eta,
    undefined,
    sleepMode ? alarmEvent : null,
    notificationSource,
  );

  return { alarmEvent, nearest };
}
