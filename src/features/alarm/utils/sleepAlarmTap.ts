/* eslint-disable import/no-restricted-paths --
 * #3377 — useAlarmEventStore가 settings store(sleepMode)를 게이트하는 것과 같은 cross-feature orchestration.
 */
/**
 * #3377 — 취침 알람 알림 탭 → 알람 화면(SleepAlarmOverlay) 재생 + 홈 이동.
 *
 * 알림 응답 분기는 `useBoardingPromptResponder`의 단일 dispatcher(실행 중 리스너 + cold-start `getLastNotificationResponse` 회수)가
 * 이 함수를 부른다 — 리스너를 따로 등록하지 않는다. 판정: 로컬 알람(`ALARM_NOTIFICATION_ID`) 또는 원격 취침 알람(`aps.sound`, #3374).
 */
import * as Notifications from 'expo-notifications';
import type { AlarmEvent } from '../../../shared/types/alarm';
import { ALARM_OVERLAY_TAP_WINDOW_MS } from '../../../shared/constants/alarmOverlayReplay';
import { useAlarmEventStore } from '../store/useAlarmEventStore';
import { parseCompanionOverlayFields, resolveCompanionOverlayEvent } from './pendingSleepAlarmOverlay';
import { ALARM_NOTIFICATION_ID, isRemoteAlarmSoundAlert } from './stationNotification';

export function isSleepAlarmNotification(notification: Notifications.Notification): boolean {
  return notification.request.identifier === ALARM_NOTIFICATION_ID || isRemoteAlarmSoundAlert(notification);
}

/**
 * 저장 이벤트가 없을 때의 재생 원천 — 로컬 알림 `content.data`(게시 시점에 실은 재구성 정보). 30분보다 오래된 알림은 지난 트립일 수 있어 쓰지 않는다.
 * 원격 알림은 data가 없어 null(앱이 BG에서 받지 못한 경우는 재생 불가).
 */
async function eventFromNotificationData(notification: Notifications.Notification, now: number): Promise<AlarmEvent | null> {
  if (now - notification.date > ALARM_OVERLAY_TAP_WINDOW_MS) return null;
  const fields = parseCompanionOverlayFields(notification.request.content.data);
  return fields ? resolveCompanionOverlayEvent(fields) : null;
}

/** 알람 알림 기본 탭이면 30분 창으로 재생하고, 표시했으면 `navigateHome`을 부른다. 그 외 응답은 무시. */
export async function handleSleepAlarmTap(
  response: Notifications.NotificationResponse,
  navigateHome?: () => void,
): Promise<void> {
  const { actionIdentifier, notification } = response;
  if (actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER || !isSleepAlarmNotification(notification)) return;
  const now = Date.now();
  const shown = await useAlarmEventStore.getState().replayPendingAlarmOverlay({
    windowMs: ALARM_OVERLAY_TAP_WINDOW_MS,
    now,
    fallback: () => eventFromNotificationData(notification, now),
  });
  if (shown) navigateHome?.();
}
