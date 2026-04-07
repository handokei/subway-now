import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Station } from '../types/station';

const STORAGE_KEY = 'subway-now:favorites';

interface AppState {
  favorites: Station[];
  addFavorite: (station: Station) => Promise<void>;
  removeFavorite: (stationId: string) => Promise<void>;
  isFavorite: (stationId: string) => boolean;
  loadFavorites: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  favorites: [],

  loadFavorites: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
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
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  },

  removeFavorite: async (stationId: string) => {
    const updated = get().favorites.filter((s) => s.id !== stationId);
    set({ favorites: updated });
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  },

  isFavorite: (stationId: string) => {
    return get().favorites.some((s) => s.id === stationId);
  },
}));
