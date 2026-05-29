import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Station, FavoriteEntry, FavoriteRole, FavoriteSlotRole, isFavoriteSlotRole } from '../types/station';

// 슬롯(home/work) 단일성 invariant — 새 entry가 해당 슬롯을 차지하기 전에 기존 entry는 general로 강등한다.
function demoteSlotEntries(entries: FavoriteEntry[], role: FavoriteSlotRole): FavoriteEntry[] {
  return entries.map((f) => (f.role === role ? { ...f, role: 'general' as FavoriteRole } : f));
}
import type { AlarmEvent } from '../utils/stationAlarm';
import { FAVORITES_KEY, SLEEP_MODE_KEY, DESTINATION_KEY, ALARM_EVENT_KEY, CUSTOM_ORIGIN_KEY, THEME_MODE_KEY, ROUTE_PREFERENCE_KEY, ROUTE_KEY, ALLOW_SPEAKER_KEY, LOCALE_PREFERENCE_KEY, ACCESSIBILITY_MODE_KEY } from '../constants/storageKeys';
import { clearFiredAlarms } from '../utils/notificationState';
import { ROUTE_CATEGORIES, type RoutePreference } from '../utils/stationRoute';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n/types';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type LocalePreference = 'auto' | SupportedLanguage;

const LOCALE_PREFERENCES: readonly LocalePreference[] = ['auto', ...SUPPORTED_LANGUAGES];

export type { AlarmEvent };

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

interface AppState {
  favorites: FavoriteEntry[];
  destination: Station | null;
  recentDestination: Station | null;
  sleepMode: boolean;
  allowSpeaker: boolean;
  customOrigin: Station | null;
  themeMode: ThemeMode;
  routePreference: RoutePreference;
  localePreference: LocalePreference;
  alarmEvent: AlarmEvent | null;
  debugVisible: boolean;
  setDebugVisible: (visible: boolean) => void;
  addFavorite: (station: Station, options?: { role?: FavoriteRole; label?: string }) => Promise<void>;
  removeFavorite: (stationId: string) => Promise<void>;
  setFavoriteLabel: (stationId: string, label?: string) => Promise<void>;
  setSlotFavorite: (role: FavoriteSlotRole, station: Station | null) => Promise<void>;
  loadFavorites: () => Promise<void>;
  setDestination: (station: Station | null) => void;
  loadDestination: () => Promise<void>;
  setRecentDestination: (station: Station | null) => void;
  setCustomOrigin: (station: Station | null) => void;
  loadCustomOrigin: () => Promise<void>;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  loadThemeMode: () => Promise<void>;
  setRoutePreference: (pref: RoutePreference) => Promise<void>;
  loadRoutePreference: () => Promise<void>;
  setLocalePreference: (pref: LocalePreference) => Promise<void>;
  loadLocalePreference: () => Promise<void>;
  setSleepMode: (enabled: boolean) => Promise<void>;
  loadSleepMode: () => Promise<void>;
  setAllowSpeaker: (enabled: boolean) => Promise<void>;
  loadAllowSpeaker: () => Promise<void>;
  accessibilityMode: boolean;
  setAccessibilityMode: (enabled: boolean) => Promise<void>;
  loadAccessibilityMode: () => Promise<void>;
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
  localePreference: 'auto' as LocalePreference,
  alarmEvent: null,
  debugVisible: false,
  accessibilityMode: false,

  setDebugVisible: (visible: boolean) => {
    set({ debugVisible: visible });
  },

  loadFavorites: async () => {
    try {
      const raw = await AsyncStorage.getItem(FAVORITES_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // 마이그레이션: Station[] / role 없는 FavoriteEntry[] 모두 허용.
          const migrated: FavoriteEntry[] = parsed
            .map((item): FavoriteEntry | null => {
              if (!item || typeof item !== 'object') return null;
              if ('station' in item) {
                const { station, label, role } = item as FavoriteEntry;
                if (!station || typeof station.id !== 'string') return null;
                const normalizedRole: FavoriteRole =
                  role === 'home' || role === 'work' ? role : 'general';
                return label != null
                  ? { station, role: normalizedRole, label }
                  : { station, role: normalizedRole };
              }
              if ('id' in item && typeof (item as Station).id === 'string') {
                return { station: item as Station, role: 'general' };
              }
              return null;
            })
            .filter((entry): entry is FavoriteEntry => entry !== null);
          // home/work 중복 발생 시 첫 항목만 유지하고 나머지는 general로 강등.
          const seenRoles = new Set<FavoriteSlotRole>();
          const deduped = migrated.map<FavoriteEntry>((entry) => {
            if (entry.role === 'home' || entry.role === 'work') {
              if (seenRoles.has(entry.role)) return { ...entry, role: 'general' };
              seenRoles.add(entry.role);
            }
            return entry;
          });
          set({ favorites: deduped });
        }
      }
    } catch {
      // 저장된 데이터 없음 — 빈 배열 유지
    }
  },

  addFavorite: async (station: Station, options) => {
    const current = get().favorites;
    if (current.some((f) => f.station.id === station.id)) return;
    const role: FavoriteRole = options?.role ?? 'general';
    const label = options?.label;
    const adjusted = isFavoriteSlotRole(role) ? demoteSlotEntries(current, role) : current;
    const entry: FavoriteEntry =
      label != null && label !== '' ? { station, role, label } : { station, role };
    const updated = [...adjusted, entry];
    set({ favorites: updated });
    await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(updated));
  },

  removeFavorite: async (stationId: string) => {
    const updated = get().favorites.filter((f) => f.station.id !== stationId);
    set({ favorites: updated });
    await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(updated));
  },

  setFavoriteLabel: async (stationId: string, label?: string) => {
    const trimmed = label?.trim();
    const updated = get().favorites.map((f) => {
      if (f.station.id !== stationId) return f;
      if (trimmed) return { ...f, label: trimmed };
      // label만 제거하고 station/role 등 다른 필드는 그대로 보존.
      const { label: _removed, ...rest } = f;
      return rest;
    });
    set({ favorites: updated });
    await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(updated));
  },

  // 집/회사 슬롯 지정 — 한 슬롯엔 하나의 역만. null이면 슬롯 비움(해당 entry는 general로 강등).
  setSlotFavorite: async (role: FavoriteSlotRole, station: Station | null) => {
    const current = get().favorites;
    const demoted = demoteSlotEntries(current, role);
    if (station == null) {
      set({ favorites: demoted });
      await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(demoted));
      return;
    }
    const existingIdx = demoted.findIndex((f) => f.station.id === station.id);
    const updated: FavoriteEntry[] = (() => {
      if (existingIdx >= 0) {
        const next = [...demoted];
        next[existingIdx] = { ...next[existingIdx], role };
        return next;
      }
      return [...demoted, { station, role }];
    })();
    set({ favorites: updated });
    await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(updated));
  },

  setDestination: (station: Station | null) => {
    set({ destination: station });
    if (station) {
      AsyncStorage.setItem(DESTINATION_KEY, JSON.stringify(station)).catch(noop);
    } else {
      AsyncStorage.removeItem(DESTINATION_KEY).catch(noop);
      clearFiredAlarms().catch(noop);
      AsyncStorage.removeItem(ROUTE_KEY).catch(noop);
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
        if (ROUTE_CATEGORIES.some((c) => c.key === parsed)) {
          set({ routePreference: parsed });
        }
      }
    } catch {
      // 저장된 데이터 없음 — 'optimal' 유지
    }
  },

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
