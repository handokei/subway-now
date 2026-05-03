import { useEffect, useRef } from 'react';
import type { Route } from '../utils/stationRoute';
import { alarmKey } from '../utils/stationAlarm';
import { evaluateAllAlarms } from '../utils/stationPipeline';
import { sendAlarmNotification } from '../utils/stationNotification';
import { useAppStore } from '../store/useAppStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('StationAlarm');

export function useStationAlarm(
  route: Route,
  destinationName: string | null,
): void {
  const firedAlarmsRef = useRef<Set<string>>(new Set());
  const prevDestRef = useRef<string | null>(null);
  const sleepMode = useAppStore((s) => s.sleepMode);
  const setAlarmEvent = useAppStore((s) => s.setAlarmEvent);
  const sleepModeRef = useRef(sleepMode);

  useEffect(() => {
    sleepModeRef.current = sleepMode;
  }, [sleepMode]);

  useEffect(() => {
    if (destinationName !== prevDestRef.current) {
      firedAlarmsRef.current = new Set();
      prevDestRef.current = destinationName;
    }

    if (!route || !destinationName) return;

    const event = evaluateAllAlarms(route, destinationName, firedAlarmsRef.current);
    if (!event) return;

    firedAlarmsRef.current.add(alarmKey(event));
    if (sleepModeRef.current && event.type !== 'approaching') {
      setAlarmEvent({ type: event.type, stationName: event.stationName });
    }
    sendAlarmNotification(event.type, event.stationName, sleepModeRef.current, event.timeBased ?? false).catch((e) =>
      logger.error('알람 알림 실패:', e),
    );
  }, [route, destinationName]);
}
