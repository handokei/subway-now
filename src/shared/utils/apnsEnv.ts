/**
 * APNs 토큰 환경(sandbox / production) 판별 (#482).
 *
 * 정책:
 * - `EXPO_PUBLIC_APNS_ENV`가 'sandbox' 또는 'production'으로 명시되면 그 값을 신뢰
 * - 그 외(미설정/오타) → 'sandbox' fallback
 *
 * 이유: iOS는 dev/preview/internal distribution 빌드에 sandbox APNs 토큰을 발급하고,
 * 이를 production host로 보내면 `BadDeviceToken`(400)으로 거부된다. 'production'은
 * App Store/TestFlight 빌드에서만 의미가 있으므로, EAS production profile에서
 * `EXPO_PUBLIC_APNS_ENV=production`을 반드시 명시 설정해야 한다.
 *
 * #1897 (RC-5) — build env(`resolveApnsEnv`)와 별개로 backend가 push 시 self-heal로
 * 정정한 env를 device가 영속 stamp(`LAST_CONFIRMED_APNS_ENV_KEY`)한다. iOS OS-issued
 * token type(실제 sandbox/production)을 device가 직접 확인할 API가 없으므로 backend의
 * confirm 결과를 1순위로 사용해 self-heal 발동 횟수를 0에 수렴시킨다.
 *
 * #1931 — RC-5 stamp가 cold start 시점에 미반영되는 race window 회귀(6/26 6건 + 6/27 1건).
 * 첫 register 호출이 AsyncStorage read 완료 이전에 build env로 fall through 하던 경로를
 * `warmupConfirmedApnsEnv()`로 priming해 첫 stamp 조회 이전에 캐시한다. caller(mount-once
 * effect)는 fire-and-forget으로 호출만 하면 되고, 이후 `getRegisteringApnsEnv()`는 동일
 * promise를 await해 cache miss 시 추가 round-trip 없이 즉시 해소된다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LAST_CONFIRMED_APNS_ENV_KEY } from '../constants/storageKeys';
import { createLogger } from './logger';

export type ApnsEnv = 'sandbox' | 'production';

const logger = createLogger('apnsEnv');

export function resolveApnsEnv(): ApnsEnv {
  const raw = process.env.EXPO_PUBLIC_APNS_ENV;
  if (raw === 'production' || raw === 'sandbox') return raw;
  return 'sandbox';
}

/**
 * #1931 — module-level cache. `warmupConfirmedApnsEnv`가 첫 호출 시 AsyncStorage read를
 * 시작하고, 이후 모든 caller(`getRegisteringApnsEnv` / 후속 warmup)는 동일 promise를
 * await한다. 한 cold start 안에서 stamp read는 최대 1회만 발생.
 *
 * 실패(reject 형태로 throw)는 본 모듈에서 자체 흡수 → resolve(null)로 마무리한다. caller가
 * 별도 try/catch 없이 stamp 부재로 처리할 수 있도록 단일 채널로 정규화.
 */
let stampWarmupPromise: Promise<ApnsEnv | null> | null = null;

async function readStampSafely(): Promise<ApnsEnv | null> {
  try {
    const stamped = await AsyncStorage.getItem(LAST_CONFIRMED_APNS_ENV_KEY);
    if (stamped === 'sandbox' || stamped === 'production') return stamped;
    return null;
  } catch (e) {
    logger.warn('read confirmed apns env failed:', e);
    return null;
  }
}

/**
 * #1931 — cold start 시점에 `LAST_CONFIRMED_APNS_ENV_KEY` AsyncStorage read를 미리 시작.
 * caller는 await 없이 fire-and-forget으로 호출만 하면 cache가 priming된다.
 * `getRegisteringApnsEnv()`가 이후 await할 때 race window를 닫는다.
 *
 * 반환된 promise는 진단/테스트 목적의 옵션 — 일반 caller는 promise를 무시한다.
 */
export function warmupConfirmedApnsEnv(): Promise<ApnsEnv | null> {
  if (!stampWarmupPromise) {
    stampWarmupPromise = readStampSafely();
  }
  return stampWarmupPromise;
}

/**
 * #1897 (RC-5) — 마지막으로 backend가 confirm한 APNs env를 stamp.
 * register 응답의 `confirmedEnv` 필드를 받아 호출. AsyncStorage 실패는 graceful warn —
 * 다음 register는 build env fallback으로 자연 동작.
 *
 * #1931 — stamp 갱신 시 cache invalidate. 같은 cold start 안에서 backend가 정정 echo를
 * 보낸 직후 다른 caller가 `getRegisteringApnsEnv()`를 호출하면 신규 stamp가 즉시 반영되도록.
 */
export async function setConfirmedApnsEnv(env: ApnsEnv): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_CONFIRMED_APNS_ENV_KEY, env);
    // 신규 stamp 즉시 반영 — 이미 resolve된 promise라도 새 값으로 교체.
    stampWarmupPromise = Promise.resolve(env);
  } catch (e) {
    logger.warn('persist confirmed apns env failed:', e);
  }
}

/**
 * #1897 (RC-5) — register POST 시 송신할 apnsEnv 결정.
 *
 * 우선순위:
 *   1) AsyncStorage stamp (이전 register 응답의 confirmedEnv) — backend가 OS token type을
 *      이미 확인한 권위 값. self-heal 발동 차단.
 *   2) `resolveApnsEnv()` (build env) — 첫 register / parse 실패 / 신규 token fallback.
 *
 * AsyncStorage 실패는 graceful — build env fallback으로 자연 동작.
 *
 * #1931 — `warmupConfirmedApnsEnv()`의 cache promise를 1순위로 사용해 cold start 첫
 * register가 read 완료 이전에 build env로 fall through 하던 race window를 닫는다.
 */
export async function getRegisteringApnsEnv(): Promise<ApnsEnv> {
  const stamped = await warmupConfirmedApnsEnv();
  if (stamped) return stamped;
  return resolveApnsEnv();
}

/**
 * #1931 — 테스트 격리용. 모듈 cache promise를 reset한다. production code는 호출하지 않는다.
 */
export function _resetApnsEnvCacheForTesting(): void {
  stampWarmupPromise = null;
}
