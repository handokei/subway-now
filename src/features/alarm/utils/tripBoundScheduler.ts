import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { ALARM_PHASES, type AlarmPhaseId } from './alarmPhases';
import { alarmKey, resolveAllTargets, type AlarmEvent } from './stationAlarm';
import { buildAlarmContent } from './stationNotification';
import type { AlarmType } from '../../../shared/types/alarm';
import { isSameStationName, type Route } from '../../../shared/utils/stationRoute';
import { HOP_TIME_MS } from '../../../shared/constants/boardingLock';
import { createLogger } from '../../../shared/utils/logger';
import { recordScheduledAlarm } from './prescheduledMetrics';

const logger = createLogger('TripBoundScheduler');

/**
 * 새 identifier prefix — boarding-lock(#584)과 #335 reschedule 경로가 사용하는 `bl:` / `alarm:`
 * 와 분리해서 lock 무관 trip-bound 사전 예약만 prefix로 식별/취소한다.
 *
 * #918 (A3): 자동 lock 후에도 네트워크 0 환경에서 silent push가 못 가는 경우를 대비해
 * trip 등록 시점에 OS local notification을 사전 예약하는 일반화된 진입점.
 */
export const TRIP_BOUND_ALARM_PREFIX = 'tba:';

/** iOS interruption level (lock scheduler와 동일 정책 — early=active, imminent=timeSensitive). */
const PHASE_INTERRUPTION: Record<AlarmPhaseId, 'active' | 'timeSensitive'> = {
  early: 'active',
  imminent: 'timeSensitive',
};

/** Android channel id — stationNotification / alarmScheduler / boardingLockScheduler와 동일. */
const ALARM_CHANNEL_ID = 'station-alarm';

/** imminent phase 고정 lead(ms) — 도착 10초 전. early는 입력 `estimatedHopTimesMs[i]`를 그대로 사용. */
const IMMINENT_LEAD_MS = 10_000;

/**
 * 사전 예약 대상 단일 stop. lock-free — boarding lock 메타에 의존하지 않고,
 * 호출자가 route 어떤 형태(direct/transfer/multi-transfer)든 평탄화해 넘긴다.
 */
export interface TripBoundStop {
  /** 알람 본문/identifier에 들어갈 canonical 역명. resolveAllTargets의 target.name과 동일 규약. */
  stationName: string;
  /** transfer 또는 destination — 본문 문구가 갈린다. */
  alarmType: AlarmType;
}

export interface PrescheduleParams {
  /** trip의 stop 시퀀스(0..N-1). 비어 있으면 schedule 없이 0건 반환. */
  routeStops: ReadonlyArray<TripBoundStop>;
  /**
   * stop별 leg time(ms). `routeStops[i]`에 도달하기까지 직전 지점에서 걸리는 시간.
   * 길이는 routeStops와 같아야 한다.
   *
   * 누적합 = `startTime` 기준 stop i의 예상 도착 시각.
   * 또한 `estimatedHopTimesMs[i]` 자체가 stop i의 early phase lead(ms)로 사용된다 —
   * boardingLockScheduler.computeHopTimings와 동일 의미(`legSeconds/legStops` 평균).
   */
  estimatedHopTimesMs: ReadonlyArray<number>;
  /** 누적의 기준점. trip 등록 시각(ms epoch). */
  startTime: number;
}

export interface ScheduledTripBoundAlarm {
  identifier: string;
  event: AlarmEvent;
  fireDate: Date;
}

/**
 * trip 등록(자동 lock 직후 포함) 시점에 destinationName 까지 모든 stop에 대해
 * (early, imminent) OS local notification을 사전 예약한다. lock 유무와 무관.
 *
 * - 입력 검증: routeStops와 estimatedHopTimesMs의 길이가 다르면 0건. (호출자 contract 위반 — log warn)
 * - 과거 시각(`fireMs <= startTime`) 알람은 skip — 이미 지난 stop은 자동으로 생략.
 * - 어떤 phase도 예약되지 않으면 0건 반환 + warn (정상 trip은 ≥ 1건 나와야 함).
 * - scheduleNotificationAsync throw 시 caller로 그대로 전파 — alarmScheduler.ts 정책과 일치.
 *
 * 반환: 예약된 alarm 메타 배열(identifier/event/fireDate). 호출자가 추적용 큐를 별도로
 *       관리할 수 있다. cancelTripBoundAlarms()는 prefix 매칭만으로 일괄 취소한다.
 */
