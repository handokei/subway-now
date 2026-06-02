/**
 * iOS OS 큐에 사전 예약된 알림의 ground-truth dump (#756 진단 인프라).
 *
 * `useBoardingLockScheduler`가 destination 변경/trip 전환 시 `cancelAllHopsForLock`을
 * 호출하지만, AsyncStorage scheduled-ids와 실제 OS 큐가 drift되는 회귀(stale `bl:` 알람
 * 잔존) 진단용. DebugModal "큐 dump" 버튼이 본 함수를 호출해 한 줄 라인 목록을 노출한다.
 *
 * Notifications.getAllScheduledNotificationsAsync는 OS가 실제로 들고 있는 사전 예약
 * 알림을 반환 — `bl:` 와 `alarm:` (legacy) 두 prefix 모두 포함된다. parse는 호출자 책임.
 */

import * as Notifications from 'expo-notifications';

export interface ScheduledNotificationDumpEntry {
  identifier: string;
  /** OS 큐의 fire 시각 (epoch ms). 트리거 형식이 DATE가 아니면 null. */
  fireAtMs: number | null;
  /** 알림 본문 title. 없으면 빈 문자열. */
  title: string;
  /** 알림 본문 body. 없으면 빈 문자열. */
  body: string;
}

/**
 * iOS notification trigger는 union 타입이라 fire 시각 추출에 narrow가 필요하다.
 * DATE 타입은 `value: number(epoch ms)` 또는 `value: Date`로 보고된다 — 둘 다 흡수.
 * 다른 타입(time-interval/calendar 등)은 본 dump에서 fire 시각을 알 수 없어 null.
 */
function extractFireAtMs(trigger: Notifications.NotificationTrigger | null): number | null {
  if (!trigger || typeof trigger !== 'object') return null;
  if (!('type' in trigger) || trigger.type !== 'date') return null;
  const value = (trigger as { value?: unknown }).value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  return null;
}

/**
 * 현재 OS 큐의 모든 사전 예약 알림을 dump.
 * fire 시각 오름차순 정렬 — 가까운 미래 발사 알림부터 보이도록.
 * OS 호출 실패 시 빈 배열 반환(graceful) — DebugModal이 에러로 죽지 않도록.
 */
export async function dumpScheduledNotifications(): Promise<ScheduledNotificationDumpEntry[]> {
  let requests: Notifications.NotificationRequest[];
  try {
    requests = await Notifications.getAllScheduledNotificationsAsync();
  } catch {
    return [];
  }
  const entries = requests.map<ScheduledNotificationDumpEntry>((req) => ({
    identifier: req.identifier,
    fireAtMs: extractFireAtMs(req.trigger),
    title: req.content.title ?? '',
    body: req.content.body ?? '',
  }));
  // null fireAtMs는 정렬 끝으로 — 진단 시 "fire 시각 모르는 알림"이 일반 알림과 섞이지 않게.
  entries.sort((a, b) => {
    if (a.fireAtMs == null && b.fireAtMs == null) return 0;
    if (a.fireAtMs == null) return 1;
    if (b.fireAtMs == null) return -1;
    return a.fireAtMs - b.fireAtMs;
  });
  return entries;
}

/**
 * dump 1건을 한 줄 문자열로 — DebugModal UI 및 Share dump 텍스트가 공유한다.
 * 형식: `HH:mm:ss | <identifier> | <title>` (body는 본문이 길어 dump 라인에선 생략 가능).
 * fireAtMs=null이면 `--:--:--` 로 표시 — 호출자가 fire 시각 부재 신호를 즉시 인지하도록.
 */
export function formatScheduledNotificationLine(entry: ScheduledNotificationDumpEntry): string {
  const time =
    entry.fireAtMs == null
      ? '--:--:--'
      : new Date(entry.fireAtMs).toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
  return `${time} | ${entry.identifier} | ${entry.title}`;
}
