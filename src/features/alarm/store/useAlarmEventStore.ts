/* eslint-disable import/no-restricted-paths --
 * #2210 / #2258 — Cross-feature orchestration: setAlarmEvent가 sleepMode(settings) 상태를
 * 게이트해야 한다. 알람 비주얼(SleepAlarmOverlay)은 취침모드 전용 — BG write → FG loadAlarmEvent
 * replay, inApp notification writer 두 경로 모두 단일 진입점에서 억제.
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AlarmEvent } from '../../../shared/types/alarm';
import { ALARM_EVENT_KEY } from '../../../shared/constants/storageKeys';
import { ALARM_OVERLAY_REPLAY_WINDOW_MS } from '../../../shared/constants/alarmOverlayReplay';
import { isSleepModeStored, takePendingSleepAlarmOverlay } from '../utils/pendingSleepAlarmOverlay';
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
 *  - alarmEvent: BG 알람 → SleepAlarmOverlay UI 트리거 (ALARM_EVENT_KEY 영속).
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
   * #3377 — BG에서 울린 취침 알람 오버레이 재생(탭: 30분 창, FG 진입: 2분 창). 저장 이벤트를 창으로 거르고, 없으면
   * `fallback`(알림 data 재구성)을 쓴다. storage sleepMode(권위)가 true일 때만 표시. 표시했으면 true.
   */
  replayPendingAlarmOverlay: (options: {
    windowMs: number;
    now?: number;
    fallback?: () => Promise<AlarmEvent | null>;
  }) => Promise<boolean>;

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
  // loadAlarmEvent replay와 useStationAlarm의 직접 setAlarmEvent 호출 두 경로 모두 이 함수를
  // 거치므로 여기서 억제하면 두 경로 모두 상속받는다. 알람 비주얼(SleepAlarmOverlay)은 취침모드 전용 —
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
      // #3100 D1 — ALARM_EVENT_KEY는 drain-only(구버전·backgroundLocationTask가 남긴 firedAt 없는 잔여 키만 비운다).
      const raw = await AsyncStorage.getItem(ALARM_EVENT_KEY);
      if (raw) {
        await AsyncStorage.removeItem(ALARM_EVENT_KEY);
      }
      // #3377 — 단, BG에서 울린 취침 알람(새 키 PENDING_SLEEP_ALARM_OVERLAY_KEY)은 2분 이내 FG 진입이면 재생한다.
      await get().replayPendingAlarmOverlay({ windowMs: ALARM_OVERLAY_REPLAY_WINDOW_MS });
    } catch {
      // 저장된 데이터 없음 — 무시
    }
  },

  replayPendingAlarmOverlay: async ({ windowMs, now, fallback }) => {
    // 키는 sleepMode와 무관하게 항상 소비한다(일반 모드에서 잔존했다가 나중에 뜨는 것 방지).
    const stored = await takePendingSleepAlarmOverlay({ windowMs, now });
    if (!(await isSleepModeStored())) return false;
    const event = stored ?? (fallback ? await fallback() : null);
    if (!event) return false;
    // 콜드 스타트 race: 메모리 sleepMode는 hydrate 전 false라 setAlarmEvent 중앙 게이트가 막는다 — storage 값을 먼저 반영.
    await useSettingsStore.getState().loadSleepMode();
    get().setAlarmEvent(event);
    return true;
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
