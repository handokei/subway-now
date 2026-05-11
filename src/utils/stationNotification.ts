import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import i18next from 'i18next';
import { Station } from '../types/station';
import { LINE_COLORS, LINE_NAMES } from '../constants/lineColors';
import { DirectRoute, TransferRoute, MultiTransferRoute } from './stationRoute';
import type { AlarmEvent } from './stationAlarm';
import * as LiveActivity from 'live-activity';
import { vibrateAlarm, stopVibration } from './alarmSound';
import { createLogger } from './logger';

const notifLogger = createLogger('Notification');
const liveActivityLogger = createLogger('LiveActivity');

export const NOTIFICATION_ID = 'current-station';
export const ALARM_NOTIFICATION_ID = 'station-alarm';
const ALARM_CHANNEL_ID = 'station-alarm';
const ALARM_SILENT_CHANNEL_ID = 'station-alarm-silent';
export const STATION_PASSED_NOTIFICATION_ID = 'station-passed';
const STATION_PASSED_CHANNEL_ID = 'station-passed';


async function scheduleNotification(
  id: string,
  content: { title: string; body: string; sound?: boolean | string; channelId?: string; interruptionLevel?: 'timeSensitive' | 'critical'; priority?: Notifications.AndroidNotificationPriority },
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
      const hasSound = notification.request.content.sound != null;
      return {
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: isAlarm && hasSound,
        shouldSetBadge: false,
      };
    },
  });
}

