import AsyncStorage from '@react-native-async-storage/async-storage';
import { SCHEDULED_NOTIFICATIONS_KEY } from '../shared/constants/storageKeys';
import { createLogger } from './logger';

const logger = createLogger('ScheduledNotificationsStorage');

/**
 * boardingLockScheduler가 OS에 예약한 notification identifier를 추적한다 (#584 PR C).
 *
 * Lock 단위 cancel을 위해 prefix 매칭 대신 명시적 목록을 둔다 — Notifications.getAll*은
 * 비싸고, 다른 모듈이 같은 prefix로 예약하지 않는다는 가정에 의존하지 않아도 된다.
 *
 * 파싱 실패한 레거시 값은 빈 목록으로 처리한다. 잘못된 상태로 cancel/dedup이 오염되는 것을
 * 차단한다. I/O 실패는 warn만 — 다음 호출에서 자연 복구.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export async function getScheduledNotificationIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(SCHEDULED_NOTIFICATIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isStringArray(parsed)) {
      logger.error(`${SCHEDULED_NOTIFICATIONS_KEY} 형식 손상 — 무시`);
      return [];
    }
    return parsed;
  } catch (e) {
    logger.warn(`${SCHEDULED_NOTIFICATIONS_KEY} 읽기 실패:`, e);
    return [];
  }
}

async function writeIds(ids: string[]): Promise<void> {
  try {
    if (ids.length === 0) {
      await AsyncStorage.removeItem(SCHEDULED_NOTIFICATIONS_KEY);
      return;
    }
    await AsyncStorage.setItem(SCHEDULED_NOTIFICATIONS_KEY, JSON.stringify(ids));
  } catch (e) {
    logger.warn(`${SCHEDULED_NOTIFICATIONS_KEY} 저장 실패:`, e);
  }
}

export async function addScheduledNotificationIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const current = await getScheduledNotificationIds();
  const merged = Array.from(new Set([...current, ...ids]));
  await writeIds(merged);
}

export async function removeScheduledNotificationIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const current = await getScheduledNotificationIds();
  const remove = new Set(ids);
  const next = current.filter((id) => !remove.has(id));
  if (next.length === current.length) return;
  await writeIds(next);
}

export async function clearScheduledNotificationIds(): Promise<void> {
  await writeIds([]);
}
