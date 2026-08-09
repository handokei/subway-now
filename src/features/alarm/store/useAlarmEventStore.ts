/* eslint-disable import/no-restricted-paths --
 * #2210 / #2258 — Cross-feature orchestration: setAlarmEvent가 sleepMode(settings) 상태를
 * 게이트해야 한다. 알람 비주얼(AlarmOverlay)은 취침모드 전용 — BG write → FG loadAlarmEvent
 * replay, inApp notification writer 두 경로 모두 단일 진입점에서 억제.
 */
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
import { useSettingsStore } from '../../settings/store/useSettingsStore';

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

  // #2210 / #2258 — sleepMode 중앙 게이트. BG write(backgroundLocationTask) → FG
  // loadAlarmEvent replay와 inApp writer(notificationRouter) 두 경로 모두 이 함수를 거치므로
  // 여기서 억제하면 두 경로 모두 상속받는다. 알람 비주얼(AlarmOverlay)은 취침모드 전용 —
  // 활성 trip 여부와 무관하게 비취침(sleepMode=false)이면 항상 억제한다. 알람 소리/TTS/companion
  // (alarmLocalAuthority.ts)은 이미 별도로 취침 전용이며, 상시 route 표시는 이 게이트와 무관.
  setAlarmEvent: (event: AlarmEvent) => {
    const { sleepMode } = useSettingsStore.getState();
    if (!sleepMode) {
      return;
    }
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
        // #2210 — set() 직접 호출 대신 setAlarmEvent를 경유해 중앙 게이트를 상속받는다.
        // storage drain(removeItem)은 게이트 결과와 무관하게 항상 수행 — 억제된 stale 항목이
        // 다음 FG 진입에서 재차 replay되지 않도록 무조건 비운다.
        get().setAlarmEvent(JSON.parse(raw));
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
