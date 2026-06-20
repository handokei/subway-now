/**
 * #1575 (T12, ADR-017) — NotificationRouter delivery log (ring buffer 200건).
 *
 * router.deliver()가 모든 결과를 push. DebugModal "Notification Delivery" 섹션이 read해
 * surface별 카운터 + suppress 사유 분포 표시.
 *
 * 본 모듈은 메모리 + AsyncStorage mirror 형태. push는 sync update + fire-and-forget persist.
 * read는 sync (메모리). 앱 재시작 시 hydrate (best effort).
 *
 * 200건 cap + FIFO eviction. trip 1회 평균 alarm 10건 + suppress 20건 가정 시 약 6~7 trip 보존.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { NOTIFICATION_DELIVERY_LOG_KEY } from '../../../shared/constants/storageKeys';
import type {
  DeliveryReason,
  NotificationSource,
  NotificationSurface,
} from '../ports/NotificationRouter';

export const NOTIFICATION_DELIVERY_LOG_CAP = 200;

export interface NotificationDeliveryEntry {
  alarmId: string;
  eventKey: string;
  surface: NotificationSurface;
  source: NotificationSource;
  /** 'delivered': router가 surface로 전달 / 'suppressed': gate에서 차단. */
  result: 'delivered' | 'suppressed';
  reason?: DeliveryReason;
  at: number;
}

let buffer: NotificationDeliveryEntry[] = [];
let hydrated = false;

/**
 * append entry to ring buffer. cap 초과 시 oldest eviction.
 *
 * AsyncStorage persist는 fire-and-forget — write 실패해도 메모리 buffer에는 남는다.
 * DebugModal은 메모리를 우선 읽으므로 persist 실패해도 운영 진단 영향 없음.
 */
export function appendDeliveryEntry(entry: NotificationDeliveryEntry): void {
  buffer.push(entry);
  if (buffer.length > NOTIFICATION_DELIVERY_LOG_CAP) {
    buffer = buffer.slice(buffer.length - NOTIFICATION_DELIVERY_LOG_CAP);
  }
  void persist();
}

export function getDeliveryEntries(): readonly NotificationDeliveryEntry[] {
  return buffer;
}

/**
 * 메모리 + AsyncStorage 모두 클리어. trip-bound cleanup에서 호출.
 */
export async function clearDeliveryLog(): Promise<void> {
  buffer = [];
  try {
    await AsyncStorage.removeItem(NOTIFICATION_DELIVERY_LOG_KEY);
  } catch {
    // graceful — 메모리 클리어가 우선. 다음 push가 persist를 다시 시도.
  }
}

/**
 * 앱 시작 시 1회 호출. AsyncStorage에 영속화된 직전 세션 log를 메모리로 복구.
 *
 * 두 번 이상 호출되면 두 번째 호출은 skip — 메모리 buffer가 이미 활성이라 덮어쓰면 안 됨.
 * useStateRehydration 또는 진단 모듈에서 한 번 await하는 entry point 패턴.
 */
export async function hydrateDeliveryLog(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(NOTIFICATION_DELIVERY_LOG_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    const valid = parsed.filter(isValidEntry);
    buffer =
      valid.length > NOTIFICATION_DELIVERY_LOG_CAP
        ? valid.slice(valid.length - NOTIFICATION_DELIVERY_LOG_CAP)
        : valid;
  } catch {
    // graceful — corrupt/parse 실패는 빈 buffer로 시작.
  }
}

function isValidEntry(v: unknown): v is NotificationDeliveryEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<NotificationDeliveryEntry>;
  return (
    typeof e.alarmId === 'string' &&
    typeof e.eventKey === 'string' &&
    typeof e.surface === 'string' &&
    typeof e.source === 'string' &&
    (e.result === 'delivered' || e.result === 'suppressed') &&
    typeof e.at === 'number'
  );
}

async function persist(): Promise<void> {
  try {
    await AsyncStorage.setItem(
      NOTIFICATION_DELIVERY_LOG_KEY,
      JSON.stringify(buffer),
    );
  } catch {
    // graceful — 메모리 buffer는 다음 push에서 다시 persist 시도.
  }
}

/** 테스트 전용 — 메모리 + hydration 플래그 reset. production caller 없음. */
export function __resetDeliveryLogForTest(): void {
  buffer = [];
  hydrated = false;
}
