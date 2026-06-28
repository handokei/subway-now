/**
 * #1973 — 안내 시작/중단 명시 의향 SSoT store.
 *
 * 네이버 지도/카카오맵 패턴 정합: 사용자가 "안내 시작" 버튼을 명시적으로 눌러야
 * 백그라운드 GPS 추적 + 자동 lock chain이 활성화된다. WhileInUse 권한 사용자도
 * 안내 시작 후 BG GPS 지속이 가능하다 (iOS `allowsBackgroundLocationUpdates=true`
 * + `showsBackgroundLocationIndicator=true` — 파란 알약 자동 표시).
 *
 * paradigm 정합:
 *  - `navigationActive=true` = 사용자 명시 의향 표명. ADR-014 §X "lock 활성과
 *    동급 정확도 보장 의무" 적용. `feedback_user_intent_equal_protection` 룰의
 *    "BoardingTrainList 직접 탭" 시리즈에 "안내 시작 버튼 탭" 추가 — 동급 보호.
 *  - `navigationActive=false` + lockless trip + fire 0건 → paradigm-intent
 *    (silent push 0건 정상, `lesson_silent_push_zero_is_paradigm_intent`).
 *
 * Lifecycle:
 *  - 사용자 안내 시작 탭: `startNavigation()` — memory state true. HomeScreen이
 *    `setInfoModeEnabled(true)` 자동 wire (useUserIntentStore, #1923).
 *  - 사용자 안내 중단 탭: `stopNavigation()` — memory state false. HomeScreen이
 *    `setInfoModeEnabled(false)` 자동 wire.
 *  - 앱 재시작 / trip 종료: 휘발성 false 유지 — persist 의도적 미적용. 명시 의향이
 *    cold start 사이 leak되지 않도록.
 *
 * `useUserIntentStore`와 별개 store인 이유:
 *  - infoModeEnabled는 trip-bound persist (boardingPrompt 응답/직접 탭 흐름에서도
 *    사용). navigationActive는 명시 trigger 전용 + 휘발성.
 *  - HomeScreen에서 두 store를 명시적으로 wire (startNavigation → setInfoModeEnabled(true))
 *    해야 backend lockless intermediate gate 통과.
 */

import { create } from 'zustand';

export interface NavigationState {
  /**
   * 사용자 명시 의향 토글. true면 useBackgroundLocation이 BG GPS 추적 활성화 +
   * HomeScreen이 useUserIntentStore.setInfoModeEnabled(true) wire.
   * 의도적으로 휘발성 (persist 미적용) — cold start 시 false로 reset.
   */
  navigationActive: boolean;
  /**
   * 안내 시작. 사용자가 HomeScreen "안내 시작" 버튼을 탭할 때 호출.
   * memory state만 true로 set (persist 미적용).
   */
  startNavigation: () => void;
  /**
   * 안내 중단. 사용자가 HomeScreen "안내 중단" 버튼을 탭할 때 호출.
   * memory state false로 set. HomeScreen이 useBackgroundLocation cleanup + infoMode reset wire.
   */
  stopNavigation: () => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  navigationActive: false,

  startNavigation: () => {
    set({ navigationActive: true });
  },

  stopNavigation: () => {
    set({ navigationActive: false });
  },
}));