export async function initStationNotification(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('station', {
      name: i18next.t('notifications.channelStation'),
      importance: Notifications.AndroidImportance.HIGH,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    await Notifications.deleteNotificationChannelAsync(ALARM_CHANNEL_ID).catch(() => {});
    await Notifications.setNotificationChannelAsync(ALARM_CHANNEL_ID, {
      name: i18next.t('notifications.channelTransferAlarm'),
      importance: Notifications.AndroidImportance.MAX,
      sound: 'alarm.wav',
      enableVibrate: true,
      vibrationPattern: [0, 1000, 500, 1000],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
    });
    await Notifications.deleteNotificationChannelAsync(ALARM_SILENT_CHANNEL_ID).catch(() => {});
    await Notifications.setNotificationChannelAsync(ALARM_SILENT_CHANNEL_ID, {
      name: i18next.t('notifications.channelTransferAlarmSilent'),
      importance: Notifications.AndroidImportance.MAX,
      sound: null,
      enableVibrate: true,
      vibrationPattern: [0, 1000, 500, 1000],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
    });
    await Notifications.setNotificationChannelAsync(STATION_PASSED_CHANNEL_ID, {
      name: i18next.t('notifications.channelStationPass'),
      importance: Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
  const { status } = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowSound: true,
      allowCriticalAlerts: true,
    },
  });
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
  alarmEvent?: AlarmEvent | null,
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
      const [first, second] = route.transfers;
      data.stopsToTransfer = first.stopsToTransfer;
      data.transferStationName = first.transferName;
      data.stopsToSecondTransfer = second.stopsToTransfer;
      data.secondTransferStationName = second.transferName;
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

  // alarm layer: 알람 이벤트가 있을 때만
  if (alarmEvent) {
    data.alarmType = alarmEvent.type;
    data.alarmStationName = alarmEvent.stationName;
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
  alarmEvent?: AlarmEvent | null,
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
    const data = buildLiveActivityData(currentStation, distanceM, destination, route, etaMinutes, isMock, alarmEvent);
    try {
      liveActivityLogger.info('업데이트 요청');
      await LiveActivity.updateLiveActivity(data);
      liveActivityLogger.info('업데이트 성공');
    } catch (e) {
      liveActivityLogger.error('업데이트 실패:', e);
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

async function dismissStationPassedNotification(): Promise<void> {
  await Notifications.dismissNotificationAsync(STATION_PASSED_NOTIFICATION_ID).catch(() => {});
}

export async function clearStationNotification(): Promise<void> {
  if (Platform.OS === 'ios') {
    if (!LiveActivity.isLiveActivityEnabled()) {
      notifLogger.info('알림 해제 (Live Activity 비활성)');
      await Notifications.dismissNotificationAsync(NOTIFICATION_ID);
      await dismissStationPassedNotification();
      return;
    }
    try {
      liveActivityLogger.info('종료 요청');
      await LiveActivity.endLiveActivity();
      liveActivityLogger.info('종료 성공');
    } catch (e) {
      liveActivityLogger.error('종료 실패:', e);
    }
    await dismissStationPassedNotification();
    return;
  }
  notifLogger.info('Android 알림 해제');
  await Notifications.dismissNotificationAsync(NOTIFICATION_ID);
  await dismissStationPassedNotification();
}

export async function sendStationPassedNotification(
  stationName: string,
  destinationName: string,
  stopsRemaining: number | null,
): Promise<void> {
  const body = stopsRemaining != null
    ? `${destinationName}까지 ${stopsRemaining}정거장 남음`
    : `현재 ${stationName}역`;

  await scheduleNotification(STATION_PASSED_NOTIFICATION_ID, {
    title: `${stationName}역 통과`,
    body,
    ...(Platform.OS === 'android' && {
      channelId: STATION_PASSED_CHANNEL_ID,
      priority: Notifications.AndroidNotificationPriority.DEFAULT,
    }),
  });
  notifLogger.info('역 통과 알림:', stationName, body);
}

import type { AlarmPhaseId } from './alarmPhases';

// 본문(body)의 동적 보간 부분은 Phase 3(#205+)에서 i18n 처리 예정
const ALARM_MESSAGE_BUILDERS: Record<AlarmPhaseId, (stationName: string, isTransfer: boolean) => { title: string; body: string }> = {
  early: (stationName, isTransfer) => ({
    title: i18next.t(isTransfer ? 'notifications.transferEarlyTitle' : 'notifications.arrivalEarlyTitle'),
    body: isTransfer
      ? `다음 역 ${stationName}에서 환승하세요!`
      : `다음 역 ${stationName}에서 내리세요!`,
  }),
  imminent: (stationName, isTransfer) => ({
    title: i18next.t(isTransfer ? 'notifications.transferImminentTitle' : 'notifications.arrivalImminentTitle'),
    body: isTransfer
      ? `곧 ${stationName}에 도착합니다. 환승 준비하세요!`
      : `곧 ${stationName}에 도착합니다. 하차 준비하세요!`,
  }),
};

function buildAlarmContent(event: AlarmEvent): { title: string; body: string } {
  return ALARM_MESSAGE_BUILDERS[event.phaseId](event.stationName, event.type === 'transfer');
}

export async function sendAlarmNotification(
  event: AlarmEvent,
  sleepMode: boolean = false,
  allowSpeaker: boolean = true,
): Promise<void> {
  const { title, body } = buildAlarmContent(event);

  await scheduleNotification(ALARM_NOTIFICATION_ID, {
    title,
    body,
    sound: allowSpeaker ? 'alarm.wav' : false,
    ...(Platform.OS === 'android' && {
      channelId: allowSpeaker ? ALARM_CHANNEL_ID : ALARM_SILENT_CHANNEL_ID,
      priority: Notifications.AndroidNotificationPriority.MAX,
    }),
    // NOTE: critical Entitlement 승인 후 'critical'로 변경 → Sleep Focus 완전 관통
    ...(Platform.OS === 'ios' && { interruptionLevel: 'timeSensitive' as const }),
  });
  vibrateAlarm(sleepMode);
  notifLogger.info('알람 알림:', title, body);
}

export async function clearAlarmNotification(): Promise<void> {
  stopVibration();
  try {
    await Notifications.dismissNotificationAsync(ALARM_NOTIFICATION_ID);
  } catch { /* 무시 */ }
}
