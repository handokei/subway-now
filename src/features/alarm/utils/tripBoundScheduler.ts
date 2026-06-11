import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ALARM_PHASES, type AlarmPhaseId } from './alarmPhases';
import { alarmKey, resolveAllTargets, type AlarmEvent } from './stationAlarm';
import { buildAlarmContent } from './stationNotification';
import type { AlarmType } from '../../../shared/types/alarm';
import { isSameStationName, type Route } from '../../../shared/utils/stationRoute';
import { HOP_TIME_MS } from '../../../shared/constants/boardingLock';
import { TRIP_BOUND_ROUTE_SIG_KEY } from '../../../shared/constants/storageKeys';
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
 * #918 A3 PR3 — rolling window 64 cap 회피용 윈도우 크기 (stop 단위).
 *
 * iOS는 앱당 pending local notification 64개 한도. 한 stop당 (early, imminent) 2개씩 예약되므로
 * `TRIPBOUND_WINDOW_SIZE * 2`가 tba: 채널이 OS 큐에서 점유하는 상한이다. 20 stop으로 둔 이유:
 *  - tba: 40개 + bl: 채널 6~8개(현재 windowSize 3 × 2 phase, 다음 leg 진입 시 일시적 중복 포함)
 *    + 시스템(silent push delivery 1~2건) ≈ 50개 — 64 cap 안쪽 안전 마진.
 *  - 평균 trip 길이(서울 1~9호선 30~40 stop) 대비 절반 이상 커버해, 사용자 통과 1회당 top-up 1회로
 *    rolling이 매끄럽게 진행된다 — 너무 작으면(예: 5) top-up이 매역 발생해 storage I/O 부담.
 *  - 64 cap에 너무 가까우면(예: 30) bl: 채널이 lock 전환기에 일시적으로 부풀 때 cap 초과 위험.
 */
export const TRIPBOUND_WINDOW_SIZE = 20;

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
  /**
   * #918 A3 PR3 — rolling window. 예약할 stop 개수 상한. 미지정이면 routeStops 전체.
   * `startTime` 누적은 항상 routeStops[0]부터 시작하므로 windowSize는 "앞에서 N개만 예약"으로
   * 동작한다. 매역 통과 시 `topUpTripBoundWindow`가 다음 N개로 rolling.
   */
  windowSize?: number;
  /**
   * #918 A3 PR3 — top-up 진입점용. 누적은 routeStops[0]부터 진행하되, 실제 OS schedule은
   * `startStopIndex` 이상인 stop에만 호출한다 (그 이전 stop은 이미 cancel됨).
   * 미지정이면 0. 호출자(topUpTripBoundWindow)는 passedIndex+1을 넘긴다.
   *
   * 이 옵션을 두는 이유: top-up도 fire 시각을 같은 startTime + 누적 hop으로 산출해야
   * 초기 preschedule과 정확히 동일한 fire 시각을 보장한다. 그렇지 않으면 매역 통과마다
   * 누적 오차가 쌓여 imminent가 실제 도착 시각과 어긋난다.
   */
  startStopIndex?: number;
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
  const { routeStops, estimatedHopTimesMs, startTime, windowSize, startStopIndex = 0 } = params;

  if (routeStops.length !== estimatedHopTimesMs.length) {
    logger.warn(
      `preschedule skip reason=length-mismatch stops=${routeStops.length} hops=${estimatedHopTimesMs.length}`,
    );
    return [];
  }
  if (routeStops.length === 0) {
    return [];
  }

  // window 상한 — 미지정이면 전체. 호출자가 명시한 음수/0이면 0 stop schedule(자연스럽게 no-op).
  // startStopIndex 음수 입력은 0으로 clamp — caller(top-up) bug 흡수.
  const effectiveStartIndex = startStopIndex < 0 ? 0 : startStopIndex;
  const effectiveWindowSize = windowSize === undefined ? routeStops.length : windowSize;
  const scheduleEndIndex = Math.min(
    routeStops.length,
    effectiveStartIndex + Math.max(0, effectiveWindowSize),
  );

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

      // 같은 station이 route 안에 중복 등장하는 경우, identifier 충돌을 피하기 위해 occurrence 누적은
      // 윈도우 밖 stop에서도 진행해야 한다 (초기 preschedule과 top-up 호출에서 동일 identifier 산출 보장).
      const occKey = `${phase.id}:${stop.stationName}`;
      const occIdx = phaseStationOccurrence.get(occKey) ?? 0;
      phaseStationOccurrence.set(occKey, occIdx + 1);

      // 윈도우 밖 stop은 누적/occurrence 진행만, OS schedule은 skip — fire 시각/identifier 정렬 보존.
      if (i < effectiveStartIndex || i >= scheduleEndIndex) continue;

      const event: AlarmEvent = {
        phaseId: phase.id,
        type: stop.alarmType,
        stationName: stop.stationName,
      };
      const baseId = tripBoundAlarmIdentifier(event);
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
 * identifier 형식: `tba:${phaseId}:${stationName}` 또는 같은 (phaseId, stationName) 중복 시
 * `tba:${phaseId}:${stationName}:${n}` (n ≥ 1).
 * alarmScheduler의 `alarm:` prefix와 분리해 trip-bound 사전 예약만 식별/취소한다.
 */
