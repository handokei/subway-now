/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: B1 결정 (Epic #1008, ADR-013) — 토글 OFF 전환 시
 * 활성 BoardingLock을 즉시 cleanup해야 의미적 일관성("전체역 보기 OFF면 lockless 알림 없음")이
 * 유지된다. 그래서 settings feature가 alarm feature의 useBoardingLockStore를 직접 호출한다.
 * 후속 PR에서 orchestration 슬라이스로 추출 예정.
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  SLEEP_MODE_KEY,
  ALLOW_SPEAKER_KEY,
  ACCESSIBILITY_MODE_KEY,
  LOCKLESS_STATION_PASSED_KEY,
} from '../../../shared/constants/storageKeys';
import { getSentryOptIn, setSentryOptIn } from '../../../shared/infra/monitoring/sentryInit';
import { useBoardingLockStore } from '../../alarm/store/useBoardingLockStore';
import { emitLocklessToggleTransition } from '../utils/locklessFunnel';

/**
 * Settings store — ADR 후속 Step 6 (#892).
 *
 * 사용자 토글 묶음: sleepMode / allowSpeaker / accessibilityMode / locklessStationPassed.
 * 각 토글은 AsyncStorage에 개별 키로 영속화되고 boolean 단일 값만 갖는다.
 *
 * 원본: `src/store/useAppStore.ts` settings slice (god object 분해).
 */
export interface SettingsState {
  sleepMode: boolean;
  setSleepMode: (enabled: boolean) => Promise<void>;
  loadSleepMode: () => Promise<void>;

  allowSpeaker: boolean;
  setAllowSpeaker: (enabled: boolean) => Promise<void>;
  loadAllowSpeaker: () => Promise<void>;

  accessibilityMode: boolean;
  setAccessibilityMode: (enabled: boolean) => Promise<void>;
  loadAccessibilityMode: () => Promise<void>;

  /**
   * #816 C — BoardingLock 없는 trip에서도 station-passed(intermediate) 알림을 받을지 여부.
   * 기본 ON (#915 — destination-only baseline). ON 시 useApnsTripRegistration이 backend trip register
   * payload에 포함시키고, backend가 lockless intermediate 발사를 허용한다. 사용자가 명시적으로 OFF
   * 하지 않는 한 zero-config baseline UX를 위해 매역 알림이 자동 동작한다.
   */
  locklessStationPassed: boolean;
  setLocklessStationPassed: (enabled: boolean) => Promise<void>;
  loadLocklessStationPassed: () => Promise<void>;

  /**
   * #1038 follow-up — Sentry 오류 진단 정보 전송 opt-in. 기본 OFF.
   * Storage 형식은 `sentryInit.ts`가 boot path에서 읽는 raw 'true'/'false' 문자열.
   * 토글 시 `setSentryOptIn`이 Sentry SDK를 런타임에 enable/disable한다.
   */
  sentryOptIn: boolean;
  setSentryOptIn: (enabled: boolean) => Promise<void>;
  loadSentryOptIn: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  sleepMode: false,
  allowSpeaker: true,
  accessibilityMode: false,
  // #915 — destination-only baseline UX. 매역 알림이 zero-config로 동작하도록 default ON.
  locklessStationPassed: true,
  // #1038 — privacy stance. 사용자가 명시 동의해야 활성화.
  sentryOptIn: false,

  setSleepMode: async (enabled: boolean) => {
    set({ sleepMode: enabled });
    await AsyncStorage.setItem(SLEEP_MODE_KEY, JSON.stringify(enabled));
  },

  loadSleepMode: async () => {
    try {
      const raw = await AsyncStorage.getItem(SLEEP_MODE_KEY);
      if (raw) {
        set({ sleepMode: JSON.parse(raw) });
      }
    } catch {
      // 저장된 데이터 없음 — false 유지
    }
  },

  setAllowSpeaker: async (enabled: boolean) => {
    set({ allowSpeaker: enabled });
    await AsyncStorage.setItem(ALLOW_SPEAKER_KEY, JSON.stringify(enabled));
  },

  loadAllowSpeaker: async () => {
    try {
      const raw = await AsyncStorage.getItem(ALLOW_SPEAKER_KEY);
      if (raw) {
        set({ allowSpeaker: JSON.parse(raw) === true });
      }
    } catch {
      // 저장된 데이터 없음 — true 유지
    }
  },

  setAccessibilityMode: async (enabled: boolean) => {
    set({ accessibilityMode: enabled });
    await AsyncStorage.setItem(ACCESSIBILITY_MODE_KEY, JSON.stringify(enabled));
  },

  loadAccessibilityMode: async () => {
    try {
      const raw = await AsyncStorage.getItem(ACCESSIBILITY_MODE_KEY);
      if (raw) {
        set({ accessibilityMode: JSON.parse(raw) === true });
      }
    } catch {
      // 저장된 데이터 없음 — false 유지
    }
  },

  setLocklessStationPassed: async (enabled: boolean) => {
    // #1175 — funnel transition emit. set() 전에 prev를 캡처해야 정확한 분기를 얻는다.
    const prev = useSettingsStore.getState().locklessStationPassed;
    set({ locklessStationPassed: enabled });
    await AsyncStorage.setItem(LOCKLESS_STATION_PASSED_KEY, JSON.stringify(enabled));
    // B1 (ADR-013): 토글 OFF 전환 시 활성 BoardingLock을 즉시 해제하여
    // "전체역 보기 OFF면 lockless 알림 없음" 의미를 즉시 반영한다.
    if (!enabled) {
      await useBoardingLockStore.getState().releaseLock();
    }
    await emitLocklessToggleTransition(prev, enabled);
  },

  loadLocklessStationPassed: async () => {
    try {
      const raw = await AsyncStorage.getItem(LOCKLESS_STATION_PASSED_KEY);
      if (raw) {
        set({ locklessStationPassed: JSON.parse(raw) === true });
      }
    } catch {
      // 저장된 데이터 없음 — false 유지
    }
  },

  setSentryOptIn: async (enabled: boolean) => {
    set({ sentryOptIn: enabled });
    await setSentryOptIn(enabled);
  },

  loadSentryOptIn: async () => {
    const value = await getSentryOptIn();
    set({ sentryOptIn: value });
  },
}));
