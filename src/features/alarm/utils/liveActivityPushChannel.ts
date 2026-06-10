/**
 * Live Activity push channel (#586 B, #1044).
 *
 * native가 발급한 push token을 backend에 등록/해제하는 얇은 wrapper.
 * - `startLiveActivityWithRegistration`: Activity 시작 + token 구독 → backend POST
 * - `endLiveActivityWithDeregister`: Activity 종료 + backend DELETE + subscription teardown
 *
 * 정책
 * - native는 `Activity.pushTokenUpdates` 시퀀스로 LA 세션 동안 여러 번 token을
 *   emit할 수 있다 (APNs rotation 등). 따라서 subscription은 세션 동안 살려두고
 *   매 emit마다 backend에 재등록한다 (#1044).
 * - 동일 token 재emit은 dedup → 불필요한 POST 차단.
 * - 첫 token이 5초 안에 안 오면 로그만 남기고 subscription은 그대로 둔다 — 늦게라도
 *   token이 오면 backend에 반영해야 한다.
 * - 네트워크 실패는 silent log. 재시도는 다음 token emit / 다음 LA 사이클에 의존.
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

/** 첫 token이 안 올 때 로그만 남기는 안전 timeout. subscription은 끊지 않는다. */
const PUSH_TOKEN_FIRST_EMIT_TIMEOUT_MS = 5000;

/** 현재 LA 세션의 teardown 함수. 단일 LA만 동시 운영한다는 전제. */
let activeTeardown: (() => void) | null = null;

/**
 * Activity 시작과 동시에 token 구독을 LA 세션 동안 유지.
 * 매 token emit마다 backend register. 동일 token은 dedup.
 * Activity 시작 자체가 실패하면 throw — 호출 측의 기존 fallback(예: 일반 알림) 흐름을 유지.
 */
export async function startLiveActivityWithRegistration(
  tripToken: string,
  data: LiveActivityData,
): Promise<void> {
  // 이전 세션이 살아 있으면 정리 — LA는 동시에 하나만.
  if (activeTeardown) {
    activeTeardown();
    activeTeardown = null;
  }

  let lastToken: string | null = null;
  let firstEmitTimer: ReturnType<typeof setTimeout> | null = null;

  const subscription = addPushTokenListener((event: PushTokenEvent) => {
    if (firstEmitTimer) {
      clearTimeout(firstEmitTimer);
      firstEmitTimer = null;
    }
    if (event.token === lastToken) {
      // 같은 token 재emit — backend 상태 그대로 유지.
      return;
    }
    lastToken = event.token;
    void registerLiveActivityToken(tripToken, event.token).catch((e) => {
      log.warn('LA register threw', e);
    });
  });

  firstEmitTimer = setTimeout(() => {
    // emit이 들어오면 위에서 firstEmitTimer를 clear하므로 이 콜백은 항상 lastToken === null.
    firstEmitTimer = null;
    log.info('push token first-emit timeout — subscription kept');
  }, PUSH_TOKEN_FIRST_EMIT_TIMEOUT_MS);

  const teardown = (): void => {
    subscription.remove();
    if (firstEmitTimer) {
      clearTimeout(firstEmitTimer);
      firstEmitTimer = null;
    }
  };
  activeTeardown = teardown;

  try {
    await startLiveActivity(data);
  } catch (e) {
    // start가 실패하면 token은 발급될 일이 없다 — 정리 후 re-throw.
    // 다른 호출이 await 사이에 activeTeardown을 교체했을 수 있으므로 우리 teardown만 정리한다.
    teardown();
    if (activeTeardown === teardown) {
      activeTeardown = null;
    }
    throw e;
  }
}

/**
 * Activity 종료 + backend deregister.
 * 종료 자체가 실패해도 backend deregister는 시도 — 양쪽 상태를 가능한 한 동기화.
 * LA push subscription도 함께 정리.
 */
export async function endLiveActivityWithDeregister(
  tripToken: string,
): Promise<void> {
  if (activeTeardown) {
    activeTeardown();
    activeTeardown = null;
  }
  try {
    await endLiveActivity();
  } finally {
    await clearLiveActivityToken(tripToken).catch((e) => {
      log.warn('LA deregister threw', e);
    });
  }
}

/**
 * 테스트 전용: 모듈 내 활성 세션을 초기화.
 * 프로덕션 호출 금지.
 */
export function __resetLiveActivityPushChannelForTests(): void {
  if (activeTeardown) {
    activeTeardown();
    activeTeardown = null;
  }
}
