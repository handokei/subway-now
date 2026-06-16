import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ALARM_PHASES, type AlarmPhaseId } from './alarmPhases';
import { resolveAllTargets, type AlarmEvent, type CurrentTarget } from './stationAlarm';
import { isSameStationName, type Route, getStationById } from '../../../shared/utils/stationRoute';
import { buildAlarmContent } from './stationNotification';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import {
  addScheduledNotificationIds,
  clearScheduledNotificationIds,
  getScheduledNotificationIds,
  removeScheduledNotificationIds,
} from './scheduledNotificationsStorage';
import { createLogger } from '../../../shared/utils/logger';
import { HOP_TIME_MS } from '../../../shared/constants/boardingLock';
import { shouldSuppressBySleepRule } from './shouldSuppressBySleepRule';
import { logScheduleSkipped, logSuppressedSleepFirstTransfer } from './alarmLog';
import { BOARDING_LOCK_ROUTE_SIG_KEY } from '../../../shared/constants/storageKeys';
// #1357 (S1) — preschedule 진입 시 motion gate. tripBoundScheduler와 동일 패턴.
// eslint-disable-next-line import/no-restricted-paths -- cross-feature movement gate SSOT.
import { evaluateMovement, isStaticMovementResult } from '../../nearest-station/utils/movementGate';
// eslint-disable-next-line import/no-restricted-paths -- BG motion 신호 단일 helper.
import { getCurrentMotionStationary } from '../../nearest-station/utils/motionActivity';
// #1389 — preschedule 시점 정합성 게이트. tripBoundScheduler와 공유 helper 사용.
import { evaluatePreScheduleConsistency } from './preScheduleConsistencyGate';

const logger = createLogger('BoardingLockScheduler');

export const BOARDING_LOCK_ALARM_PREFIX = 'bl:';
// alarmScheduler.ts / stationNotification.ts에도 같은 리터럴이 있다. 채널 설정을 옮길 일이
// 생기면 src/constants/로 일괄 추출 — 현재는 surgical change 원칙상 PR D 진입 전 유지.
const ALARM_CHANNEL_ID = 'station-alarm';

/**
 * imminent phase의 고정 lead time(초). 45초 전 — timeSensitive interruption으로 BG 발사 보장.
 *
 * early는 #785부터 leg별 segment 평균(legSeconds / legStops)으로 동적 산출되어 노선/시간대별
 * 실측 hop time에 정렬된다 — 별도 상수 없음. {@link computeHopTimings} 참조.
 */
const IMMINENT_LEAD_MS = 45_000;

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
 *
 * `earlyLeadMs`: 본 hop의 "1정거장 전" 시간(ms). 노선/구간별 hop time에 따라 다르며 호출자가
 * {@link computeHopTimings}로 산출해 전달한다. imminent는 {@link IMMINENT_LEAD_MS} 고정.
 */
