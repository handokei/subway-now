import { findNearestStation } from './findNearestStation';
import { findRoute, calculateStaticETA, isStationOnRoute, updateRouteFromPosition } from './stationRoute';
import { evaluateAlarmPhase } from './stationAlarm';
import { sendAlarmNotification, sendStationPassedNotification, updateStationNotification } from './stationNotification';
import { distanceMetersBetween, estimateEtaSeconds } from './stationEta';
import { getLastNotifiedStationId, setLastNotifiedStationId } from './notificationState';
import {
  logFiredAlarm,
  logFiredStationPassed,
  logSuppressedDedupStation,
  type AlarmLogSource,
} from './alarmLog';
import { MAX_STATION_DISTANCE_KM } from '../constants/location';
import type { NearestStationResult, Station } from '../types/station';
import type { Route } from './stationRoute';
import type { AlarmEvent } from './stationAlarm';

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
  } = inputs;

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

  const alarmEvent = evaluateAlarmPhase(
    { route, destinationName: destination.name, etaSeconds },
    firedAlarms,
  );

  if (alarmEvent) {
    await sendAlarmNotification(alarmEvent, sleepMode, allowSpeaker);
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
        );
        await setLastNotifiedStationId(nearest.station.id);
        logFiredStationPassed(source, nearest.station);
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
  );

  return { alarmEvent, nearest };
}
