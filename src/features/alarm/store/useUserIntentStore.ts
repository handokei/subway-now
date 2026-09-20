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
 *
 * #2651 (PR #2772 리뷰) — `promptOptIn` 필드가 이 store에 추가됐다. `infoModeEnabled`("매역 통과
 * 알림을 받을지", 응답/직접 탭 2곳에서만 stamp)와 목적이 다르다 — `promptOptIn`은 "탑승 프롬프트
 * 자체를 받을지"의 신호이며, "안내 시작" 버튼 탭이 유일한 stamp 진입점이다. `useNavigationStore
 * .navigationActive`(휘발성)를 그대로 쓰지 않고 이 store에 별도 persist하는 이유는 mid-trip
 * 콜드 재시작 후에도 첫 재등록에서 opt-in이 살아있어야 하기 때문이다.
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  USER_INTENT_INFO_MODE_KEY,
  USER_INTENT_BOARDING_COMMITTED_KEY,
  USER_INTENT_PROMPT_OPT_IN_KEY,
} from '../../../shared/constants/storageKeys';
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
  /**
   * #2524 — 탑승 커밋(PENDING fallback lock 생성) 시그널. `infoModeEnabled`와 달리 안내
   * 시작(`HomeScreen.handleStartNavigation`)에서는 세팅되지 않는다 — "탑승했지만 열차 미확정"과
   * "정보용 안내 시작"을 backend가 구분할 수 있는 유일한 채널.
   * `useBoardingPromptResponder.createPendingFallbackLock`에서만 true로 stamp.
   */
  boardingCommitted: boolean;
  /** memory + AsyncStorage 동기 영속화. `setInfoModeEnabled`와 동일 pattern. */
  setBoardingCommitted: (committed: boolean) => Promise<void>;
  /** cold start 시 storage hydrate. parse 실패/키 부재는 false 유지. */
  loadBoardingCommitted: () => Promise<void>;
  /**
   * #2651 (PR #2772 리뷰) — boarding-prompt opt-in(안내 시작) 시그널의 restart-durable SSoT.
   * `useNavigationStore.navigationActive`는 의도적으로 휘발성이라, mid-trip 콜드 재시작 후
   * 첫 재등록에서 opt-in이 미송신되는 회귀를 막기 위해 이 store가 AsyncStorage에 별도 persist한다.
   * `HomeScreen.handleStartNavigation`에서 true로 stamp, `handleStopNavigation`("일시정지")에서
   * false로 stamp한다(PR #2772 전체 리뷰, 트레이드오프 결정) — 일시정지는 trip을 포기하는 게
   * 아니지만 "지금 프롬프트를 받고 있다"는 opt-in 신호는 pause 중 꺼져야 boarding-prompt 침묵이
   * 복원된다. `infoModeEnabled`(명시 의향 이력)는 이와 무관하게 pause에서 절대 건드리지 않는다.
   * 재개 시 다시 true로 stamp. trip 종료 cleanup(`resetPromptOptIn`)에서도 false로 reset.
   */
  promptOptIn: boolean;
  /** memory + AsyncStorage 동기 영속화. `setInfoModeEnabled`와 동일 pattern. */
  setPromptOptIn: (optIn: boolean) => Promise<void>;
  /**
   * cold start 시 storage hydrate. parse 실패/키 부재는 false 유지. 완료 시(성공/실패 무관)
   * `promptOptInHydrated`를 true로 stamp한다.
   */
  loadPromptOptIn: () => Promise<void>;
  /**
   * #2651 (PR #2772 전체 리뷰, 항목 5) — `loadPromptOptIn()`이 완료됐는지(성공/실패 무관 —
   * AsyncStorage 조회 시도 자체가 끝났으면 true). 초기값 false. `useApnsTripRegistration`이
   * 이 값을 `promptOptInHydrated`로 forward해 hydrate 완료 전 register를 억제한다(#2673과
   * 동일 클래스 race — hydrate 전 `promptOptIn`은 항상 초기값 false라 그대로 보내면 storage에
   * true가 남아있던 trip을 backend KV에서 false로 덮어쓴다).
   */
  promptOptInHydrated: boolean;
}

export const useUserIntentStore = create<UserIntentState>((set) => ({
  infoModeEnabled: false,
  boardingCommitted: false,
  promptOptIn: false,
  promptOptInHydrated: false,

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

  setBoardingCommitted: async (committed: boolean) => {
    set({ boardingCommitted: committed });
    try {
      if (committed) {
        await AsyncStorage.setItem(USER_INTENT_BOARDING_COMMITTED_KEY, STORAGE_VALUE_TRUE);
      } else {
        await AsyncStorage.removeItem(USER_INTENT_BOARDING_COMMITTED_KEY);
      }
    } catch (e) {
      log.warn('boardingCommitted persist failed', e);
    }
  },

  loadBoardingCommitted: async () => {
    try {
      const raw = await AsyncStorage.getItem(USER_INTENT_BOARDING_COMMITTED_KEY);
      set({ boardingCommitted: raw === STORAGE_VALUE_TRUE });
    } catch (e) {
      log.warn('boardingCommitted hydrate failed', e);
    }
  },

  setPromptOptIn: async (optIn: boolean) => {
    set({ promptOptIn: optIn });
    try {
      if (optIn) {
        await AsyncStorage.setItem(USER_INTENT_PROMPT_OPT_IN_KEY, STORAGE_VALUE_TRUE);
      } else {
        await AsyncStorage.removeItem(USER_INTENT_PROMPT_OPT_IN_KEY);
      }
    } catch (e) {
      log.warn('promptOptIn persist failed', e);
    }
  },

  loadPromptOptIn: async () => {
    try {
      const raw = await AsyncStorage.getItem(USER_INTENT_PROMPT_OPT_IN_KEY);
      set({ promptOptIn: raw === STORAGE_VALUE_TRUE, promptOptInHydrated: true });
    } catch (e) {
      // #2651 (PR #2772 전체 리뷰, 항목 5) — 실패해도 hydrate "시도"는 끝났으므로
      // promptOptInHydrated는 true로 stamp한다 — 그렇지 않으면 register가 영구 억제된다.
      // promptOptIn 값 자체는 안전한 default(false) 그대로.
      set({ promptOptInHydrated: true });
      log.warn('promptOptIn hydrate failed', e);
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

/**
 * #2524 — trip 종료 시 `runTripBoundCleanups`에서 호출하는 cleanup helper.
 *
 * 이전 trip의 탑승 커밋 신호가 새 trip에 leak되지 않도록 memory + storage 동시 false 처리.
 * `resetUserIntentInfoMode`와 동일 wiring pattern.
 */
export function resetBoardingCommitted(): Promise<void> {
  return useUserIntentStore.getState().setBoardingCommitted(false);
}

/**
 * #2651 (PR #2772 리뷰) — trip 종료 시 `runTripBoundCleanups`에서 호출하는 cleanup helper.
 *
 * 이전 trip의 안내시작(promptOptIn) 신호가 새 trip에 leak되지 않도록 memory + storage 동시
 * false 처리. "일시정지"(handleStopNavigation)는 이 함수를 호출하지 않는다 — 이 값은 trip
 * 종료에서만 해제된다. `resetUserIntentInfoMode`/`resetBoardingCommitted`와 동일 wiring pattern.
 */
export function resetPromptOptIn(): Promise<void> {
  return useUserIntentStore.getState().setPromptOptIn(false);
}
