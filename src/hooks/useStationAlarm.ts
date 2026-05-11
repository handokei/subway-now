import { useEffect, useRef } from 'react';
import { isStationOnRoute } from '../utils/stationRoute';
import type { Route } from '../utils/stationRoute';
import type { Station } from '../types/station';
import { alarmKey, evaluateAlarmPhase } from '../utils/stationAlarm';
import { distanceMetersBetween, estimateEtaSeconds } from '../utils/stationEta';
import { resolveNextTarget } from '../utils/stationPipeline';
import { sendAlarmNotification, sendStationPassedNotification } from '../utils/stationNotification';
import { useAppStore } from '../store/useAppStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('StationAlarm');

export interface UseStationAlarmInputs {
  route: Route;
  destination: Station | null;
  nearestStation: Station | null;
  userLocation: { lat: number; lng: number } | null;
  speedMps: number | null;
}

export function useStationAlarm({
  route,
  destination,
  nearestStation,
  userLocation,
  speedMps,
}: UseStationAlarmInputs): void {
  const firedAlarmsRef = useRef<Set<string>>(new Set());
  const prevDestRef = useRef<string | null>(null);
  const lastNotifiedStationIdRef = useRef<string | null>(null);
  const sleepMode = useAppStore((s) => s.sleepMode);
  const allowSpeaker = useAppStore((s) => s.allowSpeaker);
  const setAlarmEvent = useAppStore((s) => s.setAlarmEvent);
  const sleepModeRef = useRef(sleepMode);
  const allowSpeakerRef = useRef(allowSpeaker);

  useEffect(() => {
    sleepModeRef.current = sleepMode;
  }, [sleepMode]);

  useEffect(() => {
    allowSpeakerRef.current = allowSpeaker;
  }, [allowSpeaker]);

  useEffect(() => {
    const destinationName = destination?.name ?? null;
    if (destinationName !== prevDestRef.current) {
      firedAlarmsRef.current = new Set();
      prevDestRef.current = destinationName;
    }

    if (!route || !destination) return;

    let etaSeconds: number | null = null;
    if (userLocation) {
      const distM = distanceMetersBetween(
        userLocation.lat,
        userLocation.lng,
        destination.lat,
        destination.lng,
      );
      etaSeconds = estimateEtaSeconds(distM, speedMps);
    }

    const event = evaluateAlarmPhase(
      { route, destinationName: destination.name, etaSeconds },
      firedAlarmsRef.current,
    );
    if (event) {
      firedAlarmsRef.current.add(alarmKey(event));
      if (sleepModeRef.current) {
        setAlarmEvent(event);
      }
      sendAlarmNotification(event, sleepModeRef.current, allowSpeakerRef.current).catch((e) =>
        logger.error('알람 알림 실패:', e),
      );
    }

    // 역 변경 감지 → per-station 알림. 단, 경로상 노선의 역만 (false alarm 방지)
    if (
      nearestStation &&
      route &&
      isStationOnRoute(nearestStation, route) &&
      nearestStation.id !== lastNotifiedStationIdRef.current
    ) {
      lastNotifiedStationIdRef.current = nearestStation.id;
      const target = resolveNextTarget(route, destination.name);
      sendStationPassedNotification(nearestStation.name, destination.name, target)
        .catch((e) => logger.error('역 통과 알림 실패:', e));
    }
  }, [
    route,
    destination?.id,
    destination?.name,
    destination?.lat,
    destination?.lng,
    nearestStation?.id,
    userLocation?.lat,
    userLocation?.lng,
    speedMps,
  ]);
}
