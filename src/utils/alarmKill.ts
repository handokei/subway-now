import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { stopVibration } from './alarmSound';
import { createLogger } from './logger';
import { ALARMS_KILLED_KEY } from '../constants/storageKeys';

const logger = createLogger('AlarmKill');

/**
 * 모든 알람 fire/schedule 경로가 진입 직전에 호출하는 가드.
 * true면 호출자는 즉시 return — 알림/예약/진동 모두 발생 안 함.
 *
 * #623 review P0-2: AsyncStorage 직접 read.
 *  - BG silent push handler는 별도 JS context라 Zustand in-memory store가 hydration 안 됨.
 *  - 사용자 "100% 차단" 약속을 BG에서도 지키려면 영속 저장소를 SSOT로.
 *  - 실패 시 false fallback — kill switch off 측 안전(잘못 차단보다 일관성 우선).
 */
export async function isAlarmsKilled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(ALARMS_KILLED_KEY);
    return raw != null && JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

/**
 * #623 — 모든 알람 채널 즉시 차단.
 *
 *  1) 진동 중단 (Vibration.cancel)
 *  2) 발사된 알림 전체 dismiss
 *  3) 예약된 알림 전체 cancel
 *
 * 호출은 fire-and-forget; 각 단계 실패는 로그만 남기고 다음 단계 진행한다 —
 * 한 채널이 죽어도 나머지가 정리되도록.
 */
export async function killAllAlarms(): Promise<void> {
  try {
    stopVibration();
  } catch (e) {
    logger.warn('stopVibration 실패:', e);
  }
  try {
    await Notifications.dismissAllNotificationsAsync();
  } catch (e) {
    logger.warn('dismissAllNotificationsAsync 실패:', e);
  }
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch (e) {
    logger.warn('cancelAllScheduledNotificationsAsync 실패:', e);
  }
}
