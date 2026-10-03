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
 *
 * 두 경우 모두 흡수해야 fire 시각 추출 가능 (#1422):
 *  - `{ type: 'date', date: number(epoch ms) | Date }`
 *      - JS 입력 `DateTriggerInput` 형태(`{ type: SchedulableTriggerInputTypes.DATE, date }`)
 *        그대로 보존되는 환경(테스트 mock / 일부 플랫폼).
 *  - `{ type: 'timeInterval', seconds: number, repeats: boolean }`
 *      - iOS native 직렬화. `scheduleNotificationAsync({ type: DATE, date })`로 등록해도
 *        UN side에서 `UNTimeIntervalNotificationTrigger`로 변환되고, dump 시점에
 *        `EXNotificationSerializer`가 `{ type: 'timeInterval', seconds, repeats }`로
 *        직렬화한다. `seconds`는 dump 호출 시점부터의 잔여 시간 → `Date.now() + seconds*1000`.
 *
 * 다른 타입(calendar/daily/weekly 등)은 본 dump에서 fire 시각을 단정할 수 없어 null.
 */
function extractFireAtMs(
  trigger: Notifications.NotificationTrigger | null,
  nowMs: number,
): number | null {
  if (!trigger || typeof trigger !== 'object' || !('type' in trigger)) return null;
  if (trigger.type === 'date') {
    const { date } = trigger as { date?: unknown };
    if (typeof date === 'number' && Number.isFinite(date)) return date;
    if (date instanceof Date) return date.getTime();
    return null;
  }
  if (trigger.type === 'timeInterval') {
    const { seconds } = trigger as Notifications.TimeIntervalNotificationTrigger;
    if (typeof seconds === 'number' && Number.isFinite(seconds)) {
      return nowMs + seconds * 1000;
    }
    return null;
  }
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
  // timeInterval trigger의 잔여 seconds를 절대 시각으로 환산할 때 모든 entry가 같은
  // base time을 쓰도록 한 번만 캡처 — entry 간 정렬 안정성 보장.
  const nowMs = Date.now();
  const entries = requests.map<ScheduledNotificationDumpEntry>((req) => ({
    identifier: req.identifier,
    fireAtMs: extractFireAtMs(req.trigger, nowMs),
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
