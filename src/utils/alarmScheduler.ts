import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { ALARM_PHASES, type AlarmPhaseId } from './alarmPhases';
import { alarmKey, resolveAllTargets, type AlarmEvent } from './stationAlarm';
import { calculateStaticETA, type Route } from './stationRoute';
import { buildAlarmContent } from './stationNotification';
import { createLogger } from './logger';

const logger = createLogger('AlarmScheduler');

const SCHEDULED_ALARM_PREFIX = 'alarm:';
const ONE_STOP_SECONDS = 90;
const IMMINENT_LEAD_SECONDS = 10;
const ALARM_CHANNEL_ID = 'station-alarm';

const PHASE_LEAD_SECONDS: Record<AlarmPhaseId, number> = {
  early: ONE_STOP_SECONDS,
  imminent: IMMINENT_LEAD_SECONDS,
};

export function scheduledAlarmIdentifier(event: Pick<AlarmEvent, 'phaseId' | 'stationName'>): string {
  return `${SCHEDULED_ALARM_PREFIX}${alarmKey(event)}`;
}

export interface ScheduledAlarm {
  identifier: string;
  event: AlarmEvent;
  fireDate: Date;
}

export interface ScheduleAlarmsParams {
  route: NonNullable<Route>;
  destinationName: string;
  /**
   * Seoul Arrival API 첫 결과 — 다음 도착역까지 ETA(초).
   * null이면 calculateStaticETA로 목적지 ETA를 fallback 계산한다.
   */
  nextStationEtaSeconds: number | null;
  /** 테스트에서 시각 주입용. 기본값은 Date.now(). */
  now?: number;
}

/**
 * route + destination ETA → 각 waypoint별 (early, imminent) 두 phase에 대해
 * 절대 시각으로 사전 예약. BG에서 "사용 중" 권한만으로도 알람이 발사된다.
 *
 * waypoint별 시각은 누적 정거장 수 비율로 finalEtaSeconds를 안분한다.
 * 과거 시각으로 산출된 알람은 건너뛴다.
 */
export async function scheduleAlarmsForRoute(
  params: ScheduleAlarmsParams,
): Promise<ScheduledAlarm[]> {
  const { route, destinationName, nextStationEtaSeconds, now = Date.now() } = params;

  const targets = resolveAllTargets(route, destinationName);
  const totalStops = targets.reduce((sum, t) => sum + t.stops, 0);
  if (totalStops === 0) return [];

  const finalEtaSeconds = resolveFinalEtaSeconds(nextStationEtaSeconds, totalStops, route);

  const scheduled: ScheduledAlarm[] = [];
  let cumulativeStops = 0;

  for (const target of targets) {
    cumulativeStops += target.stops;
    const waypointEtaSeconds = (cumulativeStops / totalStops) * finalEtaSeconds;

    for (const phase of ALARM_PHASES) {
      const fireSeconds = waypointEtaSeconds - PHASE_LEAD_SECONDS[phase.id];
      if (fireSeconds <= 0) continue;

      const event: AlarmEvent = {
        phaseId: phase.id,
        type: target.alarmType,
        stationName: target.name,
      };
      const identifier = scheduledAlarmIdentifier(event);
      const fireDate = new Date(now + fireSeconds * 1000);
      const { title, body } = buildAlarmContent(event);

      await Notifications.scheduleNotificationAsync({
        identifier,
        content: {
          title,
          body,
          sound: 'alarm.wav',
          ...(Platform.OS === 'android' && {
            channelId: ALARM_CHANNEL_ID,
            priority: Notifications.AndroidNotificationPriority.MAX,
          }),
          ...(Platform.OS === 'ios' && { interruptionLevel: 'timeSensitive' as const }),
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireDate },
      });

      scheduled.push({ identifier, event, fireDate });
    }
  }

  logger.info(`scheduled ${scheduled.length} alarms for ${targets.length} waypoints`);
  return scheduled;
}

/**
 * 본 모듈이 예약한 알람만 취소한다 (prefix로 필터). 다른 알림은 건드리지 않는다.
 */
export async function cancelScheduledAlarms(): Promise<void> {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  let cancelled = 0;
  for (const req of all) {
    if (req.identifier.startsWith(SCHEDULED_ALARM_PREFIX)) {
      await Notifications.cancelScheduledNotificationAsync(req.identifier);
      cancelled++;
    }
  }
  logger.info(`cancelled ${cancelled} scheduled alarms`);
}

/**
 * 첫 도착역까지의 ETA로부터 최종 목적지 ETA를 추정한다.
 * API 값이 있으면: nextStation ETA + (남은 정거장 - 1) × 90s.
 * 환승 페널티는 무시한다 — Phase 1 baseline. 정확도는 reschedule(#335)이 보정.
 * 없으면 calculateStaticETA(분)로 fallback.
 */
function resolveFinalEtaSeconds(
  nextStationEtaSeconds: number | null,
  totalStops: number,
  route: NonNullable<Route>,
): number {
  if (nextStationEtaSeconds != null && nextStationEtaSeconds > 0) {
    return nextStationEtaSeconds + (totalStops - 1) * ONE_STOP_SECONDS;
  }
  // calculateStaticETA는 NonNullable Route에 대해 항상 number를 반환한다.
  return (calculateStaticETA(route) as number) * 60;
}
