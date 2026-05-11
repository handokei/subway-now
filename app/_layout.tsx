import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { I18nextProvider } from 'react-i18next';
import { ThemeProvider, useTheme } from '../src/theme';
import { setupNotificationHandler } from '../src/utils/stationNotification';
import { setMinLevel } from '../src/utils/logger';
import { i18n } from '../src/i18n';
import '../src/tasks/backgroundLocationTask';

SplashScreen.preventAutoHideAsync();
setupNotificationHandler();

// 프로덕션 빌드에서는 warn 이상만 출력
if (!__DEV__) {
  setMinLevel('warn');
}

function RootContent() {
  const { isDark } = useTheme();
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
