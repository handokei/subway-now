import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Station,
  FavoriteEntry,
  FavoriteRole,
  FavoriteSlotRole,
  isFavoriteSlotRole,
} from '../../../shared/types/station';
import { FAVORITES_KEY } from '../../../shared/constants/storageKeys';

// 슬롯(home/work) 단일성 invariant — 새 entry가 해당 슬롯을 차지하기 전에 기존 entry는 general로 강등한다.
function demoteSlotEntries(entries: FavoriteEntry[], role: FavoriteSlotRole): FavoriteEntry[] {
  return entries.map((f) => (f.role === role ? { ...f, role: 'general' as FavoriteRole } : f));
}

/**
 * 즐겨찾기 store — ADR 후속 Step 6 (#892).
 *
 * 책임: favorites list + add/remove/setLabel/setSlot/load.
 * slot(home/work)은 슬롯당 1개 invariant 유지. AsyncStorage(FAVORITES_KEY) 영속화.
 *
 * 원본: `src/store/useAppStore.ts` favorites slice (god object 분해).
 */
export interface FavoritesState {
  favorites: FavoriteEntry[];
  addFavorite: (
    station: Station,
    options?: { role?: FavoriteRole; label?: string },
  ) => Promise<void>;
  removeFavorite: (stationId: string) => Promise<void>;
  setFavoriteLabel: (stationId: string, label?: string) => Promise<void>;
  setSlotFavorite: (role: FavoriteSlotRole, station: Station | null) => Promise<void>;
  loadFavorites: () => Promise<void>;
}

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  favorites: [],

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
}));
