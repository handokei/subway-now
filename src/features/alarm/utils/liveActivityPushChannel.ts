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
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearLiveActivityToken,
  registerLiveActivityToken,
} from '../api/alarmBackend';
import { ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';
import { isMinimalAlarmEnabled } from '../../../shared/constants/debugFlags';

const log = createLogger('liveActivityPushChannel');

/** 첫 token이 안 올 때 로그만 남기는 안전 timeout. subscription은 끊지 않는다. */
const PUSH_TOKEN_FIRST_EMIT_TIMEOUT_MS = 5000;

/** backend register 재시도(#1288). emit→register race + 일시 network 실패 graceful. */
const REGISTER_RETRY_MAX_ATTEMPTS = 3;
const REGISTER_RETRY_BASE_DELAY_MS = 500;

/**
 * 404 (`trip_not_found`) 응답 시 longer backoff (#1899).
 * device가 trip register POST를 보낸 직후 push token이 emit되면 backend KV write가
 * 아직 propagate되지 않아 LA register가 404로 응답할 수 있다. 500ms 기본 backoff는 짧아
 * 같은 race를 반복 hit하므로, 404 시에만 2s/4s/8s exponential로 늘려 trip register가
 * 도착할 시간을 확보한다. 다른 status(5xx, network)는 기존 500ms/1s 유지 — 일시적
 * 인프라 장애는 빠르게 재시도하는 편이 사용자 가치 손실이 적다.
 */
const REGISTER_RETRY_404_BASE_DELAY_MS = 2000;

/** 현재 LA 세션의 teardown 함수. 단일 LA만 동시 운영한다는 전제. */
let activeTeardown: (() => void) | null = null;
/** 현재 활성 LA 세션의 tripToken. ensureLiveActivityRegistered가 start vs update 판정에 사용. */
let activeTripToken: string | null = null;

/** 테스트용 sleep — fake timer와 호환되도록 setTimeout 사용. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** LA 세션 단위 재시도 취소 플래그(#2310). teardown 시 in-flight 재시도 루프를 중단한다. */
interface RetrySession {
  cancelled: boolean;
}

/**
 * backend `registerLiveActivityToken`을 exponential backoff로 재시도(#1288).
 * 모든 시도 실패 시 silent log — caller(subscription 콜백)는 throw하지 않는다.
 *
 * trip이 cleanup(teardown)되면 `session.cancelled`가 true로 바뀐다(#2310) — 종료된 trip에
 * 계속 register POST를 쏘는 404 storm을 막기 위해 매 attempt 전에 취소 여부를 확인한다.
 */
async function registerWithRetry(
  tripToken: string,
  activityPushToken: string,
  session: RetrySession,
): Promise<boolean> {
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= REGISTER_RETRY_MAX_ATTEMPTS; attempt += 1) {
    if (session.cancelled) {
      log.info('LA register retry cancelled — trip ended');
      return false;
    }
    try {
      const result = await registerLiveActivityToken(tripToken, activityPushToken);
      if (result.ok) return true;
      lastStatus = result.status;
      log.warn(`LA register attempt ${attempt} not ok status=${result.status ?? 'none'}`);
    } catch (e) {
      lastStatus = undefined;
      log.warn(`LA register attempt ${attempt} threw`, e);
    }
    if (attempt < REGISTER_RETRY_MAX_ATTEMPTS) {
      // #1899 — 404(trip_not_found)는 trip register propagate race이므로 longer backoff.
      const base =
        lastStatus === 404 ? REGISTER_RETRY_404_BASE_DELAY_MS : REGISTER_RETRY_BASE_DELAY_MS;
      await sleep(base * 2 ** (attempt - 1));
    }
  }
  if (session.cancelled) return false;
  log.warn('LA register exhausted retries — giving up (will retry on next token emit)');
  return false;
}

