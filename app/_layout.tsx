import { useEffect } from 'react';
import { DevSettings } from 'react-native';
import * as Notifications from 'expo-notifications';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { ThemeProvider, useTheme } from '../src/theme';
import { setupNotificationHandler, refreshNotificationChannels } from '../src/utils/stationNotification';
import { setMinLevel, createLogger } from '../src/utils/logger';
import { i18n } from '../src/i18n';
import { useApplyLocale } from '../src/hooks/useApplyLocale';
import { useSilentPushTelemetry } from '../src/hooks/useSilentPushTelemetry';
import { useAppStore } from '../src/store/useAppStore';
import { DebugModal } from '../src/components/DebugModal';
import { isDebugModalEnabled } from '../src/constants/debugFlags';
import '../src/tasks/backgroundLocationTask';
import { registerSilentPushTask } from '../src/tasks/silentPushTask';
import { registerScheduledAlarmListener } from '../src/utils/scheduledAlarmReceiver';
import { cancelScheduledAlarms } from '../src/utils/alarmScheduler';
import { unregisterAlarmRefreshTask } from '../src/tasks/alarmRefreshTask';
import { stopVibration } from '../src/utils/alarmSound';

const layoutLogger = createLogger('RootLayout');

SplashScreen.preventAutoHideAsync();
setupNotificationHandler();
// iOS silent push BG task 등록 — APNs payload 수신용.
// 권한/플랫폼 미지원 시 내부에서 graceful no-op.
registerSilentPushTask().catch((e) => layoutLogger.warn('silent push task 등록 실패:', e));
// 사전 예약 alarm receiver는 잔존 예약 발사 시 FIRED_ALARMS 갱신만 담당.
registerScheduledAlarmListener();
// 부팅 시 1회 마이그레이션 — #478 PR 1-2 사전예약 폐기 시점:
//   1) cancelScheduledAlarms: 이미 OS에 등록된 사전예약 DATE 트리거 해제
//   2) unregisterAlarmRefreshTask: BGAppRefreshTask가 OS native level에 잔존해
//      15분 주기로 scheduleAlarmsForRoute를 재호출하면 cleanup이 무력화됨.
//      코드 import 여부와 무관하게 명시적으로 OS에서 unregister.
// 두 호출 모두 stopgap 완전 제거(#411) 머지 시점에 같이 정리한다.
cancelScheduledAlarms().catch((e) =>
  layoutLogger.warn('잔존 사전예약 정리 실패(#478 마이그레이션):', e),
);
unregisterAlarmRefreshTask().catch((e) =>
  layoutLogger.warn('잔존 alarmRefreshTask 정리 실패(#478 마이그레이션):', e),
);

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

  // #623 — 사용자가 잠금화면에서 노티 tap/dismiss할 때 진동이 안 멈추는 문제 해결.
  // FG AlarmOverlay 외 경로(잠금화면 swipe)는 ResponseReceivedListener로만 잡힌다.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(() => {
      stopVibration();
    });
    return () => sub.remove();
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
      {isDebugModalEnabled() && debugVisible && (
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
