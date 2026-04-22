import { useEffect, useRef } from 'react';
import type { Route } from '../utils/stationRoute';
import { checkAlarm, checkTimeBasedAlarm, alarmKey } from '../utils/stationAlarm';
import { sendAlarmNotification } from '../utils/stationNotification';
import { useAppStore } from '../store/useAppStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('StationAlarm');

export function useStationAlarm(
  route: Route,
  destinationName: string | null,
  nextStationName?: string | null,
  stopsToNextStation?: number,
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

    // 시간 기반 알람 체크: 매 역 도착 전 알림 (약 30초 이하일 때 트리거)
    const timeEvent = checkTimeBasedAlarm(
      nextStationName ?? null,
      stopsToNextStation ?? 1,
      destinationName,
      route,
      firedAlarmsRef.current,
    );
    if (timeEvent) {
      firedAlarmsRef.current.add(alarmKey(timeEvent));
      // approaching 타입은 일반 역이므로 취침 모드 alarmEvent 설정 불필요
      if (sleepModeRef.current && timeEvent.type !== 'approaching') {
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
      // checkAlarm은 'destination' | 'transfer'만 반환 (approaching 불가)
      setAlarmEvent({ type: event.type as 'destination' | 'transfer', stationName: event.stationName });
    }
    sendAlarmNotification(event.type, event.stationName, sleepModeRef.current).catch((e) =>
      logger.error('알람 알림 실패:', e),
    );
  }, [route, destinationName, nextStationName, stopsToNextStation]);
}
