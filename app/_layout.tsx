import { useEffect } from 'react';
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
import '../src/tasks/backgroundLocationTask';

const layoutLogger = createLogger('RootLayout');

SplashScreen.preventAutoHideAsync();
setupNotificationHandler();

// 프로덕션 빌드에서는 warn 이상만 출력
if (!__DEV__) {
  setMinLevel('warn');
}

function RootContent() {
  const { isDark } = useTheme();
  const loadLocalePreference = useAppStore((s) => s.loadLocalePreference);
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
