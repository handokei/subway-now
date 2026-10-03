/**
 * 안내 "일시정지" 진입 시각 storage (#2293, Part of #2285 결정 ①+③).
 *
 * "일시정지" 버튼(HomeScreen.handleStopNavigation)을 탭한 시각을 영속화한다. 목적은
 * cold-start backstop(useStateRehydration)이 앱이 kill된 채로 PAUSE_AUTO_END_MS(15분)가
 * 경과했는지 다음 mount/AppState 'active' 진입 시 판정하는 것 — FG 배지 카운트다운(메모리
 * 전용 useNavigationStore.pausedAt)과는 별개 채널이다. 두 값은 handleStopNavigation/
 * handleStartNavigation 호출 시점에 함께 stamp/clear되지만, 서로 다른 목적(FG 표시 vs
 * cold-start 판정)의 독립 판정에만 쓰이고 서로 비교되지 않는다.
 *
 * Writers: HomeScreen.handleStopNavigation (일시정지 진입).
 * Readers: useStateRehydration (cold-start/FG 복귀 backstop 판정).
 * Cleanup: HomeScreen.handleStartNavigation(재개) + tripBoundCleanups(trip 종료 전체 경로 —
 *   FG setDestination(null/switch) / silent push trip-ended / useStateRehydration sentinel /
 *   useLaunchTripReconciliation cold-launch / 본 backstop 자체의 force-cleanup 모두 포함).
 *
 * 모든 함수는 AsyncStorage 실패를 graceful 흡수 — 기록 실패는 배지/backstop 정확도에만
 * 영향, 알람 발사 흐름에는 무영향.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NAVIGATION_PAUSED_AT_KEY } from '../../../shared/constants/storageKeys';
import { PAUSE_AUTO_END_MS } from '../../../shared/constants/realtime';

/** 일시정지 진입 시각 기록. */
export async function setNavigationPausedAt(at: number = Date.now()): Promise<void> {
  try {
    await AsyncStorage.setItem(NAVIGATION_PAUSED_AT_KEY, String(at));
  } catch {
    // graceful — stamp 실패는 backstop이 다음 wake에서 재시도할 뿐, trip 흐름에는 무영향.
  }
}

/** 일시정지 진입 epoch ms 또는 null. 키 부재/NaN 모두 null. */
export async function getNavigationPausedAt(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(NAVIGATION_PAUSED_AT_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 일시정지 stamp 제거. 재개 또는 trip 종료(tripBoundCleanups) 시 호출. */
export async function clearNavigationPausedAt(): Promise<void> {
  try {
    await AsyncStorage.removeItem(NAVIGATION_PAUSED_AT_KEY);
  } catch {
    // graceful — 다음 cleanup에서 재시도.
  }
}

/**
 * 순수 판정 함수 — pausedAt 존재 + PAUSE_AUTO_END_MS 이상 경과 시 true.
 *
 * 신규 타이머 대신 기존 값(pausedAt) 비교만 추가 — FG(HomeScreen이 useCountdown 만료 시 동일
 * 조건을 파생) / cold-start backstop(useStateRehydration) 양쪽이 같은 임계를 공유한다.
 */
export function isPauseAutoEndDue(pausedAt: number | null, now: number = Date.now()): boolean {
  if (pausedAt === null) return false;
  return now - pausedAt >= PAUSE_AUTO_END_MS;
}
