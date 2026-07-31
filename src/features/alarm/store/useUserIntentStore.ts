/**
 * #1923 — 사용자 명시 의향 토글 (infoModeEnabled) SSoT store.
 *
 * 별도 "C 토글" UI는 존재하지 않는다 — ADR-014가 그 표현을 쓰던 시절의 doc 잔재이며
 * #1961에서 정정됨. 실제 stamp 진입점은 2개뿐이다.
 *
 * paradigm Phase 6 (단독 사용자 모드) device-only chain의 진원지. 사용자가
 * boardingPrompt [탑승] 응답 / BoardingTrainList 직접 탭 중 하나라도 행하면
 * 본 store에 `infoModeEnabled=true`로 stamp된다. `useApnsTripRegistration`이 이
 * 값을 읽어 `RegisterTripPayload.infoModeEnabled`로 backend에 송신하며, backend는
 * cron lockless intermediate gate(`trip.infoModeEnabled && waypoint.kind === 'intermediate'`)
 * 가 통과되어 station-passed silent push를 발사한다. admin kill switch(#1967,
 * `killSwitchLocklessIntermediate`)로 이 게이트 자체를 backend deploy 없이 즉시
 * 우회할 수 있다. ADR-024가 정의하는 알림/알람 원격 visible 채널과는 별개 경로다.
 *
 * ADR-014 §X "사용자 명시 의향 trip = lock 활성과 동급 정확도 보장 의무" 정합.
 *
 * Lifecycle:
 *  - mount: `loadInfoModeEnabled()` — AsyncStorage hydrate (cold start 보장).
 *  - 사용자 의향 표명: `setInfoModeEnabled(true)` — memory + storage atomic.
 *  - trip 종료: `runTripBoundCleanups()`에서 `setInfoModeEnabled(false)` —
 *    이전 trip의 의향 신호가 새 trip에 leak되지 않도록.
 *
 * `useBoardingLockStore`와 다른 lifecycle (lock 없어도 의향만 살아있을 수 있음) —
 * 책임 분리 위해 별도 store. 옵션 C-2 (이슈 #1923 §3.2 Fix C).
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { USER_INTENT_INFO_MODE_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('useUserIntentStore');

/** AsyncStorage value 표기 — 'true' string 또는 키 부재(=false). */
const STORAGE_VALUE_TRUE = 'true';

export interface UserIntentState {
  /**
   * 사용자 명시 의향 토글. true면 backend lockless intermediate gate 통과 →
   * station-passed silent push 발사 path 활성.
   */
  infoModeEnabled: boolean;
  /**
   * memory state 갱신 + AsyncStorage 동기 영속화. storage write 실패는 graceful —
   * 메모리는 즉시 반영되며 다음 cold start에서 stale 'true'/false로 fallback.
   */
  setInfoModeEnabled: (enabled: boolean) => Promise<void>;
  /**
   * cold start 시 storage hydrate. parse 실패/키 부재는 false 유지.
   */
  loadInfoModeEnabled: () => Promise<void>;
}

export const useUserIntentStore = create<UserIntentState>((set) => ({
  infoModeEnabled: false,

  setInfoModeEnabled: async (enabled: boolean) => {
    set({ infoModeEnabled: enabled });
    try {
      if (enabled) {
        await AsyncStorage.setItem(USER_INTENT_INFO_MODE_KEY, STORAGE_VALUE_TRUE);
      } else {
        await AsyncStorage.removeItem(USER_INTENT_INFO_MODE_KEY);
      }
    } catch (e) {
      // graceful — 메모리는 이미 반영. 다음 cold start에서 stale fallback.
      log.warn('persist failed', e);
    }
  },

  loadInfoModeEnabled: async () => {
    try {
      const raw = await AsyncStorage.getItem(USER_INTENT_INFO_MODE_KEY);
      set({ infoModeEnabled: raw === STORAGE_VALUE_TRUE });
    } catch (e) {
      // graceful — 키 부재/parse 실패는 false 유지 (안전한 default).
      log.warn('hydrate failed', e);
    }
  },
}));

/**
 * #1923 — trip 종료 시 `runTripBoundCleanups`에서 호출하는 cleanup helper.
 *
 * `setInfoModeEnabled(false)`를 직접 호출하는 thin wrapper로 `TRIP_BOUND_CLEANUPS` 배열의
 * `() => Promise<void>` shape에 맞춘다. memory + storage 동시 reset 보장.
 */
export function resetUserIntentInfoMode(): Promise<void> {
  return useUserIntentStore.getState().setInfoModeEnabled(false);
}
