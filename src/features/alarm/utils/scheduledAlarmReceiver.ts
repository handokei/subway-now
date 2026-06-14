import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus } from 'react-native';
import { parseScheduledAlarmIdentifier } from './alarmScheduler';
import {
  getFiredAlarms,
  setFiredAlarms,
  setLastFiredAlarmStationName,
} from './notificationState';
import { DESTINATION_KEY, ROUTE_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';
import { recordFiredAlarm } from './prescheduledMetrics';
import {
  TRIP_BOUND_ALARM_PREFIX,
  getRegisteredTripRouteSig,
  parseTripBoundAlarmIdentifier,
} from './tripBoundScheduler';
import { getTripStartedAt } from './tripStartStorage';
import { resolveAllTargets } from './stationAlarm';
import {
  parseBoardingLockAlarmIdentifier,
  routeSignature,
  getRegisteredBlRouteSig,
  BOARDING_LOCK_ALARM_PREFIX,
} from './boardingLockScheduler';
import { logSuppressedTbaRevalidation } from './alarmLog';
import type { Route } from '../../../shared/utils/stationRoute';
import type { AlarmPhaseId } from './alarmPhases';

const logger = createLogger('ScheduledAlarmReceiver');

/**
 * 현재 trip의 destinationId를 AsyncStorage에서 읽는다. firedAlarms를 destinationId로
 * 격리하기 위해(#462) 발화 reconcile 시점에 필요하다. 파싱 실패 또는 미설정이면 null.
 */
async function getCurrentDestinationId(): Promise<string | null> {
  const raw = await AsyncStorage.getItem(DESTINATION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

interface ParsedAlarmIdentifier {
  prefix: 'alarm' | 'tba' | 'bl';
  phaseId: string;
  stationName: string;
}

/**
 * `alarm:` / `tba:` / `bl:` 세 prefix 단일 진입점 (#918 A3 PR2, #1282).
 * 세 경로의 phaseId/stationName 추출 로직이 같으므로 호출자는 prefix 분기만 본다.
 */
function parseAlarmIdentifier(identifier: string): ParsedAlarmIdentifier | null {
  if (identifier.startsWith(BOARDING_LOCK_ALARM_PREFIX)) {
    const p = parseBoardingLockAlarmIdentifier(identifier);
    return p ? { prefix: 'bl', phaseId: p.phase, stationName: p.stationName } : null;
  }
  if (identifier.startsWith(TRIP_BOUND_ALARM_PREFIX)) {
    const p = parseTripBoundAlarmIdentifier(identifier);
    return p ? { prefix: 'tba', phaseId: p.phaseId, stationName: p.stationName } : null;
  }
  const p = parseScheduledAlarmIdentifier(identifier);
  return p ? { prefix: 'alarm', phaseId: p.phaseId, stationName: p.stationName } : null;
}

function safeParseRoute(raw: string | null): Route {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Route;
  } catch {
    return null;
  }
}

function parseDestinationName(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

/**
 * `tba:` 알람의 fire-time 재검증 (#918 A3 PR2, #729 흡수).
 *
 * OS가 예약된 시각에 발사한 trip-bound 알람이 *현재* 시점에도 유효한지 확인한다.
 * 세 조건 모두 충족해야 reconcile 진행:
 *   1) tripStart 존재 — trip이 종료되지 않았다.
 *   2) ROUTE_KEY/DESTINATION_KEY 기반 현재 sig가 등록 시점 sig와 동일 — 목적지/환승 변경 없음.
 *   3) 파싱된 stationName이 현재 route waypoint 시퀀스 안에 있음 — 방어 검증.
 *
 * 한 가지라도 실패하면 reason과 함께 alarmLog에 적재하고 'suppress'를 반환한다.
 * 호출자는 fired set / lastStationName 갱신을 skip해 stale 알람이 후속 상태를 오염시키지 않게 한다.
 */
async function revalidateTbaAlarm(parsed: {
  phaseId: string;
  stationName: string;
}): Promise<'pass' | 'suppress'> {
  // phaseId는 'early'/'imminent' 둘 중 하나 — alarmLog에는 그대로 통과시켜도 안전.
  const phaseId = parsed.phaseId as AlarmPhaseId;

  const tripStart = await getTripStartedAt();
  if (tripStart === null) {
    logSuppressedTbaRevalidation({
      reason: 'revalidate-no-trip',
      stationName: parsed.stationName,
      phaseId,
    });
    return 'suppress';
  }

  const [routeRaw, destRaw, registeredSig] = await Promise.all([
    AsyncStorage.getItem(ROUTE_KEY),
    AsyncStorage.getItem(DESTINATION_KEY),
    getRegisteredTripRouteSig(),
  ]);
  const route: Route = safeParseRoute(routeRaw);
  const destinationName = parseDestinationName(destRaw);
  const currentSig = routeSignature(route, destinationName);

  // registeredSig 부재 / 현재 sig 미산출 / 두 값 불일치 모두 mismatch로 묶는다.
  // (registeredSig 부재는 cancelTripBoundAlarms 직후 잔여 OS 발사 케이스.)
  if (registeredSig === null || currentSig === null || registeredSig !== currentSig) {
    logSuppressedTbaRevalidation({
      reason: 'revalidate-route-sig-mismatch',
      stationName: parsed.stationName,
      phaseId,
    });
    return 'suppress';
  }

  // 방어 검증: parsed stationName이 현재 waypoint 시퀀스에 존재해야 한다.
  // currentSig !== null이면 route, destinationName 둘 다 non-null 보장됨.
  const targets = resolveAllTargets(route as NonNullable<Route>, destinationName as string);
  if (!targets.some((t) => t.name === parsed.stationName)) {
    logSuppressedTbaRevalidation({
      reason: 'revalidate-waypoint-mismatch',
      stationName: parsed.stationName,
      phaseId,
    });
    return 'suppress';
  }

  return 'pass';
}

/**
 * `bl:` 알람의 fire-time 재검증 (#1282).
 *
 * `tba:` 채널의 revalidateTbaAlarm과 동형. `bl:` 알람이 OS에서 발사됐을 때
 * 현재 trip의 route-sig가 예약 시점 sig와 일치하는지 확인한다.
 * 일치하지 않으면 route 변경 후 남은 stale 알람이므로 suppress.
 *
 * 조건: getRegisteredBlRouteSig()가 null이거나 현재 sig와 불일치면 suppress.
 * (null은 cancelAllHopsForLock/purgeBoardingLockSchedulerQueue가 clear한 직후 OS 잔여 발사 케이스.)
 */
async function revalidateBlAlarm(parsed: {
  phaseId: string;
  stationName: string;
}): Promise<'pass' | 'suppress'> {
  const phaseId = parsed.phaseId as AlarmPhaseId;

  const [routeRaw, destRaw, registeredSig] = await Promise.all([
    AsyncStorage.getItem(ROUTE_KEY),
    AsyncStorage.getItem(DESTINATION_KEY),
    getRegisteredBlRouteSig(),
  ]);
  const route: Route = safeParseRoute(routeRaw);
  const destinationName = parseDestinationName(destRaw);
  const currentSig = routeSignature(route, destinationName);

  if (registeredSig === null || currentSig === null || registeredSig !== currentSig) {
    logSuppressedTbaRevalidation({
      reason: 'revalidate-route-sig-mismatch',
      stationName: parsed.stationName,
      phaseId,
    });
    return 'suppress';
  }

  // 방어 검증: parsed stationName이 현재 waypoint 시퀀스에 존재해야 한다.
  const targets = resolveAllTargets(route as NonNullable<Route>, destinationName as string);
  if (!targets.some((t) => t.name === parsed.stationName)) {
    logSuppressedTbaRevalidation({
      reason: 'revalidate-waypoint-mismatch',
      stationName: parsed.stationName,
      phaseId,
    });
    return 'suppress';
  }

  return 'pass';
}

/**
 * 사전 예약된 `alarm:` / `tba:` / `bl:` 알림이 OS에 의해 발사된 직후 클라이언트 상태를 갱신한다.
 * 사전 예약 알람은 클라이언트 콜백을 거치지 않으므로(`alarmScheduler.ts`), 이 함수가
 * FG/BG 양쪽 발화 모두에 대한 상태 동기화 단일 진입점이다.
 *
 * - FIRED_ALARMS_KEY에 `phaseId:stationName` 추가 → FG 복귀 시 useStationAlarm 하이드레이션이
 *   해당 phase를 이미 발화된 것으로 간주해 중복 발화를 막는다.
 * - LAST_FIRED_ALARM_STATION_NAME_KEY를 해당 역 이름으로 갱신 → BGAppRefreshTask가
 *   다음 사이클에서 Arrival API를 올바른 기준역으로 호출.
 *
 * `tba:` (#918 A3 PR2, #729 흡수): revalidateTbaAlarm이 stale/misfire를 차단한 뒤 위 동작 수행.
 * `alarm:` 경로는 BoardingLock scheduler cancel/reschedule이 SSOT이므로 별도 재검증 없이 통과.
 */
export async function reconcileScheduledAlarmDelivery(
  identifier: string,
  actualFireMs: number = Date.now(),
): Promise<void> {
  // #918 A3 measurement — `tba:` prefix 사전 예약 알람 발사 시각 ledger 기록.
  // `alarm:` prefix와 무관 — graceful no-op for non-tba identifier.
  await recordFiredAlarm({ identifier, actualFireMs });

  const parsed = parseAlarmIdentifier(identifier);
  if (!parsed) return;

  if (parsed.prefix === 'tba' && (await revalidateTbaAlarm(parsed)) === 'suppress') {
    return;
  }
  if (parsed.prefix === 'bl' && (await revalidateBlAlarm(parsed)) === 'suppress') {
    return;
  }

  const destinationId = await getCurrentDestinationId();
  // destinationId가 없으면 이미 trip이 종료/변경된 알람의 잔여 발화 — 상태 갱신 스킵.
  // setLastFiredAlarmStationName은 trip 종속성이 약하므로 유지한다(다음 사이클 기준역 갱신용).
  if (destinationId) {
    const fired = await getFiredAlarms(destinationId);
    fired.add(`${parsed.phaseId}:${parsed.stationName}`);
    await setFiredAlarms(destinationId, fired);
  }
  await setLastFiredAlarmStationName(parsed.stationName);
}

/**
 * presented tray에 남아있는 사전 예약 알람들을 일괄 reconcile한다.
 * fired set은 한 번 read해서 누적 후 한 번만 write — N번 round-trip 회피.
 */
async function drainDeliveredScheduledAlarms(): Promise<void> {
  let presented: Notifications.Notification[];
  try {
    presented = await Notifications.getPresentedNotificationsAsync();
  } catch (e) {
    logger.error('delivered 알람 조회 실패:', e);
    return;
  }

  // #918 A3 — `tba:` prefix BG-fired 알람도 ledger에 fire ts 기록. Notification.date(epoch ms)
  // 가 OS의 실제 발사 시각 — drain 시점(=FG resume)이 아닌 발사 시점을 정확히 측정.
  for (const n of presented) {
    const fireMs = typeof n.date === 'number' ? n.date : Date.now();
    await recordFiredAlarm({ identifier: n.request.identifier, actualFireMs: fireMs });
  }

  // #918 A3 PR2 — `tba:` 항목은 발사 시점 재검증을 거친다. suppress인 경우 fired set /
  // lastStationName 갱신에 포함하지 않아 stale 알람이 후속 상태(BG arrival 기준역 등)를 오염시키지
  // 않게 한다. `alarm:` 경로는 기존 BoardingLock SSOT을 신뢰해 통과.
  // #1282 — `bl:` 항목도 동일하게 route-sig 재검증을 거친다.
  const accepted: ParsedAlarmIdentifier[] = [];
  for (const n of presented) {
    const parsed = parseAlarmIdentifier(n.request.identifier);
    if (!parsed) continue;
    if (parsed.prefix === 'tba' && (await revalidateTbaAlarm(parsed)) === 'suppress') continue;
    if (parsed.prefix === 'bl' && (await revalidateBlAlarm(parsed)) === 'suppress') continue;
    accepted.push(parsed);
  }

  const destinationId = await getCurrentDestinationId();
  let lastStationName: string | null = null;
  if (destinationId) {
    const fired = await getFiredAlarms(destinationId);
    let firedChanged = false;
    for (const parsed of accepted) {
      const key = `${parsed.phaseId}:${parsed.stationName}`;
      if (!fired.has(key)) {
        fired.add(key);
        firedChanged = true;
      }
      lastStationName = parsed.stationName;
    }
    if (firedChanged) await setFiredAlarms(destinationId, fired);
  } else {
    // destinationId 미설정 — fired set 갱신은 스킵하고 lastStationName만 추출.
    for (const parsed of accepted) {
      lastStationName = parsed.stationName;
    }
  }
  if (lastStationName) await setLastFiredAlarmStationName(lastStationName);
}

export interface ScheduledAlarmListenerHandle {
  remove: () => void;
}

let registered: ScheduledAlarmListenerHandle | null = null;
let initialDrainPromise: Promise<void> | null = null;

/**
 * 마운트 시점에 시작된 첫 drain의 완료 Promise.
 * useStationAlarm 하이드레이션이 firedAlarms를 읽기 전에 이 promise를 await해서
 * cold start 직후 drain ↔ hydration race로 인한 중복 발화를 막는다.
 * 리스너가 아직 등록되지 않은 경우 즉시 resolve.
 */
export function awaitInitialScheduledAlarmDrain(): Promise<void> {
  return initialDrainPromise ?? Promise.resolve();
}

/**
 * 사전 예약 `alarm:` 알림 수신 리스너 등록. 멱등 — 중복 호출은 첫 핸들을 그대로 반환한다.
 *
 * 두 발화 경로를 모두 커버한다:
 * 1) FG 수신 — addNotificationReceivedListener가 즉시 reconcile.
 * 2) BG 발사 후 FG 복귀 — AppState 'active' 진입 시 delivered tray를 drain.
 *    (addNotificationReceivedListener는 BG 발화분을 replay하지 않음.)
 * 등록 시점에도 1회 drain해 콜드 스타트 직전에 발사된 알람을 흡수한다.
 */
export function registerScheduledAlarmListener(): ScheduledAlarmListenerHandle {
  if (registered) return registered;

  initialDrainPromise = drainDeliveredScheduledAlarms();

  const notifSub = Notifications.addNotificationReceivedListener((notification) => {
    // #918 A3 — Notification.date는 OS가 기록한 실제 발사 시각(epoch ms). Date.now() 폴백.
    void reconcileScheduledAlarmDelivery(
      notification.request.identifier,
      typeof notification.date === 'number' ? notification.date : Date.now(),
    );
  });

  const onAppStateChange = (state: AppStateStatus): void => {
    if (state === 'active') void drainDeliveredScheduledAlarms();
  };
  const appStateSub = AppState.addEventListener('change', onAppStateChange);

  registered = {
    remove: () => {
      notifSub.remove();
      appStateSub.remove();
      registered = null;
      initialDrainPromise = null;
    },
  };
  return registered;
}
