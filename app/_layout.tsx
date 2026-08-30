import { useEffect, useState } from 'react';
import { DevSettings } from 'react-native';
import * as Notifications from 'expo-notifications';
import { Redirect, router, Stack, useSegments } from 'expo-router';
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
import { unregisterAlarmRefreshTask } from '../src/features/alarm/tasks/alarmRefreshTask';
import { stopVibration } from '../src/features/alarm/utils/alarmSound';
import {
  setupAlarmCategory,
  setupBoardingPromptCategory,
  setupDisembarkPromptCategory,
  setupTripEndedCategory,
} from '../src/features/alarm/utils/notificationCategory';
import { useBoardingPromptResponder } from '../src/features/alarm/hooks/useBoardingPromptResponder';
import { useLiveActivityIntentBridge } from '../src/features/alarm/hooks/useLiveActivityIntentBridge';
import { useAlarmEndTripResponder } from '../src/features/alarm/hooks/useAlarmEndTripResponder';
import { useBoardingPromptDisplayLogger } from '../src/features/alarm/hooks/useBoardingPromptDisplayLogger';
import { useStateRehydration } from '../src/shared/hooks/useStateRehydration';
import { useDeferredNavigate } from '../src/shared/hooks/useDeferredNavigate';
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

// #2374 — 4개 알림 카테고리 setup 함수 배열. 부팅 시 개별 호출(아래, 기존 유지)과 별도로
// RootContent 내부의 언어 변경 재등록 useEffect가 이 배열을 순회 호출한다(하드코딩 나열 방지).
const NOTIFICATION_CATEGORY_SETUP_FNS = [
  setupBoardingPromptCategory,
  setupDisembarkPromptCategory,
  setupAlarmCategory,
  setupTripEndedCategory,
];

SplashScreen.preventAutoHideAsync();
setupNotificationHandler();
// iOS silent push BG task 등록 — APNs payload 수신용.
// 권한/플랫폼 미지원 시 내부에서 graceful no-op.
registerSilentPushTask().catch((e) => layoutLogger.warn('silent push task 등록 실패:', e));
// #819 — "탑승했냐?" 푸시의 BOARDING_PROMPT category 등록. 액션 [탑승]/[미탑승]을 노출.
setupBoardingPromptCategory().catch((e) =>
  layoutLogger.warn('boarding-prompt category 등록 실패(#819):', e),
);
// #2282 — hop-end "하차했냐?" 푸시의 DISEMBARK_PROMPT category 등록. 액션 [하차했어요]/[아직이요]를 노출.
setupDisembarkPromptCategory().catch((e) =>
  layoutLogger.warn('disembark-prompt category 등록 실패(#2282):', e),
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
// 부팅 시 1회 마이그레이션 — #478 PR 1-2 사전예약 폐기 시점의 잔존 정리.
// unregisterAlarmRefreshTask: BGAppRefreshTask가 OS native level에 잔존해 구 스케줄러를
// 재호출하면 cleanup이 무력화됨 — 코드 import 여부와 무관하게 명시적으로 OS에서 unregister.
// #2089 — cancelScheduledAlarms(구 alarm: prefix 정리) 호출은 alarmScheduler.ts 제거와 함께
// 삭제(3종 스케줄러 통합, 이슈 코멘트 2026-07-31 매트릭스).
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

  // #1780 — 첫 실행 온보딩: storage에서 완료 여부 로드.
  // hydrated=true 시점에 SplashScreen.hideAsync() 호출하여 splash가 영구 잔류하는 회귀 차단.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadOnboardingState().finally(() => {
      if (!cancelled) setHydrated(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (hydrated) {
      SplashScreen.hideAsync().catch((e) => layoutLogger.warn('SplashScreen.hideAsync 실패', e));
    }
  }, [hydrated]);

  // #1910 — cold-start gate: hydrated=false 시 navigate 요청을 defer, hydrated=true 후 flush.
  // useDeferredNavigate가 pending ref + flush effect를 캡슐화한다.
  const requestNavigate = useDeferredNavigate(hydrated, () => router.navigate('/'));

  // #819 — "탑승했냐?" 응답 listener. boarding-prompt 카테고리 푸시의 [탑승]/[미탑승] 또는 탭을 받아
  // arvlCd 우선순위로 trainCode 자동 lock 또는 5분 silence POST. 미bound trip(destinationId=null)에서도
  // 마운트 — payload만 들어오면 silence POST는 동작.
  // #1888 (RC-13) — banner를 직접 탭한 경우 home 화면으로 navigate해 BoardingTrainList를 노출.
  useBoardingPromptResponder({
    fetchArrivalsForStation: (stationName) => fetchArrivalInfo(stationName),
    destinationId,
    expectedDurationMs: FALLBACK_BOARDING_DURATION_MINUTES * 60_000,
    onBannerTap: requestNavigate,
  });

  // #2438 — LA(Live Activity) 버튼 탭 → App Group pending intent를 위 responder와 동일한
  // handleResponse 경로로 위임. deps shape은 useBoardingPromptResponder와 동일해 두 채널이
  // 같은 lock 생성/해제 컨텍스트를 공유한다(⑥ dedup은 훅 내부에서 active lock 존재로 판단).
  useLiveActivityIntentBridge({
    fetchArrivalsForStation: (stationName) => fetchArrivalInfo(stationName),
    destinationId,
    expectedDurationMs: FALLBACK_BOARDING_DURATION_MINUTES * 60_000,
    onBannerTap: requestNavigate,
  });

  // #1385 — boardingPrompt displayed 카운트. FG에서 actionable notification 수신 시 즉시
  // alarm log에 fired 1건 적재한다. responder의 cold-start 보완과 dedup된다.
  useBoardingPromptDisplayLogger();

  // #2428 — ALARM_CATEGORY 알림 [trip 종료] 액션(ALARM_ACTION_END_TRIP) 응답 listener.
  // 탭 시 cleanupUserInitiatedEndedTrip으로 trip을 완전히 종료한다(기존 dead wire 수정).
  useAlarmEndTripResponder();

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

  // #2374 — iOS 알림 카테고리 액션 버튼 라벨 재등록. 부팅 시 모듈 톱레벨 1회 등록만으로는
  // i18next.changeLanguage() 이후 버튼 라벨이 옛 언어로 남는다. 위 refreshNotificationChannels
  // effect와 동일 패턴으로 언어 변경마다 4개 카테고리를 재등록한다.
  useEffect(() => {
    NOTIFICATION_CATEGORY_SETUP_FNS.forEach((setup) => {
      setup().catch((e) => layoutLogger.warn('알림 카테고리 재등록 실패(#2374):', e));
    });
  }, [i18nInstance.language]);

  // #1780 — 첫 실행 온보딩 redirect.
  // router.replace(useEffect) 대신 Redirect 컴포넌트로 render path 안에서 처리.
  // Stack 마운트 전 navigate 호출로 인한 "Attempted to navigate before mounting the Root Layout" crash 방지.
  // #1809 — hydrated 전에는 hasCompletedOnboarding=false(초기값)이므로 redirect를 보류.
  // SplashScreen.preventAutoHideAsync()가 splash를 유지하므로 null 반환은 안전.
  const isOnOnboarding = segments[0] === 'onboarding';
  if (!hydrated) {
    return null;
  }
  if (!hasCompletedOnboarding && !isOnOnboarding) {
    return <Redirect href="/onboarding" />;
  }

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
