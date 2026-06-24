import { useEffect } from 'react';
import { DevSettings } from 'react-native';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { ThemeProvider, useTheme } from '../src/shared/theme';
import { useOnboardingStore } from '../src/features/onboarding/store/useOnboardingStore';
import { setupNotificationHandler, refreshNotificationChannels } from '../src/features/alarm/utils/stationNotification';
import { setMinLevel, createLogger } from '../src/shared/utils/logger';
import { i18n } from '../src/shared/i18n';
import { useApplyLocale } from '../src/features/settings/hooks/useApplyLocale';
import { useSilentPushTelemetry } from '../src/features/alarm/hooks/useSilentPushTelemetry';
import { useDebugStore } from '../src/features/debug/store/useDebugStore';
import { useDestinationStore } from '../src/features/route/store/useDestinationStore';
import { useLocaleStore } from '../src/shared/i18n/store/useLocaleStore';
import { DebugModal } from '../src/features/debug/components/DebugModal';
import { TripGroundTruthPrompt } from '../src/features/debug/components/TripGroundTruthPrompt';
import { isDebugModalEnabled } from '../src/shared/constants/debugFlags';
import '../src/features/nearest-station/tasks/backgroundLocationTask';
import { registerSilentPushTask } from '../src/features/alarm/tasks/silentPushTask';
import { registerScheduledAlarmListener } from '../src/features/alarm/utils/scheduledAlarmReceiver';
import { cancelScheduledAlarms } from '../src/features/alarm/utils/alarmScheduler';
import { unregisterAlarmRefreshTask } from '../src/features/alarm/tasks/alarmRefreshTask';
import { stopVibration } from '../src/features/alarm/utils/alarmSound';
import {
  setupAlarmCategory,
  setupBoardingPromptCategory,
  setupTripEndedCategory,
} from '../src/features/alarm/utils/notificationCategory';
import { useBoardingPromptResponder } from '../src/features/alarm/hooks/useBoardingPromptResponder';
import { useBoardingPromptDisplayLogger } from '../src/features/alarm/hooks/useBoardingPromptDisplayLogger';
import { useStateRehydration } from '../src/shared/hooks/useStateRehydration';
import { useLaunchTripReconciliation } from '../src/features/alarm/hooks/useLaunchTripReconciliation';
import { fetchArrivalInfo } from '../src/features/arrival/api/arrivalApi';
import { FALLBACK_BOARDING_DURATION_MINUTES } from '../src/shared/constants/boardingLock';
import { initSentryIfOptedIn } from '../src/shared/infra/monitoring/sentryInit';
import { hydrateRawSignalBuffer } from '../src/features/observability/utils/rawSignalBuffer';
import { getCurrentTripCorrId } from '../src/features/observability/utils/tripCorrId';

const layoutLogger = createLogger('RootLayout');

// #1038 — Sentry 에러 모니터링 init (default OFF, opt-in only).
// fire-and-forget — boot path 비차단. UI 토글은 follow-up PR.
initSentryIfOptedIn().catch((e) => layoutLogger.warn('Sentry init 실패(#1038):', e));

// #1501 (ADR-015 §10 P5 / PR-A) — boot 시 device raw signal buffer 복원.
// 강제종료 후 재시작에서도 마지막 ~120 entry가 살아남아 7일 회귀(2026-06-17 용마산)
// 같은 cold-launch 사이 데이터 단절을 막는다. fire-and-forget — boot path 비차단.
hydrateRawSignalBuffer().catch((e) =>
  layoutLogger.warn('rawSignalBuffer hydrate 실패(#1501):', e),
);
// #1501 — trip corrId in-memory cache도 boot 시 storage에서 복원.
// 강제종료 후 재진입 시 활성 trip이 살아있는데도 cache=null이면 첫 fusion cycle entries에
// corrId가 박히지 않아 backend join이 깨진다(P2-2 review).
getCurrentTripCorrId().catch((e) =>
  layoutLogger.warn('tripCorrId hydrate 실패(#1501):', e),
);

