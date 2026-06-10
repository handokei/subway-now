import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';
import { SENTRY_OPT_IN_KEY } from '../../constants/storageKeys';
import { createLogger } from '../../utils/logger';

const logger = createLogger('SentryInit');

const OPT_IN_VALUE = 'true';

/**
 * #1038 — Sentry 에러 모니터링 init.
 *
 * Privacy stance (default OFF, opt-in only):
 *   - AsyncStorage `SENTRY_OPT_IN_KEY` === 'true' 일 때만 활성화
 *   - DSN(`EXPO_PUBLIC_SENTRY_DSN`) 미설정 시 graceful no-op
 *   - 어떤 실패도 boot path를 막지 않는다 (catch → log)
 *
 * 호출 시점: 앱 boot 직후 (`app/_layout.tsx`) — fire-and-forget.
 * 런타임 토글(#1038 follow-up): {@link setSentryOptIn}.
 */
export async function initSentryIfOptedIn(): Promise<void> {
  try {
    const optIn = await AsyncStorage.getItem(SENTRY_OPT_IN_KEY);
    if (optIn !== OPT_IN_VALUE) {
      return;
    }
    enableSentry();
  } catch (e) {
    logger.warn('Sentry 초기화 실패:', e);
  }
}

/**
 * #1038 follow-up — opt-in 상태 영속 + Sentry SDK 런타임 활성/비활성.
 *
 * - enabled === true: AsyncStorage에 'true' 저장 + (DSN 있으면) `Sentry.init`
 * - enabled === false: AsyncStorage에 'false' 저장 + `Sentry.close()`
 * 두 경로 모두 실패해도 throw하지 않는다 (UI 토글이 boot path와 동일하게 graceful).
 */
export async function setSentryOptIn(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(SENTRY_OPT_IN_KEY, enabled ? OPT_IN_VALUE : 'false');
  } catch (e) {
    logger.warn('Sentry opt-in 저장 실패:', e);
  }
  try {
    if (enabled) {
      enableSentry();
    } else {
      Sentry.close();
      logger.info('Sentry 비활성화');
    }
  } catch (e) {
    logger.warn('Sentry SDK 토글 실패:', e);
  }
}

/**
 * 저장된 opt-in 상태를 반환한다 (boot 후 store 복원용).
 * 실패 시 false (default OFF).
 */
export async function getSentryOptIn(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(SENTRY_OPT_IN_KEY);
    return raw === OPT_IN_VALUE;
  } catch {
    return false;
  }
}

function enableSentry(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) {
    logger.info('opt-in 상태이지만 DSN 미설정 — Sentry 비활성화');
    return;
  }
  Sentry.init({ dsn });
  logger.info('Sentry 초기화 완료');
}