export function tripBoundAlarmIdentifier(
  event: Pick<AlarmEvent, 'phaseId' | 'stationName'>,
): string {
  return `${TRIP_BOUND_ALARM_PREFIX}${alarmKey(event)}`;
}

export interface ParsedTripBoundAlarmIdentifier {
  phaseId: string;
  stationName: string;
}

/**
 * `tripBoundAlarmIdentifier()`의 역연산 (#918 A3 PR2). prefix 매칭 + phaseId/stationName 분리.
 * 같은 station이 route 안에 두 번 등장해 `:n` occurrence suffix가 붙은 경우(`prescheduleStationAlerts`
 * 내부 로직)에도 station name 안에 콜론이 합쳐진 채 반환된다 — 이후 waypoint 매칭 단계에서 자연스럽게
 * mismatch로 떨어지므로 별도 후처리는 불필요(재검증 안전).
 *
 * prefix가 다르거나 phaseId/stationName이 비어 있으면 null.
 */
export function parseTripBoundAlarmIdentifier(
  identifier: string,
): ParsedTripBoundAlarmIdentifier | null {
  if (!identifier.startsWith(TRIP_BOUND_ALARM_PREFIX)) return null;
  const rest = identifier.slice(TRIP_BOUND_ALARM_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const stationName = rest.slice(colon + 1);
  if (!stationName) return null;
  return { phaseId: rest.slice(0, colon), stationName };
}

/**
 * #918 A3 PR2 (#729 흡수) — preschedule 시점의 route signature 영속화 SSOT.
 * useTripBoundAlarmScheduler가 preschedule 성공 직후 1회 write하고, cancel 시 clear한다.
 * scheduledAlarmReceiver가 fire 시점에 *현재* sig와 비교해 stale 알람을 식별한다.
 *
 * 모든 함수는 graceful — storage 실패는 측정 정확도만 영향, 본 흐름 무관.
 */
export async function setRegisteredTripRouteSig(sig: string): Promise<void> {
  try {
    await AsyncStorage.setItem(TRIP_BOUND_ROUTE_SIG_KEY, sig);
  } catch {
    // graceful — 다음 preschedule cycle에서 재시도.
  }
}

export async function getRegisteredTripRouteSig(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(TRIP_BOUND_ROUTE_SIG_KEY);
  } catch {
    return null;
  }
}

export async function clearRegisteredTripRouteSig(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRIP_BOUND_ROUTE_SIG_KEY);
  } catch {
    // graceful.
  }
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

export interface TopUpTripBoundWindowParams extends PrescheduleParams {
  /**
   * Fusion 등에서 통과 보고된 stop의 stationName. routeStops에 존재해야 effect 발생.
   * resolveAllTargets canonical name 기준 — caller가 `isSameStationName`으로 매칭해 넘긴다.
   */
  passedStationName: string;
}

export interface TopUpTripBoundWindowResult {
  cancelled: number;
  scheduled: number;
}

