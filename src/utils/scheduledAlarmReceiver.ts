import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus } from 'react-native';
import { parseScheduledAlarmIdentifier } from './alarmScheduler';
import {
  getFiredAlarms,
  setFiredAlarms,
  setLastFiredAlarmStationName,
} from './notificationState';
import { DESTINATION_KEY } from '../constants/storageKeys';
import { createLogger } from './logger';

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

/**
 * 사전 예약된 `alarm:` 알림이 OS에 의해 발사된 직후 클라이언트 상태를 갱신한다.
 * 사전 예약 알람은 클라이언트 콜백을 거치지 않으므로(`alarmScheduler.ts`), 이 함수가
 * FG/BG 양쪽 발화 모두에 대한 상태 동기화 단일 진입점이다.
 *
 * - FIRED_ALARMS_KEY에 `phaseId:stationName` 추가 → FG 복귀 시 useStationAlarm 하이드레이션이
 *   해당 phase를 이미 발화된 것으로 간주해 중복 발화를 막는다.
 * - LAST_FIRED_ALARM_STATION_NAME_KEY를 해당 역 이름으로 갱신 → BGAppRefreshTask가
 *   다음 사이클에서 Arrival API를 올바른 기준역으로 호출.
 */
export async function reconcileScheduledAlarmDelivery(identifier: string): Promise<void> {
  const parsed = parseScheduledAlarmIdentifier(identifier);
  if (!parsed) return;

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

  const destinationId = await getCurrentDestinationId();
  let lastStationName: string | null = null;
  if (destinationId) {
    const fired = await getFiredAlarms(destinationId);
    let firedChanged = false;
    for (const n of presented) {
      const parsed = parseScheduledAlarmIdentifier(n.request.identifier);
      if (!parsed) continue;
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
    for (const n of presented) {
      const parsed = parseScheduledAlarmIdentifier(n.request.identifier);
      if (parsed) lastStationName = parsed.stationName;
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
    void reconcileScheduledAlarmDelivery(notification.request.identifier);
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
