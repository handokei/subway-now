import { useEffect } from 'react';
import { DevSettings } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { ThemeProvider, useTheme } from '../src/theme';
import { setupNotificationHandler, refreshNotificationChannels } from '../src/utils/stationNotification';
import { setMinLevel, createLogger } from '../src/utils/logger';
import { i18n } from '../src/i18n';
import { useApplyLocale } from '../src/hooks/useApplyLocale';
import { useAppStore } from '../src/store/useAppStore';
import { DebugModal } from '../src/components/DebugModal';
import '../src/tasks/backgroundLocationTask';
import { registerSilentPushTask } from '../src/tasks/silentPushTask';

const layoutLogger = createLogger('RootLayout');

SplashScreen.preventAutoHideAsync();
setupNotificationHandler();
// iOS silent push BG task 등록 — APNs reschedule trigger 수신용.
// 권한/플랫폼 미지원 시 내부에서 graceful no-op.
registerSilentPushTask().catch((e) => layoutLogger.warn('silent push task 등록 실패:', e));

// 프로덕션 빌드에서는 warn 이상만 출력
if (!__DEV__) {
  setMinLevel('warn');
} else {
  // Fast Refresh 시 모듈 톱레벨이 재실행되며 menu item이 중복 등록되는 것을 방지.
  const g = globalThis as { __SUBWAY_DEV_MENU_REGISTERED__?: boolean };
  if (!g.__SUBWAY_DEV_MENU_REGISTERED__) {
    g.__SUBWAY_DEV_MENU_REGISTERED__ = true;
    DevSettings.addMenuItem('Subway debug', () => {
      useAppStore.getState().setDebugVisible(true);
    });
  }
}

function RootContent() {
  const { isDark } = useTheme();
  const loadLocalePreference = useAppStore((s) => s.loadLocalePreference);
  const debugVisible = useAppStore((s) => s.debugVisible);
  const setDebugVisible = useAppStore((s) => s.setDebugVisible);
  const { i18n: i18nInstance } = useTranslation();

  useEffect(() => {
    loadLocalePreference();
  }, []);

  useApplyLocale();

  // 언어 전환 시 Android 알림 채널 이름을 새 언어로 갱신 (권한 다이얼로그 트리거 없이 채널만)
  useEffect(() => {
    refreshNotificationChannels().catch((e) => layoutLogger.error('알림 채널 갱신 실패:', e));
  }, [i18nInstance.language]);

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false }} />
      {__DEV__ && debugVisible && (
        <DebugModal onClose={() => setDebugVisible(false)} />
      )}
    </>
  );
}

export default function RootLayout() {
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <RootContent />
      </ThemeProvider>
    </I18nextProvider>
  );
}
