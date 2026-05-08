import { useEffect, useRef } from 'react';
import type { Route } from '../utils/stationRoute';
import type { Station } from '../types/station';
import { alarmKey } from '../utils/stationAlarm';
import { evaluateAllAlarms, resolveNextTarget } from '../utils/stationPipeline';
import { sendAlarmNotification, sendStationPassedNotification } from '../utils/stationNotification';
import { useAppStore } from '../store/useAppStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('StationAlarm');

export function useStationAlarm(
  route: Route,
  destinationName: string | null,
  nearestStation: Station | null,
): void {
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
    if (destinationName !== prevDestRef.current) {
      firedAlarmsRef.current = new Set();
      prevDestRef.current = destinationName;
    }

    if (!route || !destinationName) return;

    const event = evaluateAllAlarms(route, destinationName, firedAlarmsRef.current);
    if (event) {
      firedAlarmsRef.current.add(alarmKey(event));
      if (sleepModeRef.current && event.type !== 'approaching') {
        setAlarmEvent({ type: event.type, stationName: event.stationName });
      }
      sendAlarmNotification(event.type, event.stationName, sleepModeRef.current, event.timeBased ?? false, allowSpeakerRef.current).catch((e) =>
        logger.error('알람 알림 실패:', e),
      );
    }

    // 역 변경 감지 → per-station 알림 (route + destination이 모두 있을 때만)
    if (nearestStation && route && destinationName && nearestStation.id !== lastNotifiedStationIdRef.current) {
      lastNotifiedStationIdRef.current = nearestStation.id;
      const target = resolveNextTarget(route, destinationName);
      const stopsRemaining = target?.stopsToNextStation ?? null;
      sendStationPassedNotification(nearestStation.name, destinationName, stopsRemaining)
        .catch((e) => logger.error('역 통과 알림 실패:', e));
    }
  }, [route, destinationName, nearestStation?.id]);
}
