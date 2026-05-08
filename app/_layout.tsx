import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { ThemeProvider, useTheme } from '../src/theme';
import { setupNotificationHandler } from '../src/utils/stationNotification';
import { setMinLevel } from '../src/utils/logger';
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
    <ThemeProvider>
      <RootContent />
    </ThemeProvider>
  );
}
