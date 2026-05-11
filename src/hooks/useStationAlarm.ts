import { useEffect, useRef } from 'react';
import { isStationOnRoute } from '../utils/stationRoute';
import type { Route } from '../utils/stationRoute';
import type { Station } from '../types/station';
import { alarmKey, evaluateAlarmPhase } from '../utils/stationAlarm';
import { distanceMetersBetween, estimateEtaSeconds } from '../utils/stationEta';
import { resolveNextTarget } from '../utils/stationPipeline';
import { sendAlarmNotification, sendStationPassedNotification } from '../utils/stationNotification';
import { getLastNotifiedStationId, setLastNotifiedStationId } from '../utils/notificationState';
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
    let cancelled = false;
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
    // 알림 상태는 notificationState 모듈(AsyncStorage)을 단일 출처로 사용해
    // Foreground/Background 양쪽에서 동일한 dedup이 적용된다.
    // cancellation: 효과 cleanup이 cancelled를 true로 만들어 stale IIFE를 중단시킨다.
    // A→B→A 빠른 변동 시 이전 IIFE들이 cancelled로 차단되고 최신 candidate만 알림을 보낸다.
    if (nearestStation && route && isStationOnRoute(nearestStation, route)) {
      const candidateStation = nearestStation;
      const capturedRoute = route;
      const capturedDestinationName = destination.name;

      void (async () => {
        try {
          const lastId = await getLastNotifiedStationId();
          if (cancelled) return;
          if (candidateStation.id === lastId) return;
          const target = resolveNextTarget(capturedRoute, capturedDestinationName);
          // 알림 발송 성공 후에만 storage write — 발송 실패 시 다음 폴링에서 재시도 가능.
          await sendStationPassedNotification(
            candidateStation.name,
            capturedDestinationName,
            target,
          );
          if (cancelled) return;
          await setLastNotifiedStationId(candidateStation.id);
        } catch (e) {
          logger.error('역 통과 알림 실패:', e);
        }
      })();
    }

    return () => {
      cancelled = true;
    };
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
