import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { ALARM_PHASES, type AlarmPhaseId } from './alarmPhases';
import { resolveAllTargets, type AlarmEvent, type CurrentTarget } from './stationAlarm';
import type { Route } from './stationRoute';
import { buildAlarmContent } from './stationNotification';
import type { BoardingLock } from '../types/boardingLock';
import {
  addScheduledNotificationIds,
  clearScheduledNotificationIds,
  getScheduledNotificationIds,
  removeScheduledNotificationIds,
} from './scheduledNotificationsStorage';
import { createLogger } from './logger';

const logger = createLogger('BoardingLockScheduler');

export const BOARDING_LOCK_ALARM_PREFIX = 'bl:';
// alarmScheduler.ts / stationNotification.ts에도 같은 리터럴이 있다. 채널 설정을 옮길 일이
// 생기면 src/constants/로 일괄 추출 — 현재는 surgical change 원칙상 PR D 진입 전 유지.
const ALARM_CHANNEL_ID = 'station-alarm';

/**
 * 정거장당 추정 이동 시간(초). PR C v1은 uniform 90s — 노선별/시간대별 정밀화는 후속.
 * 기존 alarmScheduler와 동일 값으로 두어 동시 동작 시 일관성 유지.
 */
const HOP_TIME_SECONDS = 90;

/**
 * Phase별 lead time. #584 SLA 설계(2026-05-28):
 *  - early : 1정거장 전(=HOP_TIME) — barvlDt 60s 단위 ±30s 오차 흡수
 *  - imminent : 45초 전 — timeSensitive interruption으로 BG 발사 보장
 */
const PHASE_LEAD_SECONDS: Record<AlarmPhaseId, number> = {
  early: HOP_TIME_SECONDS,
  imminent: 45,
};

/**
 * iOS interruption level mapping. early는 평소(active), imminent는 timeSensitive로
 * Focus/잠금화면 관통. critical Entitlement는 별도 진행 — 현재는 timeSensitive.
 */
const PHASE_INTERRUPTION: Record<AlarmPhaseId, 'active' | 'timeSensitive'> = {
  early: 'active',
  imminent: 'timeSensitive',
};

/** Per-Hop Adaptive Scheduling: 한 번에 큐에 두는 waypoint 수 (iOS 64 한도 안전). */
const DEFAULT_WINDOW_SIZE = 3;

export interface BoardingLockAlarmIdParts {
  trainCode: string;
  hopIndex: number;
  phase: AlarmPhaseId;
  stationName: string;
}

/**
 * identifier 형식: `bl:${trainCode}:${hopIndex}:${phase}:${stationName}`.
 *
 * - trainCode: 같은 Lock 안에서 모든 hop 알람이 공유 → Lock 단위 cancel 가능.
 * - hopIndex: waypoint별 cancel을 위한 인덱스 (역 통과 시 advanceHopWindow가 사용).
 * - phase: 'early' | 'imminent' — interruption level이 다름.
 * - stationName: 디버깅 가시성. parse는 처음 3개 ':'까지만 split.
 */
export function boardingLockAlarmIdentifier(parts: BoardingLockAlarmIdParts): string {
  return `${BOARDING_LOCK_ALARM_PREFIX}${parts.trainCode}:${parts.hopIndex}:${parts.phase}:${parts.stationName}`;
}

export function parseBoardingLockAlarmIdentifier(
  identifier: string,
): BoardingLockAlarmIdParts | null {
  if (!identifier.startsWith(BOARDING_LOCK_ALARM_PREFIX)) return null;
  const rest = identifier.slice(BOARDING_LOCK_ALARM_PREFIX.length);
  // stationName에 ':'이 포함될 가능성을 위해 앞쪽 3개까지만 split.
  const segs: string[] = [];
  let cursor = 0;
  for (let i = 0; i < 3; i++) {
    const next = rest.indexOf(':', cursor);
    if (next === -1) return null;
    segs.push(rest.slice(cursor, next));
    cursor = next + 1;
  }
  const trainCode = segs[0];
  const hopIndexRaw = segs[1];
  const phase = segs[2];
  const stationName = rest.slice(cursor);
  if (!trainCode || !hopIndexRaw || !stationName) return null;
  const hopIndex = Number(hopIndexRaw);
  if (!Number.isInteger(hopIndex) || hopIndex < 0) return null;
  if (phase !== 'early' && phase !== 'imminent') return null;
  return { trainCode, hopIndex, phase, stationName };
}

