import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { ALARM_PHASES, type AlarmPhaseId } from './alarmPhases';
import { alarmKey, resolveAllTargets, type AlarmEvent } from './stationAlarm';
import { calculateStaticETA, type Route } from '../../../shared/utils/stationRoute';
import { buildAlarmContent } from './stationNotification';
import { createLogger } from '../../../shared/utils/logger';
import { logScheduledAlarm, type AlarmLogDirection } from './alarmLog';
import { getLastNotifiedStationId } from './notificationState';

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

export interface ParsedScheduledAlarmIdentifier {
  phaseId: string;
  stationName: string;
}

/**
 * scheduledAlarmIdentifier()의 역연산. prefix가 다르거나 phaseId/stationName이 비어 있으면 null.
 * 사전 예약 알람을 OS에서 수신했을 때 phase/역 정보를 복원하는 유일한 경로다.
 */
export function parseScheduledAlarmIdentifier(
  identifier: string,
): ParsedScheduledAlarmIdentifier | null {
  if (!identifier.startsWith(SCHEDULED_ALARM_PREFIX)) return null;
  const rest = identifier.slice(SCHEDULED_ALARM_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const stationName = rest.slice(colon + 1);
  if (!stationName) return null;
  return { phaseId: rest.slice(0, colon), stationName };
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
   * Seoul Arrival API 첫 결과 — 사용자 진행 방향의 열차가 **현재역에 도착하기까지** 남은 ETA(초).
   * 호출자는 방향을 한쪽만 골라 넘겨야 한다 (반대방향 열차 ETA가 섞이면 안 됨).
   * null이면 calculateStaticETA로 목적지 ETA를 fallback 계산한다.
   */
  currentStationApproachEtaSeconds: number | null;
  /**
   * 관찰용 컨텍스트 stamp (#372). 발사 시점 진단을 위해 alarmLog에 함께 적재한다.
   * 정책에는 영향을 주지 않으며, 모르는 caller는 생략하면 모든 필드 null로 기록된다.
   */
  stamp?: {
    direction: AlarmLogDirection | null;
    usedTrainCode: string | null;
  };
  /** 테스트에서 시각 주입용. 기본값은 Date.now(). */
  now?: number;
}

/**
 * route + destination ETA → 각 waypoint별 (early, imminent) 두 phase에 대해
 * 절대 시각으로 사전 예약. BG에서 "사용 중" 권한만으로도 알람이 발사된다.
 *
 * waypoint별 시각은 누적 정거장 수 비율로 finalEtaSeconds를 안분한다.
 * 과거 시각으로 산출된 알람은 건너뛴다.
 *
 * #866 진단 로그(`logger.warn`)는 OS 사전 예약 큐가 0건으로 보고되는 회귀를 분류한다:
 *   (a) total-stops-zero     — totalStops=0 (route stops=0)
 *   (b)/(c) all-phases-skipped — 모든 fireSeconds<=0 (finalEta가 너무 작거나 lead 부족)
 *   (d) scheduleNotificationAsync throw — caller의 `.catch((e) => logger.error(...))` 경로로 전파
 * 정상 경로(매 cycle 호출, trip 30분당 360회+)에서는 일체 warn하지 않는다. 이상 분기에서만 warn.
 */
export async function scheduleAlarmsForRoute(
  params: ScheduleAlarmsParams,
): Promise<ScheduledAlarm[]> {
  const {
    route,
    destinationName,
    currentStationApproachEtaSeconds,
    stamp,
    now = Date.now(),
  } = params;

  const targets = resolveAllTargets(route, destinationName);
  const totalStops = targets.reduce((sum, t) => sum + t.stops, 0);

  if (totalStops === 0) {
    // (a) 분기 — resolveAllTargets가 모든 waypoint stops=0(direct stops=0 등).
    logger.warn(
      `scheduleAlarms skip reason=total-stops-zero targets=${targets
        .map((t) => `${t.name}/${t.stops}`)
        .join(',')} approachEta=${currentStationApproachEtaSeconds ?? 'null'} routeType=${route.type}`,
    );
    return [];
  }

  const finalEtaSeconds = resolveFinalEtaSeconds(currentStationApproachEtaSeconds, totalStops, route);

  // 발사 시점 비교용으로, 예약 직전 LAST_NOTIFIED_STATION을 한 번만 읽는다.
  // 발사 시 실제 값과 다르면 "예상한 위치와 실제 위치가 어긋났다"는 진단 신호.
  const actualLastNotifiedStation = await getLastNotifiedStationId();
  const stampDirection = stamp?.direction ?? null;
  const stampTrainCode = stamp?.usedTrainCode ?? null;

  const scheduled: ScheduledAlarm[] = [];
  const skipped: string[] = [];
  let cumulativeStops = 0;

  for (const target of targets) {
    cumulativeStops += target.stops;
    const waypointEtaSeconds = (cumulativeStops / totalStops) * finalEtaSeconds;

    for (const phase of ALARM_PHASES) {
      const fireSeconds = waypointEtaSeconds - PHASE_LEAD_SECONDS[phase.id];
      if (fireSeconds <= 0) {
        // (b)/(c) 분기 — fireSeconds<=0. ETA fallback이 작거나 lead 대비 ETA 부족.
        skipped.push(`${target.name}/${phase.id}/${fireSeconds.toFixed(1)}`);
        continue;
      }

      const event: AlarmEvent = {
        phaseId: phase.id,
        type: target.alarmType,
        stationName: target.name,
      };
      const identifier = scheduledAlarmIdentifier(event);
      const fireDate = new Date(now + fireSeconds * 1000);
      const { title, body } = buildAlarmContent(event);

      // #866 (d) 분기 — scheduleNotificationAsync가 throw하면 caller(useScheduledAlarms)의
      // `.catch((e) => logger.error('재예약 실패:', e))` 경로로 그대로 전파. try/catch를 두면
      // error → warn 강등으로 운영 알람 신호가 사라지므로 명시적으로 전파한다.
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

      logScheduledAlarm(event, {
        direction: stampDirection,
        usedTrainCode: stampTrainCode,
        selectedArrivalSeconds: currentStationApproachEtaSeconds,
        // 발사 시 사용자가 도착해 있어야 하는 역 = 알람 대상 역 직전.
        // 현재 스케줄러는 station ordinal 정보를 갖지 않아 target.name으로 기록한다.
        // 진단 시 stationName과 함께 보면 "어느 알람이었나"가 명확해진다.
        expectedStationAtFire: target.name,
        actualLastNotifiedStation,
      });
    }
  }

  // #866 — scheduled=0인 이상 분기(b/c)만 warn. 정상 경로(reschedule이 30분 trip당 360회 호출)
  // 에서 enter/done warn을 모두 출력하면 USB Console에서 진단 신호가 noise에 묻힌다.
  if (scheduled.length === 0) {
    logger.warn(
      `scheduleAlarms skip reason=all-phases-skipped totalStops=${totalStops} finalEta=${finalEtaSeconds.toFixed(
        1,
      )} approachEta=${currentStationApproachEtaSeconds ?? 'null'} skips=${skipped.join('|')}`,
    );
  } else {
    logger.info(`scheduled ${scheduled.length} alarms for ${targets.length} waypoints`);
  }
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
 * "현재역에 열차가 도착하기까지 남은 시간"을 받아 최종 목적지 ETA를 추정한다.
 *
 * 의미: 사용자는 현재역 플랫폼에서 진행 방향 열차를 기다리는 중이라고 가정한다.
 *   - approachEta(T)초 후 열차 도착 → 탑승
 *   - 이후 totalStops 정거장 이동 × ONE_STOP_SECONDS
 *   - 최종 ETA = T + totalStops × ONE_STOP_SECONDS
 *
 * 환승 페널티는 무시한다 — Phase 1 baseline. 정확도는 reschedule(#335)이 보정.
 * approachEta가 없거나 0 이하이면 calculateStaticETA(분)로 fallback.
 */
function resolveFinalEtaSeconds(
  currentStationApproachEtaSeconds: number | null,
  totalStops: number,
  route: NonNullable<Route>,
): number {
  if (currentStationApproachEtaSeconds != null && currentStationApproachEtaSeconds > 0) {
    return currentStationApproachEtaSeconds + totalStops * ONE_STOP_SECONDS;
  }
  // calculateStaticETA는 NonNullable Route에 대해 항상 number를 반환한다.
  return (calculateStaticETA(route) as number) * 60;
}
