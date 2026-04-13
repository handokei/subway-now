import { useEffect, useRef } from 'react';
import type { Route } from '../utils/stationRoute';
import { checkAlarm, alarmKey } from '../utils/stationAlarm';
import { sendAlarmNotification } from '../utils/stationNotification';
import { createLogger } from '../utils/logger';

const logger = createLogger('StationAlarm');

export function useStationAlarm(route: Route, destinationName: string | null): void {
  const firedAlarmsRef = useRef<Set<string>>(new Set());
  const prevDestRef = useRef<string | null>(null);

  useEffect(() => {
    if (destinationName !== prevDestRef.current) {
      firedAlarmsRef.current = new Set();
      prevDestRef.current = destinationName;
    }

    if (!route || !destinationName) return;

    const event = checkAlarm(route, destinationName, firedAlarmsRef.current);
    if (!event) return;

    firedAlarmsRef.current.add(alarmKey(event));
    sendAlarmNotification(event.type, event.stationName).catch((e) =>
      logger.error('알람 알림 실패:', e),
    );
  }, [route, destinationName]);
}