/**
 * 단일 hop(waypoint)에 대해 ALARM_PHASES 전체를 사전 예약하고 예약된 identifier 목록을 반환한다.
 * scheduleHopsForLock와 advanceHopWindow가 공통 사용 — 알림 본문/플랫폼 분기/interruption level이
 * 한 곳에서만 정의되도록 모은다.
 *
 * `arrivalMs - lead` 가 `observedMs` 이하면 해당 phase는 skip(과거 시각 가드).
 */
async function scheduleSingleHop(params: {
  lock: BoardingLock;
  target: CurrentTarget;
  hopIndex: number;
  arrivalMs: number;
  observedMs: number;
}): Promise<string[]> {
  const { lock, target, hopIndex, arrivalMs, observedMs } = params;
  const ids: string[] = [];
  for (const phase of ALARM_PHASES) {
    const fireMs = arrivalMs - PHASE_LEAD_SECONDS[phase.id] * 1000;
    if (fireMs <= observedMs) continue;
    const event: AlarmEvent = {
      phaseId: phase.id,
      type: target.alarmType,
      stationName: target.name,
    };
    const identifier = boardingLockAlarmIdentifier({
      trainCode: lock.trainCode,
      hopIndex,
      phase: phase.id,
      stationName: target.name,
    });
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
        ...(Platform.OS === 'ios' && { interruptionLevel: PHASE_INTERRUPTION[phase.id] }),
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(fireMs) },
    });
    ids.push(identifier);
  }
  return ids;
}

/**
 * 누적 stops 기반 절대 도착 시각(ms). hopIndex까지 모든 target의 stops를 합산해 lock.boardedAt에 더한다.
 */
function arrivalMsForHop(
  lock: BoardingLock,
  allTargets: CurrentTarget[],
  hopIndex: number,
): number {
  let cumulativeStops = 0;
  for (let i = 0; i <= hopIndex; i++) cumulativeStops += allTargets[i].stops;
  return lock.boardedAt + cumulativeStops * HOP_TIME_SECONDS * 1000;
}

async function cancelAndDismiss(ids: string[]): Promise<void> {
  for (const id of ids) {
    await Notifications.cancelScheduledNotificationAsync(id);
    try {
      await Notifications.dismissNotificationAsync(id);
    } catch {
      // 미발사 알람은 dismiss 대상 아님 — 무시.
    }
  }
}

export interface ScheduleHopsParams {
  lock: BoardingLock;
  route: NonNullable<Route>;
  destinationName: string;
  /** 누적 ETA 기준점 (ms epoch). 기본 lock.boardedAt. */
  now?: number;
  /** 큐에 둘 waypoint 개수. 기본 3. */
  windowSize?: number;
}

/**
 * Lock 시작 시점에 호출 — 다음 windowSize개 waypoint에 대해 (early, imminent) 알람을 예약한다.
 *
 * 예약된 identifier는 모두 AsyncStorage 추적 큐에 추가된다. 이후 cancelAllHopsForLock 또는
 * advanceHopWindow가 이 큐를 통해서만 cancel한다 — getAllScheduledNotifications를 호출하지 않는다.
 *
 * 과거 시각으로 산출되는 알람은 skip. waypoint stops=0(이미 도착)인 경우도 skip된다 (lead 차감 후 ≤0).
 */
export async function scheduleHopsForLock(params: ScheduleHopsParams): Promise<string[]> {
  const { lock, route, destinationName, now, windowSize = DEFAULT_WINDOW_SIZE } = params;
  const observedMs = now ?? lock.boardedAt;
  const allTargets = resolveAllTargets(route, destinationName);
  const lastIdx = Math.min(windowSize, allTargets.length);

  const scheduledIds: string[] = [];
  for (let hopIndex = 0; hopIndex < lastIdx; hopIndex++) {
    const ids = await scheduleSingleHop({
      lock,
      target: allTargets[hopIndex],
      hopIndex,
      arrivalMs: arrivalMsForHop(lock, allTargets, hopIndex),
      observedMs,
    });
    scheduledIds.push(...ids);
  }

  await addScheduledNotificationIds(scheduledIds);
  logger.info(
    `scheduled ${scheduledIds.length} alarms for lock ${lock.trainCode} (${lastIdx} hops)`,
  );
  return scheduledIds;
}

/**
 * 추적 큐에서 prefix + trainCode가 일치하는 identifier를 모두 cancel + dismiss + 큐에서 제거.
 *
 * release/expiry 또는 새 Lock 전환 시 호출. 추적 큐 밖의 알람은 건드리지 않는다 — 다른 모듈이
 * 같은 prefix로 예약했더라도 안전.
 */
