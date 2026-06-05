import * as Notifications from 'expo-notifications';
import { stopVibration } from './alarmSound';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('AlarmKill');

/**
 * #623 / #633 — 모든 알람 채널 즉시 차단.
 *
 *  1) 진동 중단 (Vibration.cancel)
 *  2) 발사된 알림 전체 dismiss
 *  3) 예약된 알림 전체 cancel
 *
 * 호출은 fire-and-forget; 각 단계 실패는 로그만 남기고 다음 단계 진행한다 —
 * 한 채널이 죽어도 나머지가 정리되도록.
 *
 * AlarmOverlay dismiss(#633)에서 사용 — 사용자가 알람 닫기 누르면 모든 채널 100% 종료.
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
