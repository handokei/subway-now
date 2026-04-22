import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Station } from '../types/station';

const FAVORITES_KEY = 'subway-now:favorites';
const SLEEP_MODE_KEY = 'subway-now:sleep-mode';
const DESTINATION_KEY = 'subway-now:destination';
const FIRED_ALARMS_KEY = 'subway-now:fired-alarms';

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

export interface AlarmEvent {
  type: 'destination' | 'transfer';
  stationName: string;
}

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
