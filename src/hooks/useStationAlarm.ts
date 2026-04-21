import { useEffect, useRef } from 'react';
import type { Route } from '../utils/stationRoute';
import { checkAlarm, checkTimeBasedAlarm, alarmKey } from '../utils/stationAlarm';
import { sendAlarmNotification } from '../utils/stationNotification';
import { useAppStore } from '../store/useAppStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('StationAlarm');

export function useStationAlarm(route: Route, destinationName: string | null): void {
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

    // 시간 기반 알람 체크 (약 30초 이하일 때 트리거)
    const timeEvent = checkTimeBasedAlarm(route, destinationName, firedAlarmsRef.current);
    if (timeEvent) {
      firedAlarmsRef.current.add(alarmKey(timeEvent));
      if (sleepModeRef.current) {
        setAlarmEvent({ type: timeEvent.type, stationName: timeEvent.stationName });
      }
      sendAlarmNotification(timeEvent.type, timeEvent.stationName, sleepModeRef.current, true).catch((e) =>
        logger.error('시간 기반 알람 알림 실패:', e),
      );
    }

    // 기존 정거장 수 기반 알람 체크
    const event = checkAlarm(route, destinationName, firedAlarmsRef.current);
    if (!event) return;

    firedAlarmsRef.current.add(alarmKey(event));
    if (sleepModeRef.current) {
      setAlarmEvent({ type: event.type, stationName: event.stationName });
    }
    sendAlarmNotification(event.type, event.stationName, sleepModeRef.current).catch((e) =>
      logger.error('알람 알림 실패:', e),
    );
  }, [route, destinationName]);
}
