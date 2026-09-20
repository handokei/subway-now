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
 *  - 사용자 안내 시작 탭: `startNavigation()` — memory state true. HomeScreen이 같은 탭에서
 *    `useUserIntentStore.setPromptOptIn(true)`도 함께 stamp한다(restart-durable, PR #2772
 *    리뷰) — `navigationActive` 자체는 휘발성이라 backend boarding-prompt opt-in 신호로
 *    직접 forward하지 않는다(mid-trip 콜드 재시작 시 재등록에서 opt-in이 사라지는 회귀 방지).
 *  - 사용자 안내 중단("일시정지") 탭: `stopNavigation()` — memory state false. `promptOptIn`은
 *    건드리지 않는다 — 일시정지는 BG GPS만 중단할 뿐 trip을 포기하는 게 아니다.
 *  - 앱 재시작: `navigationActive`는 휘발성 false로 reset(persist 의도적 미적용)되지만,
 *    `promptOptIn`은 AsyncStorage에 남아 있어 mid-trip 재등록에서도 살아있다.
 *  - trip 종료: `promptOptIn`은 `resetPromptOptIn`(tripBoundCleanups)에서 false로 reset.
 *
 * `useUserIntentStore`(`infoModeEnabled` / `promptOptIn`)와 별개 store인 이유:
 *  - infoModeEnabled는 trip-bound persist이며 stamp 진입점이 boardingPrompt [탑승] 응답 /
 *    BoardingTrainList 직접 탭 2곳뿐이다(#2651 — HomeScreen의 자동 wire는 순환 deadlock
 *    (프롬프트를 받아야 stamp가 생기는데 stamp가 있어야 프롬프트가 나가는) 때문에 제거됨).
 *    "프롬프트 자체를 받을지"(promptOptIn)는 안내 시작 탭이 유일한 stamp 진입점이며
 *    "매역 통과 알림을 받을지"(infoModeEnabled)와는 목적이 다르다.
 *  - `navigationActive`는 명시 trigger + BG GPS lifecycle 전용이며 의도적으로 휘발성이다.
 *    HomeScreen이 안내 시작/종료 탭 지점에서 이 store와 `useUserIntentStore.promptOptIn`을
 *    함께 wire한다.
 */

import { create } from 'zustand';

export interface NavigationState {
  /**
   * 사용자 명시 의향 토글. true면 useBackgroundLocation이 BG GPS 추적 활성화 +
   * HomeScreen이 useUserIntentStore.setPromptOptIn(true) wire (durable, #2651).
   * 의도적으로 휘발성 (persist 미적용) — cold start 시 false로 reset.
   */
  navigationActive: boolean;
  /**
   * #2293 (Part of #2285 결정 ①+③) — "일시정지" 진입 시각(epoch ms), FG 배지 카운트다운
   * 표시 전용 메모리 값. stopNavigation에서 stamp, startNavigation에서 clear.
   * cold-start 자동 종료 판정은 이 값이 아니라 별도 영속 채널(alarm feature
   * `navigationPauseStorage`, `NAVIGATION_PAUSED_AT_KEY`)을 쓴다 — 이 store는 의도적으로
   * 휘발성이라 cross-feature AsyncStorage 부작용을 담지 않는다(HomeScreen이
   * handleStopNavigation/handleStartNavigation에서 두 채널을 같은 호출 지점에 wire).
   */
  pausedAt: number | null;
  /**
   * 안내 시작. 사용자가 HomeScreen "안내 시작" 버튼을 탭할 때 호출.
   * memory state만 true로 set (persist 미적용). pausedAt도 함께 clear.
   */
  startNavigation: () => void;
  /**
   * 안내 중단(일시정지). 사용자가 HomeScreen "일시정지" 버튼을 탭할 때 호출.
   * memory state false로 set + pausedAt stamp. HomeScreen이 useBackgroundLocation cleanup을
   * wire한다 — `useUserIntentStore.promptOptIn`/`infoModeEnabled`는 건드리지 않는다(#2651,
   * trip을 포기하는 게 아니므로).
   */
  stopNavigation: () => void;
  /**
   * #2293 PR #2301 리뷰 P1 — pausedAt memory만 clear(navigationActive는 건드리지 않음).
   * trip 종료 전체 경로(`tripBoundCleanups`)의 단일 chokepoint에서 storage 채널
   * (`clearNavigationPausedAt`)과 함께 호출된다. 일시정지 상태에서 재개/종료 버튼을
   * 거치지 않고 새 목적지를 바로 선택(`handleSelectDestination`)해도 이전 trip의
   * pausedAt이 새 trip에 stale로 남아 배지+조기 자동종료를 유발하던 회귀를 차단.
   */
  clearPausedAt: () => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  navigationActive: false,
  pausedAt: null,

  startNavigation: () => {
    set({ navigationActive: true, pausedAt: null });
  },

  stopNavigation: () => {
    set({ navigationActive: false, pausedAt: Date.now() });
  },

  clearPausedAt: () => {
    set({ pausedAt: null });
  },
}));
