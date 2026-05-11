import { findNearestStation } from './findNearestStation';
import { findRoute, calculateStaticETA, isStationOnRoute, updateRouteFromPosition } from './stationRoute';
import { checkAlarm, checkTimeBasedAlarm } from './stationAlarm';
import { sendAlarmNotification, sendStationPassedNotification, updateStationNotification } from './stationNotification';
import { MAX_STATION_DISTANCE_KM } from '../constants/location';
import type { NearestStationResult, Station } from '../types/station';
import type { Route } from './stationRoute';
import type { AlarmEvent } from './stationAlarm';

// ── 순수 함수: 포그라운드/백그라운드 공용 ──

export interface NextTarget {
  nextStationName: string;
  stopsToNextStation: number;
}

export function resolveNextTarget(route: Route, destinationName: string): NextTarget | null {
  if (!route) return null;

  if (route.type === 'direct') {
    return { nextStationName: destinationName, stopsToNextStation: route.stops };
  }

  if (route.type === 'transfer') {
    if (route.stopsToTransfer > 0) {
      return { nextStationName: route.transferName, stopsToNextStation: route.stopsToTransfer };
    }
    return { nextStationName: destinationName, stopsToNextStation: route.stopsFromTransfer };
  }

  if (route.type === 'multi-transfer') {
    for (const t of route.transfers) {
      if (t.stopsToTransfer > 0) {
        return { nextStationName: t.transferName, stopsToNextStation: t.stopsToTransfer };
      }
    }
    return { nextStationName: destinationName, stopsToNextStation: route.stopsAfterLastTransfer };
  }

  return null;
}

/**
 * 통합 알람 평가: 정거장 수 기반(우선) + 시간 기반(보조).
 * 포그라운드(useStationAlarm)와 백그라운드(processLocationUpdate) 모두 이 함수를 사용한다.
 * 주의: firedAlarms를 변경하지 않는다. 알람 발생 후 키 추가는 호출자 책임이다.
 */
export function evaluateAllAlarms(
  route: Route,
  destinationName: string,
  firedAlarms: Set<string>,
): AlarmEvent | null {
  if (!route) return null;

  // 1) 정거장 수 기반 알람 (우선)
  const stopAlarm = checkAlarm(route, destinationName, firedAlarms);
  if (stopAlarm) return stopAlarm;

  // 2) 시간 기반 알람 (보조)
  const target = resolveNextTarget(route, destinationName);
  if (target && target.stopsToNextStation > 0) {
    return checkTimeBasedAlarm(
      target.nextStationName,
      target.stopsToNextStation,
      destinationName,
      route,
      firedAlarms,
    );
  }

  return null;
}

// ── 비동기 파이프라인: 백그라운드 태스크 전용 (부수효과 포함) ──

export interface PipelineResult {
  alarmEvent: AlarmEvent | null;
  nearest: NearestStationResult | null;
  lastNotifiedStationId: string | null;
}

export async function processLocationUpdate(
  lat: number,
  lng: number,
  destination: Station,
  firedAlarms: Set<string>,
  sleepMode: boolean,
  allowSpeaker: boolean = true,
  storedRoute: Route = null,
  lastNotifiedStationId: string | null = null,
): Promise<PipelineResult> {
  const nearest = findNearestStation(lat, lng, MAX_STATION_DISTANCE_KM);
  if (!nearest) return { alarmEvent: null, nearest: null, lastNotifiedStationId };

  let route: Route = null;
  if (storedRoute) {
    route = updateRouteFromPosition(storedRoute, nearest.station, destination.id);
  }
  if (!route) {
    route = findRoute(nearest.station.id, destination.id);
  }
  const alarmEvent = evaluateAllAlarms(route, destination.name, firedAlarms);

  if (alarmEvent) {
    await sendAlarmNotification(
      alarmEvent.type,
      alarmEvent.stationName,
      sleepMode,
      alarmEvent.timeBased ?? false,
      allowSpeaker,
    );
  }

  // 역 변경 감지 → per-station 알림. 단, 경로상 노선의 역만 (false alarm 방지)
  let newLastNotifiedStationId = lastNotifiedStationId;
  if (route && isStationOnRoute(nearest.station, route) && nearest.station.id !== lastNotifiedStationId) {
    const target = resolveNextTarget(route, destination.name);
    if (target) {
      newLastNotifiedStationId = nearest.station.id;
      await sendStationPassedNotification(
        nearest.station.name,
        destination.name,
        target.stopsToNextStation,
      );
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

  return { alarmEvent, nearest, lastNotifiedStationId: newLastNotifiedStationId };
}