/**
 * #918 A3 PR3 — rolling window top-up.
 *
 * Fusion이 새 stop을 통과 보고하면 호출. 통과한 stop과 그 이전 stop의 사전 예약 알람을 cancel하고,
 * `[passedIndex+1, passedIndex+1+windowSize)` 범위에서 큐에 없는 hop을 채워 예약한다.
 *
 * `boardingLockScheduler.advanceHopWindow`와 동일 패턴 — lock-free trip-bound 예약 채널에 적용.
 * iOS 64 pending notification cap을 회피하기 위해 한 번에 큐에 두는 stop 수를 `windowSize` 이하로
 * 유지한다(기본 {@link TRIPBOUND_WINDOW_SIZE}).
 *
 * - `passedStationName`이 routeStops에 없으면 no-op (no-cancel, no-schedule).
 * - 큐가 이미 정확한 윈도우 상태면 cancel 0건 + schedule은 idempotent overwrite로 진행되지만
 *   호출이 빈번하면 OS 부하 — 호출자가 직전 passedStationName을 기억해 중복 호출을 차단해야 한다
 *   (`useTripBoundAlarmScheduler` 책임).
 * - FG resume 시 같은 함수로 진입 가능 — passedStationName이 가장 최근 통과한 stop이면 동작 일관.
 */
export async function topUpTripBoundWindow(
  params: TopUpTripBoundWindowParams,
): Promise<TopUpTripBoundWindowResult> {
  const {
    routeStops,
    estimatedHopTimesMs,
    startTime,
    passedStationName,
    windowSize = TRIPBOUND_WINDOW_SIZE,
  } = params;

  if (routeStops.length === 0) {
    return { cancelled: 0, scheduled: 0 };
  }

  const passedIndex = routeStops.findIndex((s) => s.stationName === passedStationName);
  if (passedIndex === -1) {
    return { cancelled: 0, scheduled: 0 };
  }

  // 새 윈도우 범위 = [nextStartIndex, nextEndIndex).
  const nextStartIndex = passedIndex + 1;
  const nextEndIndex = Math.min(routeStops.length, nextStartIndex + windowSize);

  // 이미 큐에 있는 `tba:` 알람 중 새 윈도우 밖에 해당하는 것만 cancel.
  // routeStops[i]의 stationName이 윈도우 안에 있는지 빠르게 판별하기 위한 set.
  const inWindowStationNames = new Set<string>();
  for (let i = nextStartIndex; i < nextEndIndex; i++) {
    inWindowStationNames.add(routeStops[i].stationName);
  }

  const all = await Notifications.getAllScheduledNotificationsAsync();
  let cancelled = 0;
  for (const req of all) {
    if (!req.identifier.startsWith(TRIP_BOUND_ALARM_PREFIX)) continue;
    const parsed = parseTripBoundAlarmIdentifier(req.identifier);
    if (parsed === null) continue;
    // occurrence suffix가 붙은 경우 stationName에 ":n"이 포함된다 — 그래도 set lookup으로 mismatch 시
    // cancel 처리되므로 새 윈도우의 첫 등장 알람과 충돌하지 않는다.
    if (!inWindowStationNames.has(parsed.stationName)) {
      await Notifications.cancelScheduledNotificationAsync(req.identifier);
      cancelled++;
    }
  }

  // 윈도우 안 stop 예약 — idempotent overwrite. 누적 startTime 기반이라 fire 시각은 초기 preschedule과 동일.
  const scheduledAlarms = await prescheduleStationAlerts({
    routeStops,
    estimatedHopTimesMs,
    startTime,
    startStopIndex: nextStartIndex,
    windowSize,
  });

  logger.info(
    `topUp passedIndex=${passedIndex} window=[${nextStartIndex},${nextEndIndex}) cancelled=${cancelled} scheduled=${scheduledAlarms.length}`,
  );
  return { cancelled, scheduled: scheduledAlarms.length };
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
  // #918 A3 PR2: sig storage도 함께 cleanup — 다음 reconcile 시 stale sig가 남지 않게.
  await clearRegisteredTripRouteSig();
}