export async function prescheduleStationAlerts(
  params: PrescheduleParams,
): Promise<ScheduledTripBoundAlarm[]> {
  const { routeStops, estimatedHopTimesMs, startTime } = params;

  if (routeStops.length !== estimatedHopTimesMs.length) {
    logger.warn(
      `preschedule skip reason=length-mismatch stops=${routeStops.length} hops=${estimatedHopTimesMs.length}`,
    );
    return [];
  }
  if (routeStops.length === 0) {
    return [];
  }

  const scheduled: ScheduledTripBoundAlarm[] = [];
  let cumulativeMs = startTime;
  // wall-clock 가드: caller가 stale startTime을 넘겨도 이미 지난 시각으로 OS 큐에 등록되지 않게.
  // (iOS scheduleNotificationAsync는 과거 Date를 즉시 발사 — 잘못 입력 시 매역 알림 burst 회귀.)
  const nowMs = Date.now();
  // 같은 station이 route 안에 중복 등장(순환 노선 등) 시 identifier 충돌로 iOS가 silent overwrite한다.
  // 발생한 identifier를 추적해 두 번째 등장은 phaseId만으로 식별이 부족하므로 phase별 occurrenceIdx
  // suffix로 unique화한다 (cancelTripBoundAlarms는 prefix 매칭이라 영향 없음).
  const phaseStationOccurrence = new Map<string, number>();

  for (let i = 0; i < routeStops.length; i++) {
    const hopMs = estimatedHopTimesMs[i];
    // NaN/Infinity/음수 보호 — caller가 legSeconds/legStops를 legStops=0 가드 없이 계산한 케이스 등.
    if (!Number.isFinite(hopMs) || hopMs < 0) {
      logger.warn(
        `preschedule skip reason=invalid-hop stop=${routeStops[i].stationName} hopMs=${hopMs}`,
      );
      continue;
    }
    cumulativeMs += hopMs;
    const stop = routeStops[i];

    for (const phase of ALARM_PHASES) {
      const leadMs = phase.id === 'early' ? hopMs : IMMINENT_LEAD_MS;
      const fireMs = cumulativeMs - leadMs;
      // startTime 기준 + 실제 wall-clock 기준 두 조건 모두 통과해야 등록.
      if (fireMs <= startTime || fireMs <= nowMs) continue;

      const event: AlarmEvent = {
        phaseId: phase.id,
        type: stop.alarmType,
        stationName: stop.stationName,
      };
      const baseId = tripBoundAlarmIdentifier(event);
      const occKey = `${phase.id}:${stop.stationName}`;
      const occIdx = phaseStationOccurrence.get(occKey) ?? 0;
      phaseStationOccurrence.set(occKey, occIdx + 1);
      // 첫 등장은 base identifier 유지 (호환), 두 번째 이상은 :n suffix로 unique.
      const identifier = occIdx === 0 ? baseId : `${baseId}:${occIdx}`;
      const fireDate = new Date(fireMs);
      const { title, body } = buildAlarmContent(event);

      // scheduleNotificationAsync가 throw하면 caller로 전파 — alarmScheduler 정책 일치.
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
          ...(Platform.OS === 'ios' && { interruptionLevel: PHASE_INTERRUPTION[phase.id] }),
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireDate },
      });

      scheduled.push({ identifier, event, fireDate });
      // #918 A3 measurement — ledger에 적재해 trip 종료 시 fire delta / miss rate / station 정확도 산출.
      // 실패는 graceful (prescheduledMetrics 내부에서 try/catch — schedule 흐름 차단 안 함).
      // 순차 await — 동시 RMW가 서로 덮어쓰는 race 차단. 30+ 역 trip 1회 약 ~100-300ms 추가지만
      // 사전 예약은 trip 시작 시 1회만 발생하는 oneshot이라 허용.
      await recordScheduledAlarm({ identifier, scheduledFireMs: fireMs });
    }
  }

  if (scheduled.length === 0) {
    logger.warn(
      `preschedule skip reason=all-past stops=${routeStops.length} startTime=${startTime}`,
    );
  } else {
    logger.info(`prescheduled ${scheduled.length} alarms for ${routeStops.length} stops`);
  }
  return scheduled;
}

