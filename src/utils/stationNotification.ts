import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { Station } from '../types/station';
import { LINE_COLORS, LINE_NAMES } from '../constants/lineColors';
import { DirectRoute, TransferRoute } from './stationRoute';
import * as LiveActivity from 'live-activity';
import { createLogger } from './logger';

const notifLogger = createLogger('Notification');
const liveActivityLogger = createLogger('LiveActivity');

const NOTIFICATION_ID = 'current-station';

// iOS Live Activity 상태 추적 (start vs update 구분)
let liveActivityStarted = false;

export function setupNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

export async function initStationNotification(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('station', {
      name: '현재 역',
      importance: Notifications.AndroidImportance.HIGH,
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
  route?: DirectRoute | TransferRoute | null,
): { title: string; body: string } {
  if (destination && route) {
    const title = `${currentStation.name} → ${destination.name}`;
    if (route.type === 'direct') {
      const body = `${LINE_NAMES[currentStation.line]} · ${route.stops}정거장 남음`;
      return { title, body };
    }
    const body = `${route.stopsToTransfer}정거장 후 ${route.transferName} 환승 · ${route.stopsFromTransfer}정거장`;
    return { title, body };
  }
  return {
    title: `${currentStation.name}역`,
    body: `${LINE_NAMES[currentStation.line]} · 약 ${distanceM}m`,
  };
}

function buildLiveActivityData(
  currentStation: Station,
  distanceM: number,
  destination?: Station | null,
  route?: DirectRoute | TransferRoute | null,
): LiveActivity.LiveActivityData {
  const base: LiveActivity.LiveActivityData = {
    stationName: currentStation.name,
    lineName: LINE_NAMES[currentStation.line],
    lineColorHex: LINE_COLORS[currentStation.line],
    distanceM,
  };

  if (destination && route) {
    base.destinationName = destination.name;
    if (route.type === 'direct') {
      base.stopsRemaining = route.stops;
    } else {
      base.stopsToTransfer = route.stopsToTransfer;
      base.transferStationName = route.transferName;
      base.stopsFromTransfer = route.stopsFromTransfer;
    }
  }

  return base;
}

export async function updateStationNotification(
  currentStation: Station,
  distanceM: number,
  destination?: Station | null,
  route?: DirectRoute | TransferRoute | null,
): Promise<void> {
  notifLogger.info('updateStation:', currentStation.name, `${distanceM}m`, destination ? `→ ${destination.name}` : '');

  if (Platform.OS === 'ios') {
    const liveActivityEnabled = LiveActivity.isLiveActivityEnabled();
    liveActivityLogger.info('isLiveActivityEnabled:', liveActivityEnabled);

    if (!liveActivityEnabled) {
      notifLogger.info('Live Activity 비활성 → 알림 fallback');
      const { title, body } = buildContent(currentStation, distanceM, destination, route);
      try {
        await Notifications.dismissNotificationAsync(NOTIFICATION_ID);
      } catch {
        // 기존 알림 없어도 무시하고 계속 진행
      }
      await Notifications.scheduleNotificationAsync({
        identifier: NOTIFICATION_ID,
        content: { title, body },
        trigger: null,
      });
      notifLogger.info('알림 예약 완료:', title, body);
      return;
    }
    const data = buildLiveActivityData(currentStation, distanceM, destination, route);
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
      const { title, body } = buildContent(currentStation, distanceM, destination, route);
      try {
        await Notifications.dismissNotificationAsync(NOTIFICATION_ID);
      } catch {
        // 기존 알림 없어도 무시하고 계속 진행
      }
      await Notifications.scheduleNotificationAsync({
        identifier: NOTIFICATION_ID,
        content: { title, body },
        trigger: null,
      });
    }
    return;
  }

  // Android: 기존 expo-notifications 유지
  const { title, body } = buildContent(currentStation, distanceM, destination, route);
  notifLogger.info('Android 알림:', title, body);
  try {
    await Notifications.dismissNotificationAsync(NOTIFICATION_ID);
  } catch {
    // 기존 알림 없어도 무시하고 계속 진행
  }
  await Notifications.scheduleNotificationAsync({
    identifier: NOTIFICATION_ID,
    content: { title, body },
    trigger: null,
  });
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
