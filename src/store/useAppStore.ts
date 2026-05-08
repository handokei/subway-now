import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Station } from '../types/station';
import type { AlarmEvent } from '../utils/stationAlarm';
import { FAVORITES_KEY, SLEEP_MODE_KEY, DESTINATION_KEY, FIRED_ALARMS_KEY, ALARM_EVENT_KEY, CUSTOM_ORIGIN_KEY, THEME_MODE_KEY, ROUTE_PREFERENCE_KEY, ROUTE_KEY, ALLOW_SPEAKER_KEY } from '../constants/storageKeys';
import type { RoutePreference } from '../utils/stationRoute';

export type ThemeMode = 'auto' | 'light' | 'dark';

export type { AlarmEvent };

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

interface AppState {
  favorites: Station[];
  destination: Station | null;
  recentDestination: Station | null;
  sleepMode: boolean;
  allowSpeaker: boolean;
  customOrigin: Station | null;
  themeMode: ThemeMode;
  routePreference: RoutePreference;
  alarmEvent: AlarmEvent | null;
  addFavorite: (station: Station) => Promise<void>;
  removeFavorite: (stationId: string) => Promise<void>;
  loadFavorites: () => Promise<void>;
  setDestination: (station: Station | null) => void;
  setRecentDestination: (station: Station | null) => void;
  setCustomOrigin: (station: Station | null) => void;
  loadCustomOrigin: () => Promise<void>;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  loadThemeMode: () => Promise<void>;
  setRoutePreference: (pref: RoutePreference) => Promise<void>;
  loadRoutePreference: () => Promise<void>;
  setSleepMode: (enabled: boolean) => Promise<void>;
  loadSleepMode: () => Promise<void>;
  setAllowSpeaker: (enabled: boolean) => Promise<void>;
  loadAllowSpeaker: () => Promise<void>;
  setAlarmEvent: (event: AlarmEvent) => void;
  clearAlarmEvent: () => void;
  loadAlarmEvent: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  favorites: [],
  destination: null,
  recentDestination: null,
  sleepMode: false,
  allowSpeaker: true,
  customOrigin: null,
  themeMode: 'auto' as ThemeMode,
  routePreference: 'optimal' as RoutePreference,
  alarmEvent: null,

  loadFavorites: async () => {
    try {
      const raw = await AsyncStorage.getItem(FAVORITES_KEY);
      if (raw) {
        set({ favorites: JSON.parse(raw) });
      }
    } catch {
      // 저장된 데이터 없음 — 빈 배열 유지
    }
  },

  addFavorite: async (station: Station) => {
    const current = get().favorites;
    if (current.some((s) => s.id === station.id)) return;
    const updated = [...current, station];
    set({ favorites: updated });
    await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(updated));
  },

  removeFavorite: async (stationId: string) => {
    const updated = get().favorites.filter((s) => s.id !== stationId);
    set({ favorites: updated });
    await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(updated));
  },

  setDestination: (station: Station | null) => {
    set({ destination: station });
    if (station) {
      AsyncStorage.setItem(DESTINATION_KEY, JSON.stringify(station)).catch(noop);
    } else {
      AsyncStorage.removeItem(DESTINATION_KEY).catch(noop);
      AsyncStorage.removeItem(FIRED_ALARMS_KEY).catch(noop);
      AsyncStorage.removeItem(ROUTE_KEY).catch(noop);
    }
  },

  setRecentDestination: (station: Station | null) => {
    set({ recentDestination: station });
  },

  setCustomOrigin: (station: Station | null) => {
    set({ customOrigin: station });
    if (station) {
      AsyncStorage.setItem(CUSTOM_ORIGIN_KEY, JSON.stringify(station)).catch(noop);
    } else {
      AsyncStorage.removeItem(CUSTOM_ORIGIN_KEY).catch(noop);
    }
  },

  loadCustomOrigin: async () => {
    try {
      const raw = await AsyncStorage.getItem(CUSTOM_ORIGIN_KEY);
      if (raw) {
        set({ customOrigin: JSON.parse(raw) });
      }
    } catch {
      // 저장된 데이터 없음 — null 유지
    }
  },

  setThemeMode: async (mode: ThemeMode) => {
    set({ themeMode: mode });
    await AsyncStorage.setItem(THEME_MODE_KEY, JSON.stringify(mode));
  },

  loadThemeMode: async () => {
    try {
      const raw = await AsyncStorage.getItem(THEME_MODE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed === 'auto' || parsed === 'light' || parsed === 'dark') {
          set({ themeMode: parsed });
        }
      }
    } catch {
      // 저장된 데이터 없음 — 'auto' 유지
    }
  },

  setRoutePreference: async (pref: RoutePreference) => {
    set({ routePreference: pref });
    await AsyncStorage.setItem(ROUTE_PREFERENCE_KEY, JSON.stringify(pref));
  },

  loadRoutePreference: async () => {
    try {
      const raw = await AsyncStorage.getItem(ROUTE_PREFERENCE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed === 'optimal' || parsed === 'minTransfer') {
          set({ routePreference: parsed });
        }
      }
    } catch {
      // 저장된 데이터 없음 — 'optimal' 유지
    }
  },

  setSleepMode: async (enabled: boolean) => {
    set({ sleepMode: enabled });
    await AsyncStorage.setItem(SLEEP_MODE_KEY, JSON.stringify(enabled));
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

  setAlarmEvent: (event: AlarmEvent) => {
    set({ alarmEvent: event });
  },

  clearAlarmEvent: () => {
    set({ alarmEvent: null });
    AsyncStorage.removeItem(ALARM_EVENT_KEY).catch(noop);
  },

  loadAlarmEvent: async () => {
    try {
      const raw = await AsyncStorage.getItem(ALARM_EVENT_KEY);
      if (raw) {
        set({ alarmEvent: JSON.parse(raw) });
        await AsyncStorage.removeItem(ALARM_EVENT_KEY);
      }
    } catch {
      // 저장된 데이터 없음 — 무시
    }
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
}));