/**
 * identifier 형식: `tba:${phaseId}:${stationName}`.
 * alarmScheduler의 `alarm:` prefix와 분리해 trip-bound 사전 예약만 식별/취소한다.
 */
export function tripBoundAlarmIdentifier(
  event: Pick<AlarmEvent, 'phaseId' | 'stationName'>,
): string {
  return `${TRIP_BOUND_ALARM_PREFIX}${alarmKey(event)}`;
}

/**
 * #918 (caller-side helper): `route` + `destinationName`에서 prescheduleStationAlerts에 넘길
 * `routeStops` + `estimatedHopTimesMs`를 만든다.
 *
 * **계약**: routeStops는 *waypoint 단위*(transfer + destination만). 각 hop의 hopMs는 직전
 * waypoint→현 waypoint 전체 leg 시간(`legSeconds * 1000`). preschedule은 cumulative hop으로
 * fire 시각을 계산하므로 destination 알람은 boardedAt + 전체 trip 시간 - 10s에 발사된다.
 * (legSeconds/legStops 평균 X — 그 값은 station-level 시퀀스용이고 본 helper는 waypoint-level.
 *  self code-review에서 평균치 누적 시 imminent가 leg 1/legStops 위치에서 발사되는 회귀 식별.)
 *
 * - legSeconds≤0/NaN/Infinity 가드: HOP_TIME_MS fallback. 사용자에게 노출되는 알람 시각이
 *   NaN으로 OS 큐에 들어가는 회귀를 caller-side에서 차단(scheduler 본체의 `Number.isFinite`
 *   가드와 이중 안전).
 * - route=null 또는 destinationName=null이면 빈 배열 — 호출자(hook)는 cancel만 수행하고 schedule skip.
 */
export function deriveTripBoundStops(
  route: Route,
  destinationName: string | null,
): { routeStops: TripBoundStop[]; estimatedHopTimesMs: number[] } {
  if (!route || !destinationName) {
    return { routeStops: [], estimatedHopTimesMs: [] };
  }
  const targets = resolveAllTargets(route, destinationName);
  const routeStops: TripBoundStop[] = targets.map((t) => ({
    stationName: t.name,
    alarmType: t.alarmType,
  }));
  const estimatedHopTimesMs: number[] = targets.map((t, i) => {
    const legSeconds = legSecondsForHop(route, i, t.name);
    const legMs = legSeconds * 1000;
    if (!Number.isFinite(legMs) || legMs <= 0) return HOP_TIME_MS;
    return legMs;
  });
  return { routeStops, estimatedHopTimesMs };
}

/**
 * hopIndex / target name으로 route의 leg seconds 필드를 선택. boardingLockScheduler.legSecondsAt
 * 와 동일한 매핑(resolveAllTargets와 1:1 정렬). 두 곳을 합치는 SSOT 통합은 별도 PR.
 */
function legSecondsForHop(
  route: NonNullable<Route>,
  hopIndex: number,
  targetName: string,
): number {
  if (route.type === 'direct') return route.travelSeconds;
  if (route.type === 'transfer') {
    if (isSameStationName(route.transferName, targetName)) return route.secondsToTransfer;
    return route.secondsFromTransfer;
  }
  if (hopIndex < route.transfers.length) return route.transfers[hopIndex].secondsToTransfer;
  return route.secondsAfterLastTransfer;
}

/**
 * trip 종료(release / 목적지 도착 / 사용자 취소) 시 호출 — `tba:` prefix를 가진 모든 사전
 * 예약 알람을 OS 큐에서 제거한다. 다른 prefix(alarm:, bl:)는 건드리지 않는다.
 *
 * cancelScheduledNotificationAsync는 idempotent — 이미 발사된 알람도 안전하게 통과한다.
 */
export async function cancelTripBoundAlarms(): Promise<void> {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  let cancelled = 0;
  for (const req of all) {
    if (req.identifier.startsWith(TRIP_BOUND_ALARM_PREFIX)) {
      await Notifications.cancelScheduledNotificationAsync(req.identifier);
      cancelled++;
    }
  }
  if (cancelled > 0) {
    logger.info(`cancelled ${cancelled} trip-bound alarms`);
  }
}
