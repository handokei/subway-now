import { findNearestStation } from './findNearestStation';
import { findRoute, calculateStaticETA, updateRouteFromPosition } from './stationRoute';
import { evaluateAlarmPhase } from './stationAlarm';
import { sendAlarmNotification, sendStationPassedNotification, updateStationNotification } from './stationNotification';
import { distanceMetersBetween, estimateEtaSeconds } from './stationEta';
import type { NearestStationResult, Station } from '../types/station';
import type { Route } from './stationRoute';
import type { AlarmEvent } from './stationAlarm';

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

export interface PipelineResult {
  alarmEvent: AlarmEvent | null;
  nearest: NearestStationResult | null;
  lastNotifiedStationId: string | null;
}

export interface ProcessLocationInputs {
  lat: number;
  lng: number;
  destination: Station;
  firedAlarms: Set<string>;
  sleepMode: boolean;
  allowSpeaker?: boolean;
  storedRoute?: Route;
  lastNotifiedStationId?: string | null;
  speedMps?: number | null;
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
    lastNotifiedStationId = null,
    speedMps = null,
  } = inputs;

  const nearest = findNearestStation(lat, lng);
  if (!nearest) return { alarmEvent: null, nearest: null, lastNotifiedStationId };

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
  }

  let newLastNotifiedStationId = lastNotifiedStationId;
  if (nearest.station.id !== lastNotifiedStationId) {
    newLastNotifiedStationId = nearest.station.id;
    const target = resolveNextTarget(route, destination.name);
    await sendStationPassedNotification(
      nearest.station.name,
      destination.name,
      target?.stopsToNextStation ?? null,
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
    sleepMode ? alarmEvent : null,
  );

  return { alarmEvent, nearest, lastNotifiedStationId: newLastNotifiedStationId };
}
