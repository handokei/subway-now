/* eslint-disable import/no-restricted-paths --
 * #2210 — Cross-feature orchestration: setAlarmEvent가 sleepMode(settings)와 trip-active
 * (route destination) 상태를 함께 게이트해야 한다. 비취침 + trip 종료 상태의 stale 알람
 * (BG write → FG loadAlarmEvent replay, inApp notification writer)를 단일 진입점에서 억제.
 * useDestinationStore가 이미 이 슬라이스를 역참조(alarm 클리어)하는 것과 대칭되는 orchestration.
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
import { useDestinationStore } from '../../route/store/useDestinationStore';

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

  // #2210 — sleepMode + trip-active 중앙 게이트. BG write(backgroundLocationTask) → FG
  // loadAlarmEvent replay와 inApp writer(notificationRouter) 두 경로 모두 이 함수를 거치므로
  // 여기서 억제하면 두 경로 모두 상속받는다. 비취침(sleepMode=false) + trip 종료(destination=null)
  // 상태의 stale 알람만 억제 — 취침 알람과 활성 trip 중 알람은 그대로 통과시킨다.
  setAlarmEvent: (event: AlarmEvent) => {
    const { sleepMode } = useSettingsStore.getState();
    const tripActive = useDestinationStore.getState().destination !== null;
    if (!sleepMode && !tripActive) {
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
