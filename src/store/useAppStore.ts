import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Station } from '../types/station';
import type { AlarmEvent } from '../utils/stationAlarm';
import { FAVORITES_KEY, SLEEP_MODE_KEY, DESTINATION_KEY, FIRED_ALARMS_KEY, ALARM_EVENT_KEY } from '../constants/storageKeys';

export type { AlarmEvent };

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

interface AppState {
  favorites: Station[];
  destination: Station | null;
  recentDestination: Station | null;
  sleepMode: boolean;
  alarmEvent: AlarmEvent | null;
  addFavorite: (station: Station) => Promise<void>;
  removeFavorite: (stationId: string) => Promise<void>;
  loadFavorites: () => Promise<void>;
  setDestination: (station: Station | null) => void;
  setRecentDestination: (station: Station | null) => void;
  setSleepMode: (enabled: boolean) => Promise<void>;
  loadSleepMode: () => Promise<void>;
  setAlarmEvent: (event: AlarmEvent) => void;
  clearAlarmEvent: () => void;
  loadAlarmEvent: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  favorites: [],
  destination: null,
  recentDestination: null,
  sleepMode: false,
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
    }
  },

  setRecentDestination: (station: Station | null) => {
    set({ recentDestination: station });
  },

  setSleepMode: async (enabled: boolean) => {
    set({ sleepMode: enabled });
    await AsyncStorage.setItem(SLEEP_MODE_KEY, JSON.stringify(enabled));
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
