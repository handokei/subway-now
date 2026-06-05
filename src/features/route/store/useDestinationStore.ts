/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: setDestination(switch) 시 alarm 슬라이스의 alarmEvent와
 * dismissSilence 메모리 mirror를 함께 클리어해야 한다 (이전 trip의 잔여 알람 상태가
 * 새 trip에 leak되는 회귀 방지). useBoardingLockController와 동일하게 file-level
 * disable로 옵트인 처리 — orchestration 본질이 cross-feature.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" 후속 Step 6 (#892).
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Station } from '../../../shared/types/station';
import {
  DESTINATION_KEY,
  CUSTOM_ORIGIN_KEY,
  TRIP_ORIGIN_KEY,
  ROUTE_PREFERENCE_KEY,
} from '../../../shared/constants/storageKeys';
import { runTripBoundCleanups } from '../../alarm/store/tripBoundCleanups';
import { useAlarmEventStore } from '../../alarm/store/useAlarmEventStore';
import { ROUTE_CATEGORIES, type RoutePreference } from '../../../shared/utils/stationRoute';

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (): void => {};

/**
 * Destination/route 상태 store — ADR 후속 Step 6 (#892).
 *
 * 책임:
 *  - destination / recentDestination: 사용자 목적지 (영속 + 메모리).
 *  - customOrigin: 사용자가 명시 지정한 출발역 (GPS와 별개).
 *  - tripOrigin (#700): trip 시작 시 캡처한 출발역. cold restart 후 첫 GPS fix가
 *    실제 출발역과 다른 회귀 방지용 영속화.
 *  - routePreference: 사용자가 선호하는 경로 정책 ('optimal' / 'minTransfer' 등).
 *
 * setDestination switch 시 trip-bound storage + cross-feature 메모리 mirror를 atomic하게
 * 정리한다. (BoardingLock release는 useBoardingLockController가 destinationId 변경 감지로 처리)
 *
 * 원본: `src/store/useAppStore.ts` destination + route slice (god object 분해).
 */
export interface DestinationState {
  destination: Station | null;
  recentDestination: Station | null;
  customOrigin: Station | null;
  // #700 — useTripOrigin이 destination set 시점에 캡처한 origin. cold restart 시
  // 첫 GPS fix가 진짜 출발역과 다른 회귀를 막기 위해 영속화한다 (TRIP_ORIGIN_KEY).
  tripOrigin: Station | null;
  routePreference: RoutePreference;

  setDestination: (station: Station | null) => void;
  loadDestination: () => Promise<void>;
  setRecentDestination: (station: Station | null) => void;
  setCustomOrigin: (station: Station | null) => void;
  loadCustomOrigin: () => Promise<void>;
  setTripOrigin: (station: Station | null) => void;
  loadTripOrigin: () => Promise<void>;
  setRoutePreference: (pref: RoutePreference) => Promise<void>;
  loadRoutePreference: () => Promise<void>;
}

export const useDestinationStore = create<DestinationState>((set, get) => ({
  destination: null,
  recentDestination: null,
  customOrigin: null,
  tripOrigin: null,
  routePreference: 'optimal' as RoutePreference,

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
      // 새 trip-bound 키 추가 시 src/features/alarm/store/tripBoundCleanups.ts에 한 줄만
      // 추가하면 setDestination에서 누락 회귀가 차단된다. (#702 → #799 사이
      // LAST_FIRED_ALARM_STATION_NAME_KEY, #746 dismissSilence 등 누락 사례 재발 방지.)
      runTripBoundCleanups().catch(noop);
      // customOrigin 메모리 상태도 동기화. (loadCustomOrigin은 hydration용이므로 영향 없음)
      if (get().customOrigin !== null) {
        set({ customOrigin: null });
      }
      // alarmEvent 메모리 상태 동기화 — 이전 trip 알람이 새 trip UI에 leak되지 않도록.
      // useAlarmEventStore의 clearAlarmEvent는 storage 제거도 수행하지만, 여기는
      // 이미 runTripBoundCleanups가 ALARM_EVENT_KEY를 제거했으므로 메모리만 null로.
      const alarmStore = useAlarmEventStore.getState();
      if (alarmStore.alarmEvent !== null) {
        useAlarmEventStore.setState({ alarmEvent: null });
      }
      // #746: dismissSilence 메모리 상태 동기화 — 이전 trip의 dismiss silence는 새 trip에
      // 무효 (storage clear는 tripBoundCleanups에서 처리).
      if (alarmStore.dismissSilence !== null) {
        useAlarmEventStore.setState({ dismissSilence: null });
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
}));
