import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';
import { SENTRY_OPT_IN_KEY } from '../../constants/storageKeys';
import { createLogger } from '../../utils/logger';

const logger = createLogger('SentryInit');

/**
 * #1038 — Sentry 에러 모니터링 init.
 *
 * Privacy stance (default OFF, opt-in only):
 *   - AsyncStorage `SENTRY_OPT_IN_KEY` === 'true' 일 때만 활성화
 *   - DSN(`EXPO_PUBLIC_SENTRY_DSN`) 미설정 시 graceful no-op
 *   - 어떤 실패도 boot path를 막지 않는다 (catch → log)
 *
 * 호출 시점: 앱 boot 직후 (`app/_layout.tsx`) — fire-and-forget.
 * UI 토글은 follow-up PR (concurrent SettingsScreen 작업 머지 후).
 */
export async function initSentryIfOptedIn(): Promise<void> {
  try {
    const optIn = await AsyncStorage.getItem(SENTRY_OPT_IN_KEY);
    if (optIn !== 'true') {
      return;
    }
    const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    if (!dsn) {
      logger.info('opt-in 상태이지만 DSN 미설정 — Sentry 비활성화');
      return;
    }
    Sentry.init({ dsn });
    logger.info('Sentry 초기화 완료');
  } catch (e) {
    logger.warn('Sentry 초기화 실패:', e);
  }
}
