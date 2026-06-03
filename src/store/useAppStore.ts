import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Station, FavoriteEntry, FavoriteRole, FavoriteSlotRole, isFavoriteSlotRole } from '../types/station';

// 슬롯(home/work) 단일성 invariant — 새 entry가 해당 슬롯을 차지하기 전에 기존 entry는 general로 강등한다.
function demoteSlotEntries(entries: FavoriteEntry[], role: FavoriteSlotRole): FavoriteEntry[] {
  return entries.map((f) => (f.role === role ? { ...f, role: 'general' as FavoriteRole } : f));
}
import type { AlarmEvent } from '../utils/stationAlarm';
import { FAVORITES_KEY, SLEEP_MODE_KEY, DESTINATION_KEY, ALARM_EVENT_KEY, CUSTOM_ORIGIN_KEY, THEME_MODE_KEY, ROUTE_PREFERENCE_KEY, ALLOW_SPEAKER_KEY, LOCALE_PREFERENCE_KEY, ACCESSIBILITY_MODE_KEY, TRIP_ORIGIN_KEY, LOCKLESS_STATION_PASSED_KEY } from '../constants/storageKeys';
import { runTripBoundCleanups } from './tripBoundCleanups';
import {
  clearDismissSilence as clearDismissSilenceStorage,
  setDismissSilence as setDismissSilenceStorage,
  getDismissSilence as getDismissSilenceStorage,
  type DismissSilenceState,
} from '../utils/dismissSilenceStorage';
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
  // #700 — useTripOrigin이 destination set 시점에 캡처한 origin. cold restart 시
  // 첫 GPS fix가 진짜 출발역과 다른 회귀를 막기 위해 영속화한다 (TRIP_ORIGIN_KEY).
  tripOrigin: Station | null;
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
  setTripOrigin: (station: Station | null) => void;
  loadTripOrigin: () => Promise<void>;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  loadThemeMode: () => Promise<void>;
  setRoutePreference: (pref: RoutePreference) => Promise<void>;
  loadRoutePreference: () => Promise<void>;
  setLocalePreference: (pref: LocalePreference) => Promise<void>;
  loadLocalePreference: () => Promise<void>;
  setSleepMode: (enabled: boolean) => Promise<void>;
  loadSleepMode: () => Promise<void>;
  /**
   * #816 C — BoardingLock 없는 trip에서도 station-passed(intermediate) 알림을 받을지 여부.
   * 기본 OFF. ON 시 useApnsTripRegistration이 backend trip register payload에 포함시키고,
   * backend가 lockless intermediate 발사를 허용한다.
   */
  locklessStationPassed: boolean;
  setLocklessStationPassed: (enabled: boolean) => Promise<void>;
  loadLocklessStationPassed: () => Promise<void>;
  setAllowSpeaker: (enabled: boolean) => Promise<void>;
  loadAllowSpeaker: () => Promise<void>;
  accessibilityMode: boolean;
  setAccessibilityMode: (enabled: boolean) => Promise<void>;
  loadAccessibilityMode: () => Promise<void>;
  setAlarmEvent: (event: AlarmEvent) => void;
  clearAlarmEvent: () => void;
  loadAlarmEvent: () => Promise<void>;
  /**
   * #746 — 사용자가 알람을 dismiss한 시점 기록. 5분 또는 200m 이내까지 모든 카테고리
   * 알람을 차단한다. AsyncStorage SSOT(DISMISS_SILENCE_KEY)와 in-memory mirror 동기 유지.
   * BG path는 storage helper(getDismissSilence)를 직접 read.
   */
  dismissSilence: DismissSilenceState | null;
  setDismissSilence: (now: number, position: { lat: number; lng: number } | null) => Promise<void>;
  clearDismissSilence: () => Promise<void>;
  loadDismissSilence: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  favorites: [],
  destination: null,
  recentDestination: null,
  sleepMode: false,
  allowSpeaker: true,
  customOrigin: null,
  tripOrigin: null,
  themeMode: 'auto' as ThemeMode,
  routePreference: 'optimal' as RoutePreference,
  localePreference: 'auto' as LocalePreference,
  alarmEvent: null,
  debugVisible: false,
  accessibilityMode: false,
  locklessStationPassed: false,
  dismissSilence: null,

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
    const prev = get().destination;
    const isSwitch = (prev?.id ?? null) !== (station?.id ?? null);
    set({ destination: station });
    if (station) {
      AsyncStorage.setItem(DESTINATION_KEY, JSON.stringify(station)).catch(noop);
    } else {
      // #700 — trip 종료 시 tripOrigin도 atomic하게 클리어. destination만 남기면
      // 다음 trip 시작 시 stale origin이 잠깐 노출돼 route 계산이 흔들린다.
      set({ tripOrigin: null });
      AsyncStorage.removeItem(DESTINATION_KEY).catch(noop);
    }
    // destination switch(목적지 자체가 바뀌었을 때) — 부수 상태/storage 자동 클리어.
    // 같은 destination 재설정 시에는 진행 중인 trip/lock/스케줄을 유지한다.
    // 주의: 여기서는 storage만 정리한다. BoardingLock 메모리 release 및 예약 알림 cancel은
    // useBoardingLockController가 destinationId 변경 감지로 처리한다 (store 분리 유지).
    if (isSwitch) {
      // trip-bound storage 키 cleanup은 단일 메타 배열에서 일괄 실행한다.
      // 새 trip-bound 키 추가 시 src/store/tripBoundCleanups.ts에 한 줄만 추가하면
      // setDestination에서 누락 회귀가 차단된다. (#702 → #799 사이 LAST_FIRED_ALARM_STATION_NAME_KEY,
      // #746 dismissSilence 등 누락 사례 재발 방지.)
      runTripBoundCleanups().catch(noop);
      // customOrigin 메모리 상태도 동기화. (loadCustomOrigin은 hydration용이므로 영향 없음)
      if (get().customOrigin !== null) {
        set({ customOrigin: null });
      }
      // alarmEvent 메모리 상태도 동기화 — clearAlarmEvent와 같은 set, 재진입 안전.
      if (get().alarmEvent !== null) {
        set({ alarmEvent: null });
      }
      // #746: dismissSilence 메모리 상태도 동기화 — storage clear와 같은 set, 재진입 안전.
      if (get().dismissSilence !== null) {
        set({ dismissSilence: null });
      }
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

  // #700 — useTripOrigin이 캡처/클리어한 trip origin을 영속화.
  // setDestination(null)은 자체적으로 tripOrigin도 클리어하므로 trip 종료 경로는
  // 단일 진입점이지만, destination이 살아있는 동안 origin만 갱신되는 경우
  // (캡처 / 재캡처 / lazy 캡처)는 이 액션이 단일 진입점.
  setTripOrigin: (station: Station | null) => {
    set({ tripOrigin: station });
    if (station) {
      AsyncStorage.setItem(TRIP_ORIGIN_KEY, JSON.stringify(station)).catch(noop);
    } else {
      AsyncStorage.removeItem(TRIP_ORIGIN_KEY).catch(noop);
    }
  },

  loadTripOrigin: async () => {
    try {
      const raw = await AsyncStorage.getItem(TRIP_ORIGIN_KEY);
      if (raw) {
        set({ tripOrigin: JSON.parse(raw) });
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

  // #746 — 사용자가 알람을 dismiss하면 silence 시작점을 기록. 좌표는 호출자가 마지막 알려진
  // 사용자 위치를 전달 — GPS 미가용 시 null을 넘기면 거리 조건은 미평가되고 시간 조건만 활성.
  // 메모리/storage 양쪽 동기 — BG 게이트가 storage helper로 직접 read해도 일관.
  setDismissSilence: async (now, position) => {
    const next: DismissSilenceState = {
      sinceTs: now,
      sinceLat: position?.lat ?? null,
      sinceLng: position?.lng ?? null,
    };
    set({ dismissSilence: next });
    await setDismissSilenceStorage(next);
  },

  clearDismissSilence: async () => {
    if (get().dismissSilence !== null) {
      set({ dismissSilence: null });
    }
    await clearDismissSilenceStorage();
  },

  loadDismissSilence: async () => {
    const stored = await getDismissSilenceStorage();
    set({ dismissSilence: stored });
  },

}));