/**
 * #2667 — **ambient(세션 무관) LA push token 등록.**
 *
 * 왜 필요한가: backend가 LA를 push로 갱신하려면 `trip.activityPushToken`이 있어야 하는데
 * (`fireLiveActivityUpdate`는 그 값이 없으면 no-op), 그 값을 채우는 JS 경로가
 * `startLiveActivityWithRegistration` **하나뿐**이었다. 그런데 실제로 LA를 띄우는 경로들은
 * 그 함수를 쓰지 않는다:
 *   - pre-boarding LA(`useLiveActivityPreBoardingLifecycle`)는 깜빡임을 피하려고 의도적으로
 *     `updateLiveActivity`를 쓴다(native `update()`가 활성 Activity 없으면 `start()`로 fall-through).
 *   - lock 이전 GPS 파이프라인도 trip 미등록 구간에서 `updateLiveActivity`를 직접 호출한다.
 * native `start()`는 어느 경로로 들어오든 `pushType: .token`으로 Activity를 만들고 token을
 * JS로 emit하지만, **그 emit을 듣는 쪽이 없으면 token은 그대로 버려진다.** 결과: backend는
 * LA push를 한 번도 보내지 못한다(2026-09-16 실측 `laPushDelivery=0% (0/0)`, 24h 집계).
 *
 * 이 함수는 LA 세션 소유권과 무관하게 **앱 수명 동안 token emit을 듣고 현재 trip에 등록**한다.
 * Activity를 시작하지도, 종료하지도 않는다(기존 세션 로직 무간섭).
 *
 * 순서 문제(토큰이 trip 등록보다 먼저 올 수 있음)는 emit된 token을 보관해두고 재시도로 흡수한다 —
 * `ACTIVE_TRIP_KEY`가 아직 없으면 backoff 후 다시 읽는다.
 */
let lastEmittedPushToken: string | null = null;
/** 이미 backend에 반영한 (tripToken, pushToken) 조합 — 중복 POST 차단. */
let lastRegisteredAmbientKey: string | null = null;
/**
 * ambient 재시도 취소 신호(코드리뷰 P1-2). 세션 경로(#2310)가 trip 종료 시 in-flight 재시도를
 * 끊는 것과 동일한 장치 — ambient도 trip이 끝나면 즉시 멈춰야 한다. 그렇지 않으면 최대 수십 초
 * 짜리 재시도 창 동안 `endLiveActivityWithDeregister`의 DELETE 뒤에 늦은 POST가 도착해 방금
 * 지운 trip의 activityPushToken을 되살린다.
 */
let ambientRetrySession: RetrySession = { cancelled: false };

/** trip 종료/전환 시 ambient in-flight 재시도를 끊고 dedup 기억을 비운다. */
function resetAmbientRegistrationState(): void {
  ambientRetrySession.cancelled = true;
  ambientRetrySession = { cancelled: false };
  lastRegisteredAmbientKey = null;
}

/** trip 등록(ACTIVE_TRIP_KEY)이 아직 없을 때 재시도 횟수 — LA가 trip보다 먼저 뜨는 순서 흡수. */
const AMBIENT_TRIP_WAIT_ATTEMPTS = 5;

async function registerAmbientToken(): Promise<void> {
  const activityPushToken = lastEmittedPushToken;
  if (!activityPushToken) return;
  const session = ambientRetrySession;
  for (let attempt = 1; attempt <= AMBIENT_TRIP_WAIT_ATTEMPTS; attempt += 1) {
    if (session.cancelled) return; // trip이 끝났다 — 죽은 trip에 token을 되살리지 않는다.
    // 매 attempt마다 다시 읽는다 — 그 사이 trip이 등록됐을 수 있고, 다른 trip으로 바뀌었을 수도 있다.
    const tripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY).catch(() => null);
    if (lastEmittedPushToken !== activityPushToken) return; // 더 새 token이 왔다 — 그쪽이 이어받는다.
    if (tripToken) {
      const key = `${tripToken}:${activityPushToken}`;
      if (key === lastRegisteredAmbientKey) return;
      const ok = await registerWithRetry(tripToken, activityPushToken, session);
      if (ok) {
        lastRegisteredAmbientKey = key;
        log.info('ambient LA token 등록 완료 — backend LA push 채널 활성');
      }
      return;
    }
    if (attempt < AMBIENT_TRIP_WAIT_ATTEMPTS) {
      await sleep(REGISTER_RETRY_404_BASE_DELAY_MS * attempt);
    }
  }
  log.info('ambient LA token — 활성 trip 없음(등록 skip). 다음 emit/트립에서 재시도');
}

