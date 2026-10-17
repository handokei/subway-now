import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LOCALE_PREFERENCE_KEY } from '../../constants/storageKeys';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../types';

/**
 * Locale preference store — ADR 후속 Step 6 (#892).
 *
 * cross-cutting 언어 설정이라 shared/i18n 하위에 둔다. useApplyLocale이 이 값을
 * 읽어 i18next changeLanguage를 호출한다.
 *
 * 원본: `src/store/useAppStore.ts` localePreference slice (god object 분해).
 */
export type LocalePreference = 'auto' | SupportedLanguage;

const LOCALE_PREFERENCES: readonly LocalePreference[] = ['auto', ...SUPPORTED_LANGUAGES];

export interface LocaleState {
  localePreference: LocalePreference;
  setLocalePreference: (pref: LocalePreference) => Promise<void>;
  loadLocalePreference: () => Promise<void>;
}

export const useLocaleStore = create<LocaleState>((set) => ({
  localePreference: 'auto' as LocalePreference,

  setLocalePreference: async (pref: LocalePreference) => {
    set({ localePreference: pref });
    await AsyncStorage.setItem(LOCALE_PREFERENCE_KEY, JSON.stringify(pref));
  },

  loadLocalePreference: async () => {
    try {
      const raw = await AsyncStorage.getItem(LOCALE_PREFERENCE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (LOCALE_PREFERENCES.includes(parsed)) {
          set({ localePreference: parsed });
        }
      }
    } catch {
      // 저장된 데이터 없음 — 'auto' 유지
    }
  },
}));
