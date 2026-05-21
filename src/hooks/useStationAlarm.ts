import { useEffect, useRef, useState } from 'react';
import { isStationOnRoute } from '../utils/stationRoute';
import type { Route } from '../utils/stationRoute';
import type { Station } from '../types/station';
import { alarmKey, evaluateAlarmPhase } from '../utils/stationAlarm';
import { resolveAlarmDirection } from '../utils/alarmDirection';
import { distanceMetersBetween, estimateEtaSeconds } from '../utils/stationEta';
import { resolveNextTarget } from '../utils/stationPipeline';
import { sendAlarmNotification, sendStationPassedNotification } from '../utils/stationNotification';
import {
  getLastNotifiedStationId,
  setLastNotifiedStationId,
  getFiredAlarms,
  setFiredAlarms,
} from '../utils/notificationState';
import { awaitInitialScheduledAlarmDrain } from '../utils/scheduledAlarmReceiver';
import {
  logFiredAlarm,
  logFiredStationPassed,
  logSuppressedDedupStation,
} from '../utils/alarmLog';
import { useAppStore } from '../store/useAppStore';
import { createLogger } from '../utils/logger';
import { isAccuracyAcceptable } from '../utils/locationGates';
import type { FusionConfidence } from '../utils/pickFusedStation';

const logger = createLogger('StationAlarm');

export interface UseStationAlarmInputs {
  route: Route;
  destination: Station | null;
  nearestStation: Station | null;
  userLocation: { lat: number; lng: number } | null;
  speedMps: number | null;
  accuracyMeters: number | null;
  /**
   * useFusedNearestStation의 신뢰도. 'arrival-confirmed'(arvlCd=1 도착 신호)면
   * GPS accuracy 게이트가 막혀도 station-passed 알람을 발화한다 — 지하 깊은 구간
   * (accuracy > 200m) 알람 누락 해소. ETA 기반 phase 알람은 거리 계산이 필요해 GPS 게이트 유지.
   */
  arrivalConfidence?: FusionConfidence;
}