SplashScreen.preventAutoHideAsync();
setupNotificationHandler();
// iOS silent push BG task 등록 — APNs payload 수신용.
// 권한/플랫폼 미지원 시 내부에서 graceful no-op.
registerSilentPushTask().catch((e) => layoutLogger.warn('silent push task 등록 실패:', e));
// #819 — "탑승했냐?" 푸시의 BOARDING_PROMPT category 등록. 액션 [탑승]/[미탑승]을 노출.
setupBoardingPromptCategory().catch((e) =>
  layoutLogger.warn('boarding-prompt category 등록 실패(#819):', e),
);
// #1798 P2 — transfer/destination 알람 ALARM_CATEGORY 등록. 액션 [확인]/[trip 종료]을 노출.
setupAlarmCategory().catch((e) =>
  layoutLogger.warn('alarm category 등록 실패(#1798):', e),
);
// #1798 P2 — trip 종료 TRIP_ENDED_CATEGORY 등록. 액션 [다음 여정 시작]을 노출.
setupTripEndedCategory().catch((e) =>
  layoutLogger.warn('trip-ended category 등록 실패(#1798):', e),
);
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
      useDebugStore.getState().setDebugVisible(true);
    });
  }
}

function RootContent() {
  const { isDark } = useTheme();
  const loadLocalePreference = useLocaleStore((s) => s.loadLocalePreference);
  const debugVisible = useDebugStore((s) => s.debugVisible);
  const setDebugVisible = useDebugStore((s) => s.setDebugVisible);
  const destinationId = useDestinationStore((s) => s.destination?.id ?? null);
  const { i18n: i18nInstance } = useTranslation();
  const hasCompletedOnboarding = useOnboardingStore((s) => s.hasCompletedOnboarding);
  const loadOnboardingState = useOnboardingStore((s) => s.loadOnboardingState);
  const segments = useSegments();
  const router = useRouter();

  // #1780 — 첫 실행 온보딩 redirect.
  // storage hydrate 완료 후 미완료 사용자는 onboarding으로 보낸다.
  // 이미 onboarding 화면에 있으면 재진입하지 않는다.
  useEffect(() => {
    let cancelled = false;
    loadOnboardingState().then(() => {
      if (cancelled) return;
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const isOnOnboarding = segments[0] === 'onboarding';
    if (!hasCompletedOnboarding && !isOnOnboarding) {
      router.replace('/onboarding');
    }
  }, [hasCompletedOnboarding, segments]);

  // #819 — "탑승했냐?" 응답 listener. boarding-prompt 카테고리 푸시의 [탑승]/[미탑승] 또는 탭을 받아
  // arvlCd 우선순위로 trainCode 자동 lock 또는 5분 silence POST. 미bound trip(destinationId=null)에서도
  // 마운트 — payload만 들어오면 silence POST는 동작.
  useBoardingPromptResponder({
    fetchArrivalsForStation: (stationName) => fetchArrivalInfo(stationName),
    destinationId,
    expectedDurationMs: FALLBACK_BOARDING_DURATION_MINUTES * 60_000,
  });

  // #1385 — boardingPrompt displayed 카운트. FG에서 actionable notification 수신 시 즉시
  // alarm log에 fired 1건 적재한다. responder의 cold-start 보완과 dedup된다.
  useBoardingPromptDisplayLogger();

  // #899 (Seam C) — trip-bound 상태 단일 hydration seam. AppState 'active' 진입 시
  // destination/customOrigin/tripOrigin/lock을 storage에서 재수화하고, BG silent push가
  // trip-ended sentinel을 남겼다면 destination/lock store를 reset해 stale UI를 차단.
  useStateRehydration();

  // #1339 PR2 — silent push 누락(killed-app + push 미도달 등) backstop.
  // cold-launch 시 backend `GET /trips/:tripToken/status`로 trip 종료 여부 확인 후
  // 누락된 user-facing notification + sentinel을 복구한다. sentinel이 이미 있으면 no-op.
  useLaunchTripReconciliation();

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
      {/* #1502 (M2) — trip 종료 정답지 prompt. DebugModal 토글 무관 항상 마운트. */}
      {isDebugModalEnabled() && <TripGroundTruthPrompt />}
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
