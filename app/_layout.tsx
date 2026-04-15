import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { setupNotificationHandler } from '../src/utils/stationNotification';
import { setMinLevel } from '../src/utils/logger';
import { supabase } from '../src/lib/supabase';
import { useAuthStore } from '../src/store/useAuthStore';

setupNotificationHandler();

// 프로덕션 빌드에서는 warn 이상만 출력
if (!__DEV__) {
  setMinLevel('warn');
}

export default function RootLayout() {
  const { restoreSession, setSession } = useAuthStore();

  useEffect(() => {
    restoreSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
      },
    );

    return () => subscription.unsubscribe();
  }, []);

  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
