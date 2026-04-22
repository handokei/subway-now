import { findNearestStation } from './findNearestStation';
import { findRoute, calculateStaticETA } from './stationRoute';
import { checkAlarm, checkTimeBasedAlarm } from './stationAlarm';
import { sendAlarmNotification, updateStationNotification } from './stationNotification';
import type { NearestStationResult, Station } from '../types/station';
import type { Route } from './stationRoute';
import type { AlarmEvent } from './stationAlarm';

// ── 순수 함수: 포그라운드/백그라운드 공용 ──

export interface AlarmCheckInput {
  nearestStationId: string;
  destinationId: string;
  destinationName: string;
  firedAlarms: Set<string>;
}

export interface AlarmCheckResult {
  route: Route;
  alarmEvent: AlarmEvent | null;
}

export function evaluateAlarm(input: AlarmCheckInput): AlarmCheckResult {
  const route = findRoute(input.nearestStationId, input.destinationId);
  const alarmEvent = checkAlarm(route, input.destinationName, input.firedAlarms);
  return { route, alarmEvent };
}

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

// ── 비동기 파이프라인: 백그라운드 태스크 전용 (부수효과 포함) ──

export interface PipelineResult {
  alarmEvent: AlarmEvent | null;
  nearest: NearestStationResult | null;
}

export async function processLocationUpdate(
  lat: number,
  lng: number,
  destination: Station,
  firedAlarms: Set<string>,
  sleepMode: boolean,
): Promise<PipelineResult> {
  const nearest = findNearestStation(lat, lng);
  if (!nearest) return { alarmEvent: null, nearest: null };

  const { route, alarmEvent } = evaluateAlarm({
    nearestStationId: nearest.station.id,
    destinationId: destination.id,
    destinationName: destination.name,
    firedAlarms,
  });

  // 시간 기반 알람: 정거장 수 기반 알람이 없을 때만 체크 (중복 방지)
  let effectiveAlarmEvent = alarmEvent;
  if (!alarmEvent) {
    const target = resolveNextTarget(route, destination.name);
    if (target && target.stopsToNextStation > 0) {
      const timeEvent = checkTimeBasedAlarm(
        target.nextStationName,
        target.stopsToNextStation,
        destination.name,
        route,
        firedAlarms,
      );
      if (timeEvent) {
        effectiveAlarmEvent = timeEvent;
      }
    }
  }

  if (effectiveAlarmEvent) {
    await sendAlarmNotification(
      effectiveAlarmEvent.type,
      effectiveAlarmEvent.stationName,
      sleepMode,
      effectiveAlarmEvent.timeBased ?? false,
    );
  }

  const eta = calculateStaticETA(route);
  await updateStationNotification(
    nearest.station,
    Math.round(nearest.distanceKm * 1000),
    destination,
    route,
    eta,
    undefined,
    sleepMode ? effectiveAlarmEvent : null,
  );

  return { alarmEvent: effectiveAlarmEvent, nearest };
}
