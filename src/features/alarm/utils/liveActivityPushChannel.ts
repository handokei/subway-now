/**
 * Live Activity push channel (#586 B).
 *
 * native가 발급한 push token을 backend에 등록/해제하는 얇은 wrapper.
 * - `startLiveActivityWithRegistration`: Activity 시작 + 1회성 token 구독 → backend POST
 * - `endLiveActivityWithDeregister`: Activity 종료 + backend DELETE
 *
 * 정책
 * - token emit이 비동기다. 5초 timeout 안에 안 오면 subscription 정리 후 silent skip.
 *   (LA 자체는 정상 동작한다 — backend가 못 push할 뿐.)
 * - 네트워크 실패는 silent log. 재시도하지 않는다 (다음 update 사이클이 자동 보정).
 */

import {
  addPushTokenListener,
  endLiveActivity,
  startLiveActivity,
  type LiveActivityData,
  type PushTokenEvent,
} from '../../../../modules/live-activity';
import {
  clearLiveActivityToken,
  registerLiveActivityToken,
} from '../api/alarmBackend';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('liveActivityPushChannel');

/** token이 안 오면 subscription을 정리할 안전 timeout. */
const PUSH_TOKEN_TIMEOUT_MS = 5000;

/**
 * Activity 시작과 동시에 token emit을 1회 기다려 backend에 register.
 * Activity 시작 자체가 실패하면 throw — 호출 측의 기존 fallback(예: 일반 알림) 흐름을 유지.
 */
export async function startLiveActivityWithRegistration(
  tripToken: string,
  data: LiveActivityData,
): Promise<void> {
  let subscription!: { remove: () => void };
  let timer!: ReturnType<typeof setTimeout>;
  const cleanup = (): void => {
    subscription.remove();
    clearTimeout(timer);
  };
  subscription = addPushTokenListener((event: PushTokenEvent) => {
    cleanup();
    void registerLiveActivityToken(tripToken, event.token).catch((e) => {
      log.warn('LA register threw', e);
    });
  });
  timer = setTimeout(() => {
    cleanup();
    log.info('push token timeout — backend register skipped');
  }, PUSH_TOKEN_TIMEOUT_MS);

  try {
    await startLiveActivity(data);
  } catch (e) {
    // start가 실패하면 token은 발급될 일이 없다 — 정리 후 re-throw.
    cleanup();
    throw e;
  }
}

/**
 * Activity 종료 + backend deregister.
 * 종료 자체가 실패해도 backend deregister는 시도 — 양쪽 상태를 가능한 한 동기화.
 */
export async function endLiveActivityWithDeregister(
  tripToken: string,
): Promise<void> {
  try {
    await endLiveActivity();
  } finally {
    await clearLiveActivityToken(tripToken).catch((e) => {
      log.warn('LA deregister threw', e);
    });
  }
}