async function scheduleSingleHop(params: {
  lock: BoardingLock;
  target: CurrentTarget;
  hopIndex: number;
  arrivalMs: number;
  earlyLeadMs: number;
  observedMs: number;
}): Promise<string[]> {
  const { lock, target, hopIndex, arrivalMs, earlyLeadMs, observedMs } = params;
  const ids: string[] = [];
  for (const phase of ALARM_PHASES) {
    const leadMs = leadMsForPhase(phase.id, earlyLeadMs);
    const fireMs = arrivalMs - leadMs;
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

interface HopTiming {
  /** 절대 도착 시각(ms epoch). lock.boardedAt + 0..=hopIndex leg seconds 누적. */
  arrivalMs: number;
  /** 이 hop의 early phase lead(ms). leg 평균 hop time = legSeconds / legStops. */
  earlyLeadMs: number;
}

/**
 * #785: 각 hop에 대해 (arrivalMs, earlyLeadMs)를 산출. route의 leg 별 실측 secondsXxx
 * 필드(=getStopSeconds 누적 결과)를 그대로 사용 — uniform 90s 대신 segment lookup 기반.
 *
 * - arrivalMs: lock.boardedAt + 0..=hopIndex leg seconds 누적
 * - earlyLeadMs: legSeconds / legStops (해당 leg의 평균 hop time). legStops=0이면
 *   {@link HOP_TIME_MS} graceful fallback — 일반적으로 nondist destination collapse 케이스.
 *
 * 본 함수는 route의 secondsXxx 캐시값에만 의존 — station 시퀀스 워킹 없음. estimator의
 * segment 누적값과 일치하는 alarm 시각을 제공한다(ADR-008 Stage 3 정렬).
 */
function computeHopTimings(
  lock: BoardingLock,
  route: NonNullable<Route>,
  allTargets: CurrentTarget[],
): HopTiming[] {
  const timings: HopTiming[] = [];
  let cumulativeMs = lock.boardedAt;
  for (let i = 0; i < allTargets.length; i++) {
    const target = allTargets[i];
    const legSeconds = legSecondsAt(route, i, target.name);
    const legMs = legSeconds * 1000;
    cumulativeMs += legMs;
    const earlyLeadMs = target.stops > 0 ? legMs / target.stops : HOP_TIME_MS;
    timings.push({ arrivalMs: cumulativeMs, earlyLeadMs });
  }
  return timings;
}

/**
 * leg 인덱스에 해당하는 route 필드에서 실측 운행 시간(초)을 꺼낸다.
 * `resolveAllTargets`의 leg 매핑과 1:1 정렬되어야 한다 — 매핑이 바뀌면 함께 갱신.
 *
 * `targetName`은 transfer 분기에서만 사용(collapsed transfer 구별). direct/multi-transfer는
 * route 필드 + hopIndex만으로 결정 — 호출자는 매번 `target.name`을 넘기지만 다른 분기에서는 ignore.
 */
function legSecondsAt(
  route: NonNullable<Route>,
  hopIndex: number,
  targetName: string,
): number {
  if (route.type === 'direct') return route.travelSeconds;
  if (route.type === 'transfer') {
    // target[0]은 항상 transferName과 같음(={transfer 또는 collapsed destination}). target[1]은 환승 후 destination.
    if (isSameStationName(route.transferName, targetName)) return route.secondsToTransfer;
    return route.secondsFromTransfer;
  }
  if (hopIndex < route.transfers.length) return route.transfers[hopIndex].secondsToTransfer;
  return route.secondsAfterLastTransfer;
}

function leadMsForPhase(phaseId: AlarmPhaseId, earlyLeadMs: number): number {
  return phaseId === 'early' ? earlyLeadMs : IMMINENT_LEAD_MS;
}

/**
 * 탑승/환승 직후 새 leg의 첫 hop이 transfer일 때 sleep ON이면 알람 skip(#632).
 * scheduleHopsForLock / advanceHopWindow가 공유하는 동일 조건 — 정책은 공통 게이트 위임.
 *
 * #750: 즉시 발사 path(FG/BG)도 동일 게이트를 사용하도록 `shouldSuppressBySleepRule`로 일원화.
 * 본 helper는 scheduler 내부 호출부 단순화용 wrapper — 차단 시 alarmLog suppression entry도 기록.
 */
function shouldSkipFirstTransferForSleep(
  isFirstNewHop: boolean,
  sleepMode: boolean,
  hop: CurrentTarget,
  lock: BoardingLock,
): boolean {
  const suppress = shouldSuppressBySleepRule({
    lock,
    event: { type: hop.alarmType, stationName: hop.name },
    sleepMode,
    isFirstHop: isFirstNewHop,
  });
  if (suppress) {
    logSuppressedSleepFirstTransfer({ source: 'bg-scheduled', stationName: hop.name });
  }
  return suppress;
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
  /**
   * 취침모드 ON 여부. true이고 batch의 첫 hop이 transfer면 그 hop의 alarm은 schedule skip.
   * [[project-alarm-sla-architecture]] "1정거장 전 + 탑승 직후 환승 알람 skip" 요구사항(#632).
   */
  sleepMode?: boolean;
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
  const { lock, route, destinationName, now, windowSize = DEFAULT_WINDOW_SIZE, sleepMode = false } =
    params;
  const observedMs = now ?? lock.boardedAt;

  // #1357 (S1) — preschedule 시점 motion gate. tripBoundScheduler와 동형.
  // 정적 상태에서 사용자가 lock 활성(boardingPrompt 응답 / 직접 탭)했을 때 즉시 사전예약 OS local
  // notification이 박혀 ETA 시각 첫 banner 발사되는 회귀를 차단. motion=stationary만 보고 결정 —
  // motion=unknown / false면 schedule 진행(false negative 회피, ADR-010 동급 원칙).
  // sleepMode 별도 게이트(shouldSkipFirstTransferForSleep)는 본 게이트 통과 후 hop 루프 안에서 적용.
  const motionStationary = getCurrentMotionStationary();
  const movement = evaluateMovement({}, undefined, undefined, motionStationary);
  if (!movement.reliable && isStaticMovementResult(movement.reason)) {
    logScheduleSkipped({
      channel: 'bl',
      reason: 'motion-stationary',
      destinationName,
    });
    logger.info(
      `scheduleHopsForLock skip reason=${movement.reason} trainCode=${lock.trainCode}`,
    );
    return [];
  }

  // #1389 — 정합성 게이트 (preschedule 시점). WiFi가 boarding 노선과 다른 station을 확증할 때
  // schedule을 거부. target은 boardingStation으로 평가 — 사용자가 거기 있는지 확인하는 의미.
  // 결과 not-allowed면 전체 schedule 거부 (개별 hop별 분리 X — 사용자 자체가 잘못된 위치).
  // helper의 fallback 정책상 WiFi 미상이면 자연 allow → graceful (지하/권한 X 등).
  // boardingStationId → Station 매핑. 매핑 실패 시 boardingStation=null → helper가 자연 allow.
  const boardingStationRecord = getStationById(lock.boardingStationId) ?? null;
  const consistencyOk = await evaluatePreScheduleConsistency({
    boardingStation: boardingStationRecord
      ? { stationName: boardingStationRecord.name, line: lock.boardingLine as string }
      : null,
    motionStationary,
    channel: 'bl',
    destinationName,
  });
  if (!consistencyOk) return [];

  const allTargets = resolveAllTargets(route, destinationName);
  const timings = computeHopTimings(lock, route, allTargets);
  const lastIdx = Math.min(windowSize, allTargets.length);

  const scheduledIds: string[] = [];
  for (let hopIndex = 0; hopIndex < lastIdx; hopIndex++) {
    if (shouldSkipFirstTransferForSleep(hopIndex === 0, sleepMode, allTargets[hopIndex], lock)) {
      // 탑승 직후 첫 hop이 환승이고 sleep ON → 사용자가 노이즈로 느낀다(#632). 둘째 hop부터 정상 예약.
      continue;
    }
    const ids = await scheduleSingleHop({
      lock,
      target: allTargets[hopIndex],
      hopIndex,
      arrivalMs: timings[hopIndex].arrivalMs,
      earlyLeadMs: timings[hopIndex].earlyLeadMs,
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
  if (toCancel.length > 0) {
    await cancelAndDismiss(toCancel);
    await removeScheduledNotificationIds(toCancel);
    logger.info(`cancelled ${toCancel.length} alarms for lock ${lock.trainCode}`);
  }
  // #1282: sig를 항상 clear — 잔여 OS 발사 분이 receiver gate를 통과하지 않도록.
  await clearRegisteredBlRouteSig();
}

/**
 * #1356 E1 / #1355 D1 — 추적 큐에서 같은 station + phase의 `bl:` 사전 예약을 cancel + 큐에서 제거.
 *
 * 두 가지 사용처:
 *   1) #1356 E1 — silent push가 motion=stationary 또는 location gate에서 suppress될 때 호출.
 *      backend는 정적 상태를 인식해 silent push를 새로 발사하지 않지만, 이미 OS queue에 들어있는
 *      같은 station의 `bl:` 사전 예약은 시간이 되면 자체적으로 발사된다 — 그 stale fire 차단.
 *   2) #1355 D1 — silent push reschedule cross-channel cancel. 반대 채널(`tba:`)의 `applyRescheduleTba`가
 *      진입 시점에 호출 — 한쪽 채널이 정정될 때 다른 채널의 stale 사전 예약이 OS 큐에 잔존해 ETA
 *      도달 시 중복 banner fire되는 회귀를 차단한다.
 *
 * 매칭 대상: `bl:*:*:*:${stationName}` (trainCode/hopIndex 무관, phase 일치). lock identity가 바뀌어도
 * 같은 station+phase 알람은 잘못된 fire이므로 정리. {@link parseBoardingLockAlarmIdentifier}로 station
 * 매칭은 `isSameStationName`을 거쳐 노선별 부제(예: '서울대입구역(관악구청)') 차이도 수용한다.
 */
export async function cancelBlByStationPhase(
  stationName: string,
  phase: AlarmPhaseId,
): Promise<void> {
  const current = await getScheduledNotificationIds();
  const toCancel = current.filter((id) => {
    const parsed = parseBoardingLockAlarmIdentifier(id);
    if (!parsed) return false;
    if (parsed.phase !== phase) return false;
    return isSameStationName(parsed.stationName, stationName);
  });
  if (toCancel.length === 0) return;
  await cancelAndDismiss(toCancel);
  await removeScheduledNotificationIds(toCancel);
  logger.info(
    `cancelled ${toCancel.length} bl alarms for station=${stationName} phase=${phase}`,
  );
}

/**
 * 큐 전체를 비운다 — SCHEDULED_NOTIFICATIONS 키 안의 `bl:` prefix 항목만.
 * 마운트 시점 위생 처리용 (예: app restart 후 stale 큐 정리). cancelAllHopsForLock과 동일하게
 * 발사된 알람은 dismiss까지 시도한다.
 */
export async function purgeBoardingLockSchedulerQueue(): Promise<void> {
  const current = await getScheduledNotificationIds();
  const ours = current.filter((id) => id.startsWith(BOARDING_LOCK_ALARM_PREFIX));
  if (ours.length > 0) {
    await cancelAndDismiss(ours);
  }
  // #773: 큐가 비어있어도 storage key는 항상 정리한다. trip release cleanup 호출자
  // (TRIP_BOUND_CLEANUPS)가 SCHEDULED_NOTIFICATIONS_KEY removal을 본 함수로 위임하므로,
  // empty case에서도 key가 존재할 수 있다(legacy 잔여 등) — 멱등 보장.
  await clearScheduledNotificationIds();
  // #1282: sig도 함께 정리 — trip 종료 후 잔여 OS 발사가 receiver gate를 통과하지 않도록.
  await clearRegisteredBlRouteSig();
}

export interface AdvanceHopWindowParams {
  lock: BoardingLock;
  route: NonNullable<Route>;
  destinationName: string;
  /**
   * 통과한 waypoint 이름.
   * 내부에서 `t.name === passedStationName` strict equality로 매칭하므로 호출자는 반드시
   * `resolveAllTargets`가 반환한 `target.name`(canonical)을 그대로 넘겨야 한다.
   * 즉, `isSameStationName`으로 currentStation을 매칭한 다음 매칭된 target의 name을 전달한다 —
   * raw `currentStationName`을 직접 전달하면 노선별 부제 등으로 silent miss(no-op)된다.
   */
  passedStationName: string;
  now?: number;
  windowSize?: number;
  /**
   * 취침모드 ON 여부. true이고 advance 직후의 첫 새 hop(=passedIndex+1)이 transfer면 그 hop은 skip.
   * 환승 직후 새 leg 시작 시점에도 같은 노이즈가 반복되지 않도록 한다(#632).
   */
  sleepMode?: boolean;
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
  const {
    lock,
    route,
    destinationName,
    passedStationName,
    now,
    windowSize = DEFAULT_WINDOW_SIZE,
    sleepMode = false,
  } = params;

  const allTargets = resolveAllTargets(route, destinationName);
  // #710: 호출자가 raw GPS station.name(노선별 부제 포함)을 전달해도 silent miss(no-op)되지
  // 않도록 정규화 비교한다. resolveAllTargets는 canonical name을 반환하므로 매칭만 안전하게
  // 흡수하면 된다 — 이후 schedule/identifier는 그대로 canonical name을 사용한다.
  const passedIndex = allTargets.findIndex((t) => isSameStationName(t.name, passedStationName));
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
  const timings = computeHopTimings(lock, route, allTargets);
  const scheduledIds: string[] = [];
  const windowEnd = Math.min(passedIndex + windowSize, allTargets.length - 1);
  for (let hopIndex = passedIndex + 1; hopIndex <= windowEnd; hopIndex++) {
    if (existingHopIndexes.has(hopIndex)) continue;
    if (
      shouldSkipFirstTransferForSleep(
        hopIndex === passedIndex + 1,
        sleepMode,
        allTargets[hopIndex],
        lock,
      )
    ) {
      // "방금 진입한 새 leg의 첫 hop"이 transfer면 skip(#632). out-of-order advance(0→2 등 GPS 점프)에서도
      // 큐 채우기 시작점이 passedIndex+1이므로 의미가 일관 — 사용자에게 가장 가까운 새 transfer만 차단한다.
      continue;
    }
    const ids = await scheduleSingleHop({
      lock,
      target: allTargets[hopIndex],
      hopIndex,
      arrivalMs: timings[hopIndex].arrivalMs,
      earlyLeadMs: timings[hopIndex].earlyLeadMs,
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

export interface RescheduleHopParams {
  lock: BoardingLock;
  route: NonNullable<Route>;
  destinationName: string;
  /** Backend가 보낸 정정 대상 hop의 stationName(`nextStation`). */
  nextStation: string;
  /** 새 도착 시각(ms epoch). 이 시점을 기준으로 phase별 leadMs를 차감해 재예약한다. */
  newArrivalMs: number;
  /** 과거 시각 가드 기준점 (ms epoch). 기본 Date.now(). */
  now?: number;
}

export interface RescheduleHopResult {
  cancelled: number;
  scheduled: number;
}

/**
 * Backend의 reschedule silent push(#698)를 받아 특정 hop의 사전 예약을 cancel + 재예약한다.
 *
 * - 매칭 대상은 `bl:${lock.trainCode}:*:*:${nextStation}` (phase 무관). nextStation 자체가
 *   현재 추적 큐에 없으면(이미 통과/미예약) 아무 일도 하지 않는다 — 정정 신호의 graceful skip.
 * - route + destinationName으로 hopIndex를 다시 매칭해 `scheduleSingleHop`에 `arrivalMs = newArrivalMs`로
 *   넘긴다 — earlyLeadMs는 leg 평균 hop time(`legSeconds/legStops`)에서 산출(기존 schedule과 동일 로직).
 * - 과거 시각으로 산출되는 phase는 scheduleSingleHop가 skip한다(`fireMs <= observedMs`).
 *
 * 단순 정정만 — windowSize 확장이나 sleep 룰은 본 함수의 책임이 아니다 (정상 schedule 흐름이 별도 처리).
 */
export async function rescheduleHopForLock(
  params: RescheduleHopParams,
): Promise<RescheduleHopResult> {
  const { lock, route, destinationName, nextStation, newArrivalMs, now } = params;
  const observedMs = now ?? Date.now();

  const current = await getScheduledNotificationIds();
  const lockPrefix = `${BOARDING_LOCK_ALARM_PREFIX}${lock.trainCode}:`;
  const matches = current
    .filter((id) => id.startsWith(lockPrefix))
    .map((id) => ({ id, parsed: parseBoardingLockAlarmIdentifier(id) }))
    .filter(
      (x): x is { id: string; parsed: BoardingLockAlarmIdParts } =>
        x.parsed !== null && isSameStationName(x.parsed.stationName, nextStation),
    );

  if (matches.length === 0) {
    logger.info(
      `reschedule no-op: no scheduled ids for trainCode=${lock.trainCode} nextStation=${nextStation}`,
    );
    return { cancelled: 0, scheduled: 0 };
  }

  const idsToCancel = matches.map((x) => x.id);
  await cancelAndDismiss(idsToCancel);
  await removeScheduledNotificationIds(idsToCancel);

  // 새 arrivalMs로 재예약. hopIndex는 cancelled identifier가 알려주지만(여러 phase가 동일),
  // earlyLeadMs는 route의 leg 정보에서 다시 산출해야 정확하다.
  const allTargets = resolveAllTargets(route, destinationName);
  const targetIndex = allTargets.findIndex((t) => isSameStationName(t.name, nextStation));
  if (targetIndex === -1) {
    // 캔슬은 했지만 route 매칭 실패 — 재예약 불가. 정정 의미상 신호 폐기. logger.info 만.
    logger.info(
      `reschedule cancel-only: nextStation=${nextStation} not found in route — skipped re-schedule`,
    );
    return { cancelled: idsToCancel.length, scheduled: 0 };
  }
  const target = allTargets[targetIndex];
  const legSeconds = legSecondsAt(route, targetIndex, target.name);
  const legMs = legSeconds * 1000;
  const earlyLeadMs = target.stops > 0 ? legMs / target.stops : HOP_TIME_MS;

  const newIds = await scheduleSingleHop({
    lock,
    target,
    hopIndex: targetIndex,
    arrivalMs: newArrivalMs,
    earlyLeadMs,
    observedMs,
  });
  if (newIds.length > 0) {
    await addScheduledNotificationIds(newIds);
  }
  logger.info(
    `reschedule done: trainCode=${lock.trainCode} nextStation=${nextStation} cancelled=${idsToCancel.length} scheduled=${newIds.length} newArrivalMs=${newArrivalMs}`,
  );
  return { cancelled: idsToCancel.length, scheduled: newIds.length };
}

/**
 * #1282 — `bl:` 알람 예약 시점의 route signature 영속화 SSOT.
 *
 * `tba:` 채널의 setRegisteredTripRouteSig(tripBoundScheduler.ts)와 동형.
 * useBoardingLockScheduler가 scheduleHopsForLock 성공 직후 write,
 * cancelAllHopsForLock / purgeBoardingLockSchedulerQueue 시 clear.
 * scheduledAlarmReceiver가 `bl:` 발사 수신 시 현재 sig와 비교해 stale 알람 억제.
 *
 * 모든 함수는 graceful — storage 실패는 측정 정확도만 영향, 본 흐름 무관.
 */
export async function setRegisteredBlRouteSig(sig: string): Promise<void> {
  try {
    await AsyncStorage.setItem(BOARDING_LOCK_ROUTE_SIG_KEY, sig);
  } catch {
    // graceful.
  }
}

export async function getRegisteredBlRouteSig(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(BOARDING_LOCK_ROUTE_SIG_KEY);
  } catch {
    return null;
  }
}

export async function clearRegisteredBlRouteSig(): Promise<void> {
  try {
    await AsyncStorage.removeItem(BOARDING_LOCK_ROUTE_SIG_KEY);
  } catch {
    // graceful.
  }
}

/**
 * #708: route + destinationName이 만드는 hop 시퀀스의 구조적 signature.
 *
 * 같은 trainCode 안에서도 환승 경로 재산정/목적지 변경/노선 갈아탐으로 waypoint가 달라지면
 * 사전 예약된 알람은 stale이 되어 잘못된 역에서 발사된다. signature가 바뀌면 호출자(scheduler
 * hook)는 cancel→reschedule을 수행해야 한다.
 *
 * waypoint(name + stops)만 직렬화 — phase lead 등 schedule 결정값은 동일 코드라 영향 없다.
 * route=null이거나 destinationName 미상이면 null (scheduler가 미준비로 다룬다).
 */
export function routeSignature(route: Route, destinationName: string | null): string | null {
  if (!route || !destinationName) return null;
  const targets = resolveAllTargets(route, destinationName);
  return targets.map((t) => `${t.name}:${t.stops}`).join('|');
}
