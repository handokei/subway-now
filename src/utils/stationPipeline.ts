import { findNearestStation } from './findNearestStation';
import { findRoute, calculateStaticETA } from './stationRoute';
import { checkAlarm } from './stationAlarm';
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

  if (alarmEvent) {
    await sendAlarmNotification(alarmEvent.type, alarmEvent.stationName, sleepMode);
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
