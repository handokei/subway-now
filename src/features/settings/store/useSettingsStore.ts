import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  SLEEP_MODE_KEY,
  ALLOW_SPEAKER_KEY,
  ACCESSIBILITY_MODE_KEY,
  LOCKLESS_STATION_PASSED_KEY,
} from '../../../shared/constants/storageKeys';

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
}

export const useSettingsStore = create<SettingsState>((set) => ({
  sleepMode: false,
  allowSpeaker: true,
  accessibilityMode: false,
  // #915 — destination-only baseline UX. 매역 알림이 zero-config로 동작하도록 default ON.
  locklessStationPassed: true,

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
    set({ locklessStationPassed: enabled });
    await AsyncStorage.setItem(LOCKLESS_STATION_PASSED_KEY, JSON.stringify(enabled));
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
}));