/**
 * ambient 구독 시작. 앱 수명 동안 1개만 유지하면 되므로 호출자(훅)가 mount/unmount로 관리한다.
 * 이미 구독 중이면 기존 구독을 그대로 유지하고 teardown만 반환한다(중복 구독 금지).
 */
let ambientSubscription: { remove: () => void } | null = null;

export function startAmbientLiveActivityTokenRegistration(): () => void {
  if (ambientSubscription) return () => undefined;
  const subscription = addPushTokenListener((event: PushTokenEvent) => {
    if (event.token === lastEmittedPushToken) return;
    lastEmittedPushToken = event.token;
    void registerAmbientToken();
  });
  ambientSubscription = subscription;
  return () => {
    subscription.remove();
    ambientSubscription = null;
  };
}

/**
 * trip이 새로 생겼을 때(또는 바뀌었을 때) 호출 — 이미 emit돼 보관 중인 token을 그 trip에 등록한다.
 * token emit이 trip 등록보다 먼저 일어난 순서를 흡수하는 두 번째 경로(구독 콜백과 동일 함수 재사용).
 */
export function registerHeldLiveActivityTokenForCurrentTrip(): void {
  void registerAmbientToken();
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

  const session: RetrySession = { cancelled: false };
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
    void registerWithRetry(tripToken, event.token, session);
  });

  firstEmitTimer = setTimeout(() => {
    // emit이 들어오면 위에서 firstEmitTimer를 clear하므로 이 콜백은 항상 lastToken === null.
    firstEmitTimer = null;
    log.info('push token first-emit timeout — subscription kept');
  }, PUSH_TOKEN_FIRST_EMIT_TIMEOUT_MS);

  const teardown = (): void => {
    // #2310 — 진행 중인 register 재시도 루프도 함께 cancel. 종료된 trip에 대한
    // 404 storm(불필요 네트워크/배터리/로그 오염)을 막는다.
    session.cancelled = true;
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
 * #2481 (backend-authority device 쓰기 억제 게이트, Wave 2) — backend-authority 모드
 * (`isMinimalAlarmEnabled() === false`)에서 device가 LA content-state를 써도 되는지 판정한다.
 * device W2(`updateStationNotification`)/W3(`refreshLiveActivityFromBackgroundContext`)가
 * 공유하는 단일 게이트 — backend가 이미 이 trip의 LA push 채널(`activeTripToken`)을 쥐고 있으면
 * device GPS 추정치로 backend의 정확한 "N정거장"을 덮어쓰지 않는다.
 *
 * true(스킵)는 다음이 모두 성립할 때만:
 *   - backend-authority 모드(dogfood 플래그 OFF)
 *   - tripToken이 존재하고, 이미 이 프로세스에서 LA push 세션이 등록된(`activeTripToken`과 일치)
 *     상태 — backend가 이 trip의 push 채널로 LA를 갱신할 수 있는 상태.
 *
 * false(계속 device가 쓴다)는 blank LA 회귀를 막는 3개 케이스를 모두 커버한다:
 *   - dogfood 모드(flag ON) — 기존 device 동작 100% 유지.
 *   - backend-tracked trip 자체가 없음(tripToken null) — pre-boarding 등 lock 전 구간.
 *   - trip은 있지만 아직 이 프로세스에서 LA push 세션을 등록 못한 상태(첫 write가 곧 세션
 *     부트스트랩이므로 스킵하면 LA가 영영 시작되지 않는다).
 */
export function shouldSkipDeviceLiveActivityWrite(tripToken: string | null): boolean {
  if (isMinimalAlarmEnabled()) return false;
  if (!tripToken) return false;
  return activeTripToken === tripToken;
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
  // #2667 (코드리뷰 P1-2/P2-2) — "trip 종료 = LA push 관련 모듈 상태 전부 정리"를 세션/ambient
  // 양쪽에 동일하게 적용한다. in-flight ambient 재시도가 DELETE 뒤에 POST를 흘리면 backend가
  // 방금 지운 token을 되살린다.
  resetAmbientRegistrationState();
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
  // #2667 — ambient 구독/보관 token도 함께 초기화. 테스트 간 누수 시 "이미 등록됨" dedup이
  // 다음 케이스를 조용히 통과시켜 위양성 green을 만든다.
  ambientSubscription?.remove();
  ambientSubscription = null;
  lastEmittedPushToken = null;
  resetAmbientRegistrationState();
}
