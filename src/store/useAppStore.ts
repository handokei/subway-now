import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Station } from '../types/station';

const FAVORITES_KEY = 'subway-now:favorites';
const DESTINATION_KEY = 'subway-now:destination';

interface AppState {
  favorites: Station[];
  destination: Station | null;
  addFavorite: (station: Station) => Promise<void>;
  removeFavorite: (stationId: string) => Promise<void>;
  isFavorite: (stationId: string) => boolean;
  loadFavorites: () => Promise<void>;
  setDestination: (station: Station | null) => Promise<void>;
  loadDestination: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  favorites: [],
  destination: null,

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

  isFavorite: (stationId: string) => {
    return get().favorites.some((s) => s.id === stationId);
  },

  setDestination: async (station: Station | null) => {
    set({ destination: station });
    if (station) {
      await AsyncStorage.setItem(DESTINATION_KEY, JSON.stringify(station));
    } else {
      await AsyncStorage.removeItem(DESTINATION_KEY);
    }
  },

  loadDestination: async () => {
    try {
      const raw = await AsyncStorage.getItem(DESTINATION_KEY);
      if (raw) {
        set({ destination: JSON.parse(raw) });
      }
    } catch {
      // 저장된 데이터 없음 — null 유지
    }
  },
}));
