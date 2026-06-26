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
 * #1897 (RC-5) — 마지막으로 backend가 confirm한 APNs env를 stamp.
 * register 응답의 `confirmedEnv` 필드를 받아 호출. AsyncStorage 실패는 graceful warn —
 * 다음 register는 build env fallback으로 자연 동작.
 */
export async function setConfirmedApnsEnv(env: ApnsEnv): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_CONFIRMED_APNS_ENV_KEY, env);
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
 */
export async function getRegisteringApnsEnv(): Promise<ApnsEnv> {
  try {
    const stamped = await AsyncStorage.getItem(LAST_CONFIRMED_APNS_ENV_KEY);
    if (stamped === 'sandbox' || stamped === 'production') return stamped;
  } catch (e) {
    logger.warn('read confirmed apns env failed:', e);
  }
  return resolveApnsEnv();
}
