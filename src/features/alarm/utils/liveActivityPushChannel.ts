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
  updateLiveActivity,
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

/** backend register 재시도(#1288). emit→register race + 일시 network 실패 graceful. */
const REGISTER_RETRY_MAX_ATTEMPTS = 3;
const REGISTER_RETRY_BASE_DELAY_MS = 500;

/** 현재 LA 세션의 teardown 함수. 단일 LA만 동시 운영한다는 전제. */
let activeTeardown: (() => void) | null = null;
/** 현재 활성 LA 세션의 tripToken. ensureLiveActivityRegistered가 start vs update 판정에 사용. */
let activeTripToken: string | null = null;

/** 테스트용 sleep — fake timer와 호환되도록 setTimeout 사용. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * backend `registerLiveActivityToken`을 exponential backoff로 재시도(#1288).
 * 모든 시도 실패 시 silent log — caller(subscription 콜백)는 throw하지 않는다.
 */
async function registerWithRetry(
  tripToken: string,
  activityPushToken: string,
): Promise<void> {
  for (let attempt = 1; attempt <= REGISTER_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await registerLiveActivityToken(tripToken, activityPushToken);
      if (result.ok) return;
      log.warn(`LA register attempt ${attempt} not ok status=${result.status ?? 'none'}`);
    } catch (e) {
      log.warn(`LA register attempt ${attempt} threw`, e);
    }
    if (attempt < REGISTER_RETRY_MAX_ATTEMPTS) {
      await sleep(REGISTER_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  log.warn('LA register exhausted retries — giving up (will retry on next token emit)');
}

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
  activeTripToken = tripToken;

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
    void registerWithRetry(tripToken, event.token);
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
      activeTripToken = null;
    }
    throw e;
  }
}

/**
 * stationNotification 등 LA 업데이트 호출자가 사용하는 단일 진입점(#1288).
 * - 활성 세션 없음 → `startLiveActivityWithRegistration` 호출(token 구독 + native start).
 * - 활성 세션 + 동일 tripToken → native `updateLiveActivity`만 호출(기존 subscription 보존).
 * - 활성 세션 + 다른 tripToken → 이전 정리 후 새 세션 시작(이전 trip의 LA token deregister).
 *
 * 호출자 회귀 안전: throw 시 caller가 fallback(일반 알림)로 분기할 수 있도록 그대로 전파한다.
 */
export async function ensureLiveActivityRegistered(
  tripToken: string,
  data: LiveActivityData,
): Promise<void> {
  if (activeTeardown !== null && activeTripToken === tripToken) {
    await updateLiveActivity(data);
    return;
  }
  if (activeTeardown !== null && activeTripToken !== null && activeTripToken !== tripToken) {
    // tripToken 변경 — 이전 trip의 LA token을 backend에서도 정리.
    const prev = activeTripToken;
    await endLiveActivityWithDeregister(prev).catch((e) => {
      log.warn('previous LA deregister failed', e);
    });
  }
  await startLiveActivityWithRegistration(tripToken, data);
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
  activeTripToken = null;
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
  activeTripToken = null;
}
