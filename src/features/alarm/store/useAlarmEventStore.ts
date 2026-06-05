import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AlarmEvent } from '../../../shared/types/alarm';
import { ALARM_EVENT_KEY } from '../../../shared/constants/storageKeys';
import {
  clearDismissSilence as clearDismissSilenceStorage,
  setDismissSilence as setDismissSilenceStorage,
  getDismissSilence as getDismissSilenceStorage,
  type DismissSilenceState,
} from '../utils/dismissSilenceStorage';

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (): void => {};

/**
 * 알람 이벤트 store — ADR 후속 Step 6 (#892).
 *
 * 두 가지 알람 도메인 in-memory mirror:
 *  - alarmEvent: BG 알람 → AlarmOverlay UI 트리거 (ALARM_EVENT_KEY 영속).
 *  - dismissSilence: 사용자가 알람을 dismiss한 시점 + 위치 (DISMISS_SILENCE_KEY SSOT).
 *    5분 또는 200m 이내까지 모든 알람 차단. BG path는 storage helper로 직접 read.
 *
 * 원본: `src/store/useAppStore.ts` alarmEvent + dismissSilence slice (god object 분해).
 */
export interface AlarmEventState {
  alarmEvent: AlarmEvent | null;
  setAlarmEvent: (event: AlarmEvent) => void;
  clearAlarmEvent: () => void;
  loadAlarmEvent: () => Promise<void>;

  /**
   * #746 — 사용자가 알람을 dismiss한 시점 기록. 5분 또는 200m 이내까지 모든 카테고리
   * 알람을 차단한다. AsyncStorage SSOT(DISMISS_SILENCE_KEY)와 in-memory mirror 동기 유지.
   * BG path는 storage helper(getDismissSilence)를 직접 read.
   */
  dismissSilence: DismissSilenceState | null;
  setDismissSilence: (
    now: number,
    position: { lat: number; lng: number } | null,
  ) => Promise<void>;
  clearDismissSilence: () => Promise<void>;
  loadDismissSilence: () => Promise<void>;
}

export const useAlarmEventStore = create<AlarmEventState>((set, get) => ({
  alarmEvent: null,
  dismissSilence: null,

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
