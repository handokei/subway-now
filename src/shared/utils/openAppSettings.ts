import { Linking } from 'react-native';
import { createLogger } from './logger';

const logger = createLogger('OpenAppSettings');

/**
 * OS 설정 앱을 연다. 권한 거부 후 사용자가 다시 권한을 켤 수 있도록 안내하는 진입점.
 * Linking.openSettings()가 실패해도 호출자에게 throw하지 않고 로그만 남긴다.
 */
export async function openAppSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch (error) {
    logger.warn('openSettings failed', error);
  }
}