export function useStationAlarm({
  route,
  destination,
  nearestStation,
  userLocation,
  speedMps,
  accuracyMeters,
  arrivalConfidence,
}: UseStationAlarmInputs): void {
  const firedAlarmsRef = useRef<Set<string>>(new Set());
  // firedAlarms hydration: BG가 AsyncStorage(FIRED_ALARMS_KEY)에 쓴 dedup 상태를
  // destination별로 격리해 복원한다(#462). hydrated=false인 동안 phase 평가를 보류해
  // 빈 ref로 false re-fire가 발생하지 않도록 가드한다.
  const [firedHydrated, setFiredHydrated] = useState(false);
  const destinationId = destination?.id ?? null;
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

  // destination별 firedAlarms 하이드레이션 (#462).
  // destination이 바뀌면 storage의 destinationId와 일치하지 않는 entry는 자동 빈 set 반환.
  // → cross-trip stale state가 새 trip의 evaluator를 오염시키지 않는다.
  useEffect(() => {
    let cancelled = false;
    setFiredHydrated(false);
    void (async () => {
      // 사전 예약 알람의 첫 drain이 완료된 후 read해야 cold start 직후
      // BG-fired 알람이 dedup set에 반영된 상태로 hydrate된다.
      await awaitInitialScheduledAlarmDrain();
      const stored = await getFiredAlarms(destinationId);
      if (cancelled) return;
      firedAlarmsRef.current = stored;
      setFiredHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [destinationId]);

  // Phase 알람 효과: ETA 기반 phase 평가 + firedAlarms 갱신.
  // firedHydrated=false인 동안에는 보류 — BG가 이미 발화한 phase를 빈 ref로 재발화하는 것을 막는다.
  // station-passed와 분리: 하이드레이션 완료로 인한 effect 재실행이 station-passed 중복 발사를
  // 일으키지 않도록 한다(station-passed는 자체 lastNotifiedStationId dedup만 사용).
  useEffect(() => {
    if (!firedHydrated) return;

    if (!route || !destination) return;

    // 알람 경로는 표시 경로보다 엄격한 정확도 게이트(MAX_ACCURACY_M=200m)를 적용한다.
    // useNearestStation은 지하 구간에서 정확도 1500m까지 표시용으로 수용하므로,
    // 그대로 알람을 울리면 잘못된 역에서 false alarm이 발생한다.
    // Phase 알람은 ETA 거리 계산이 필요해 GPS 게이트가 통과한 경우에만 평가한다.
    if (!isAccuracyAcceptable(accuracyMeters)) return;

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

    const rawEvent = evaluateAlarmPhase(
      { route, destinationName: destination.name, etaSeconds },
      firedAlarmsRef.current,
    );
    if (rawEvent) {
      // 좌/우 안내를 위한 진행방향. 출발 anchor가 없거나(nearestStation 미정) 결정 불가하면
      // direction은 undefined로 남고, 본문에 좌/우 라인이 추가되지 않는다.
      const direction = nearestStation
        ? resolveAlarmDirection(rawEvent, {
            route,
            destinationName: destination.name,
            sourceStationName: nearestStation.name,
          })
        : undefined;
      const event = direction ? { ...rawEvent, direction } : rawEvent;
      firedAlarmsRef.current.add(alarmKey(event));
      // AsyncStorage에도 즉시 반영 — FG/BG 단일 출처 유지. destinationId scoped.
      void setFiredAlarms(destination.id, firedAlarmsRef.current);
      if (sleepModeRef.current) {
        setAlarmEvent(event);
      }
      sendAlarmNotification(event, sleepModeRef.current, allowSpeakerRef.current).catch((e) =>
        logger.error('알람 알림 실패:', e),
      );
      logFiredAlarm('fg', event);
    }
  }, [
    route,
    destination?.id,
    destination?.name,
    destination?.lat,
    destination?.lng,
    userLocation?.lat,
    userLocation?.lng,
    speedMps,
    accuracyMeters,
    firedHydrated,
    setAlarmEvent,
    nearestStation?.id,
  ]);

  // Station-passed 알림 효과: 경로상 역 변경 시 dedup된 per-station 알림.
  // dedup은 AsyncStorage(lastNotifiedStationId)를 단일 출처로 사용 — Foreground/Background
  // 양쪽에서 동일하게 적용된다. firedHydrated에 의존하지 않으므로 하이드레이션 완료가
  // station-passed를 재발사시키지 않는다.
  // #452: deps에 raw accuracyMeters를 두면 GPS 노이즈로 매 fix 재실행 → dedup-suppressed
  // 로그가 cap까지 차서 다른 진단을 밀어낸다. 게이트 통과 여부(boolean)만 dep로 둔다.
  const accuracyOk = isAccuracyAcceptable(accuracyMeters);
  const arrivalConfirmed = arrivalConfidence === 'arrival-confirmed';

  useEffect(() => {
    let cancelled = false;
    if (!route || !destination) return;

    if (!accuracyOk && !arrivalConfirmed) return;

    // cancellation: 효과 cleanup이 cancelled를 true로 만들어 stale IIFE를 중단시킨다.
    // A→B→A 빠른 변동 시 이전 IIFE들이 cancelled로 차단되고 최신 candidate만 알림을 보낸다.
    if (nearestStation && isStationOnRoute(nearestStation, route)) {
      const candidateStation = nearestStation;
      const capturedRoute = route;
      const capturedDestinationName = destination.name;

      void (async () => {
        try {
          const lastId = await getLastNotifiedStationId();
          if (cancelled) return;
          if (candidateStation.id === lastId) {
            logSuppressedDedupStation('fg', candidateStation);
            return;
          }
          const target = resolveNextTarget(capturedRoute, capturedDestinationName);
          // 알림 발송 성공 후에만 storage write — 발송 실패 시 다음 폴링에서 재시도 가능.
          await sendStationPassedNotification(
            candidateStation.name,
            capturedDestinationName,
            target,
          );
          if (cancelled) return;
          await setLastNotifiedStationId(candidateStation.id);
          logFiredStationPassed('fg', candidateStation);
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
    nearestStation?.id,
    accuracyOk,
    arrivalConfirmed,
  ]);
}
