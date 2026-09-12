import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { THEME_MODE_KEY } from '../../constants/storageKeys';

/**
 * Theme mode store — ADR 후속 Step 6 (#892).
 *
 * cross-cutting cosmetic 설정이라 shared/theme 하위에 둔다. ThemeProvider가
 * useColorScheme()과 합쳐 effective light/dark를 결정한다.
 *
 * 원본: `src/store/useAppStore.ts` themeMode slice (god object 분해).
 */
export type ThemeMode = 'auto' | 'light' | 'dark';

export interface ThemeState {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  loadThemeMode: () => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set) => ({
  themeMode: 'auto' as ThemeMode,

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
}));
