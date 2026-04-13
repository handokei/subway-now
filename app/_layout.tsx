import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { setupNotificationHandler } from '../src/utils/stationNotification';
import { setMinLevel } from '../src/utils/logger';

setupNotificationHandler();

// 프로덕션 빌드에서는 warn 이상만 출력
if (!__DEV__) {
  setMinLevel('warn');
}

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