export async function cancelAllHopsForLock(lock: BoardingLock): Promise<void> {
  const current = await getScheduledNotificationIds();
  const lockPrefix = `${BOARDING_LOCK_ALARM_PREFIX}${lock.trainCode}:`;
  const toCancel = current.filter((id) => id.startsWith(lockPrefix));
  if (toCancel.length === 0) return;

  await cancelAndDismiss(toCancel);
  await removeScheduledNotificationIds(toCancel);
  logger.info(`cancelled ${toCancel.length} alarms for lock ${lock.trainCode}`);
}

/**
 * 큐 전체를 비운다 — SCHEDULED_NOTIFICATIONS 키 안의 `bl:` prefix 항목만.
 * 마운트 시점 위생 처리용 (예: app restart 후 stale 큐 정리). cancelAllHopsForLock과 동일하게
 * 발사된 알람은 dismiss까지 시도한다.
 */
export async function purgeBoardingLockSchedulerQueue(): Promise<void> {
  const current = await getScheduledNotificationIds();
  if (current.length === 0) return;
  const ours = current.filter((id) => id.startsWith(BOARDING_LOCK_ALARM_PREFIX));
  await cancelAndDismiss(ours);
  await clearScheduledNotificationIds();
}

export interface AdvanceHopWindowParams {
  lock: BoardingLock;
  route: NonNullable<Route>;
  destinationName: string;
  /** 통과한 waypoint 이름. resolveAllTargets에 등록된 이름과 일치해야 한다. */
  passedStationName: string;
  now?: number;
  windowSize?: number;
}

/**
 * 역 통과 시 호출 — `hopIndex <= passedIndex` 알람을 cancel하고, window `[passedIndex+1, passedIndex+windowSize]`
 * 범위에서 현재 큐에 없는 hop을 모두 채워 예약한다.
 *
 * - 호출이 순서대로(0→1→2...) 들어오면 매번 1개 새 hop이 추가된다 — 일반 case.
 * - 호출이 건너뛰며 들어와도(0→2) window가 비어 있던 슬롯까지 한 번에 채운다 — 견고성.
 * - 새 window가 route 끝을 넘으면 추가 예약 없이 cancel만 수행한다.
 *
 * PR C에서는 정의만 — 호출자(Fusion station-pass)는 PR D에서 연결.
 */
export async function advanceHopWindow(params: AdvanceHopWindowParams): Promise<void> {
  const { lock, route, destinationName, passedStationName, now, windowSize = DEFAULT_WINDOW_SIZE } =
    params;

  const allTargets = resolveAllTargets(route, destinationName);
  const passedIndex = allTargets.findIndex((t) => t.name === passedStationName);
  if (passedIndex === -1) return;

  const current = await getScheduledNotificationIds();
  const lockPrefix = `${BOARDING_LOCK_ALARM_PREFIX}${lock.trainCode}:`;

  // 이번 lock의 현재 큐를 한 번만 파싱해 cancel/existing 양쪽에 활용.
  const parsedCurrent = current
    .filter((id) => id.startsWith(lockPrefix))
    .map((id) => ({ id, parsed: parseBoardingLockAlarmIdentifier(id) }))
    .filter((x): x is { id: string; parsed: BoardingLockAlarmIdParts } => x.parsed !== null);

  const toCancel = parsedCurrent.filter((x) => x.parsed.hopIndex <= passedIndex).map((x) => x.id);
  if (toCancel.length > 0) {
    await cancelAndDismiss(toCancel);
    await removeScheduledNotificationIds(toCancel);
  }

  const existingHopIndexes = new Set(
    parsedCurrent
      .filter((x) => x.parsed.hopIndex > passedIndex)
      .map((x) => x.parsed.hopIndex),
  );

  const observedMs = now ?? lock.boardedAt;
  const scheduledIds: string[] = [];
  const windowEnd = Math.min(passedIndex + windowSize, allTargets.length - 1);
  for (let hopIndex = passedIndex + 1; hopIndex <= windowEnd; hopIndex++) {
    if (existingHopIndexes.has(hopIndex)) continue;
    const ids = await scheduleSingleHop({
      lock,
      target: allTargets[hopIndex],
      hopIndex,
      arrivalMs: arrivalMsForHop(lock, allTargets, hopIndex),
      observedMs,
    });
    scheduledIds.push(...ids);
  }
  if (scheduledIds.length > 0) {
    await addScheduledNotificationIds(scheduledIds);
  }
  logger.info(
    `advanced lock ${lock.trainCode}: cancelled ${toCancel.length}, scheduled ${scheduledIds.length}`,
  );
}
