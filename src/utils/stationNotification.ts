import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { Station } from '../types/station';
import { LINE_COLORS, LINE_NAMES } from '../constants/lineColors';
import { DirectRoute, TransferRoute, MultiTransferRoute } from './stationRoute';
import * as LiveActivity from 'live-activity';
import { createLogger } from './logger';

const notifLogger = createLogger('Notification');
const liveActivityLogger = createLogger('LiveActivity');

const NOTIFICATION_ID = 'current-station';
const ALARM_NOTIFICATION_ID = 'station-alarm';
const ALARM_CHANNEL_ID = 'station-alarm';

// iOS Live Activity 상태 추적 (start vs update 구분)
let liveActivityStarted = false;

async function scheduleNotification(
  id: string,
  content: { title: string; body: string; sound?: boolean; channelId?: string },
): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(id);
  } catch {
    // 기존 알림 없어도 무시
  }
  await Notifications.scheduleNotificationAsync({
    identifier: id,
    content,
    trigger: null,
  });
}

export function setupNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const isAlarm = notification.request.identifier === ALARM_NOTIFICATION_ID;
      return {
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: isAlarm,
        shouldSetBadge: false,
      };
    },
  });
}

export async function initStationNotification(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('station', {
      name: '현재 역',
      importance: Notifications.AndroidImportance.HIGH,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    await Notifications.setNotificationChannelAsync(ALARM_CHANNEL_ID, {
      name: '하차/환승 알림',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
  const { status } = await Notifications.requestPermissionsAsync();
  notifLogger.info('권한 상태:', status);
}

function buildContent(
  currentStation: Station,
  distanceM: number,
  destination?: Station | null,
  route?: DirectRoute | TransferRoute | MultiTransferRoute | null,
  etaMinutes?: number | null,
  isMock?: boolean,
): { title: string; body: string } {
  const etaSuffix = etaMinutes != null ? ` · 약 ${etaMinutes}분${isMock ? ' (예상)' : ''}` : '';

  // destination layer: 목적지 있으면 title에 반영
  const title = destination
    ? `${currentStation.name} → ${destination.name}`
    : `${currentStation.name}역`;

  // route layer: 경로 정보가 있으면 body에 반영
  if (destination && route) {
    if (route.type === 'direct') {
      return { title, body: `${LINE_NAMES[currentStation.line]} · ${route.stops}정거장 남음${etaSuffix}` };
    }
    if (route.type === 'transfer') {
      return { title, body: `${route.stopsToTransfer}역 후 ${route.transferName} 환승${etaSuffix}` };
    }
    const [t1] = route.transfers;
    return { title, body: `${t1.stopsToTransfer}역 후 ${t1.transferName} 환승${etaSuffix}` };
  }

  // base: 경로 없이 목적지만 있거나 목적지도 없는 경우
  return { title, body: `${LINE_NAMES[currentStation.line]} · 약 ${distanceM}m${etaSuffix}` };
}

function buildLiveActivityData(
  currentStation: Station,
  distanceM: number,
  destination?: Station | null,
  route?: DirectRoute | TransferRoute | MultiTransferRoute | null,
  etaMinutes?: number | null,
  isMock?: boolean,
): LiveActivity.LiveActivityData {
  // station layer: 항상 포함
  const data: LiveActivity.LiveActivityData = {
    stationName: currentStation.name,
    lineName: LINE_NAMES[currentStation.line],
    lineColorHex: LINE_COLORS[currentStation.line],
    distanceM,
  };

  // destination layer: 목적지 있으면 독립적으로 포함
  if (destination) {
    data.destinationName = destination.name;
  }

  // route layer: 경로 정보가 있을 때만
  if (destination && route) {
    if (route.type === 'direct') {
      data.stopsRemaining = route.stops;
    } else if (route.type === 'transfer') {
      data.stopsToTransfer = route.stopsToTransfer;
      data.transferStationName = route.transferName;
      data.stopsFromTransfer = route.stopsFromTransfer;
    } else {
      data.stopsToTransfer = route.transfers[0].stopsToTransfer;
      data.transferStationName = route.transfers[0].transferName;
      data.stopsToSecondTransfer = route.transfers[1].stopsToTransfer;
      data.secondTransferStationName = route.transfers[1].transferName;
      data.stopsAfterLastTransfer = route.stopsAfterLastTransfer;
    }
  }

  // eta layer: ETA가 있을 때만
  if (etaMinutes != null) {
    data.etaMinutes = etaMinutes;
  }
  if (isMock) {
    data.isMock = true;
  }

  return data;
}

export async function updateStationNotification(
  currentStation: Station,
  distanceM: number,
  destination?: Station | null,
  route?: DirectRoute | TransferRoute | MultiTransferRoute | null,
  etaMinutes?: number | null,
  isMock?: boolean,
): Promise<void> {
  notifLogger.info('updateStation:', currentStation.name, `${distanceM}m`, destination ? `→ ${destination.name}` : '');

  if (Platform.OS === 'ios') {
    const liveActivityEnabled = LiveActivity.isLiveActivityEnabled();
    liveActivityLogger.info('isLiveActivityEnabled:', liveActivityEnabled);

    if (!liveActivityEnabled) {
      notifLogger.info('Live Activity 비활성 → 알림 fallback');
      const { title, body } = buildContent(currentStation, distanceM, destination, route, etaMinutes, isMock);
      await scheduleNotification(NOTIFICATION_ID, { title, body });
      notifLogger.info('알림 예약 완료:', title, body);
      return;
    }
    const data = buildLiveActivityData(currentStation, distanceM, destination, route, etaMinutes, isMock);
    try {
      if (!liveActivityStarted) {
        liveActivityLogger.info('시작 요청');
        await LiveActivity.startLiveActivity(data);
        liveActivityStarted = true;
        liveActivityLogger.info('시작 성공');
      } else {
        liveActivityLogger.info('업데이트 요청');
        await LiveActivity.updateLiveActivity(data);
        liveActivityLogger.info('업데이트 성공');
      }
    } catch (e) {
      liveActivityLogger.error('시작/업데이트 실패:', e);
      liveActivityStarted = false;
      notifLogger.info('Live Activity 실패 → 알림 fallback');
      const { title, body } = buildContent(currentStation, distanceM, destination, route, etaMinutes, isMock);
      await scheduleNotification(NOTIFICATION_ID, { title, body });
    }
    return;
  }

  // Android: 기존 expo-notifications 유지
  const { title, body } = buildContent(currentStation, distanceM, destination, route, etaMinutes, isMock);
  notifLogger.info('Android 알림:', title, body);
  await scheduleNotification(NOTIFICATION_ID, { title, body });
  notifLogger.info('알림 예약 완료');
}

export async function clearStationNotification(): Promise<void> {
  if (Platform.OS === 'ios') {
    if (!LiveActivity.isLiveActivityEnabled()) {
      notifLogger.info('알림 해제 (Live Activity 비활성)');
      await Notifications.dismissNotificationAsync(NOTIFICATION_ID);
      return;
    }
    try {
      liveActivityLogger.info('종료 요청');
      await LiveActivity.endLiveActivity();
      liveActivityLogger.info('종료 성공');
    } catch (e) {
      liveActivityLogger.error('종료 실패:', e);
    }
    liveActivityStarted = false;
    return;
  }
  notifLogger.info('Android 알림 해제');
  await Notifications.dismissNotificationAsync(NOTIFICATION_ID);
}

export async function sendAlarmNotification(
  type: 'destination' | 'transfer',
  stationName: string,
): Promise<void> {
  const isTransfer = type === 'transfer';
  const title = isTransfer ? '환승 알림' : '하차 알림';
  const body = isTransfer
    ? `다음 역 ${stationName}에서 환승하세요!`
    : `다음 역 ${stationName}에서 내리세요!`;

  await scheduleNotification(ALARM_NOTIFICATION_ID, {
    title,
    body,
    sound: true,
    ...(Platform.OS === 'android' && { channelId: ALARM_CHANNEL_ID }),
  });
  notifLogger.info('알람 알림:', title, body);
}

export async function clearAlarmNotification(): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(ALARM_NOTIFICATION_ID);
  } catch { /* 무시 */ }
}
