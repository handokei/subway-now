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
  RECENT_DESTINATIONS_KEY,
} from '../../../shared/constants/storageKeys';
import { RECENT_ROUTES_LIMIT } from '../../../shared/constants/recentDestinations';
import { runTripBoundCleanups } from '../../alarm/store/tripBoundCleanups';
import { setTripStartedAt } from '../../alarm/utils/tripStartStorage';
import { triggerTripEndRecall } from '../../alarm/utils/triggerTripEndRecall';
import { useAlarmEventStore } from '../../alarm/store/useAlarmEventStore';
import { ROUTE_CATEGORIES, type RoutePreference } from '../../../shared/utils/stationRoute';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';
import { captureCallerStack } from '../../../shared/utils/captureCallerStack';
import { isDegenerateDestination } from '../utils/isDegenerateDestination';

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (): void => {};

/**
 * #1321 — trip transition(목적지 switch/null) cleanup 직렬화 큐.
 *
 * setDestination은 동기 액션이라 cleanup chain(triggerTripEndRecall → runTripBoundCleanups →
 * setTripStartedAt)을 fire-and-forget으로 띄운다. 사용자가 trip을 삭제(setDestination(null))한 직후
 * 곧바로 재생성(setDestination(newStation))하면 두 chain이 interleave한다:
 *   - delete chain의 runTripBoundCleanups(옛 `tba:`/`bl:` 사전 예약 cancel)가 아직 in-flight인 동안
 *   - recreate chain이 setTripStartedAt을 기록 → hook들이 새 route를 preschedule
 * → 옛 알람이 잔존하거나 새/옛 cancel 순서가 비결정적 → 매 cron마다 revalidate-route-sig-mismatch 폭주.
 *
 * 연속 transition을 이 promise에 chain해 직렬화한다. recreate의 cleanup + setTripStartedAt은
 * 직전 delete의 cleanup이 완전히 settle한 뒤에야 시작되므로, hook이 새 trip을 preschedule할 시점에는
 * 옛 알람이 이미 정리돼 있고 이후 어떤 cleanup도 새 알람을 쓸어가지 않는다.
 */
let tripTransitionQueue: Promise<unknown> = Promise.resolve();

/**
 * Destination/route 상태 store — ADR 후속 Step 6 (#892).
 *
 * 책임:
 *  - destination / recentDestinations: 사용자 목적지 (영속 + 메모리). recentDestinations는
 *    LRU 리스트(#1032) — 최대 RECENT_ROUTES_LIMIT개.
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
  /**
   * #1032 — 최근 선택한 목적지 리스트. 가장 최근 우선(index 0).
   * 동일 station id는 dedup되며 최신 선택이 맨 앞으로 이동.
   * 최대 RECENT_ROUTES_LIMIT개까지 보관. AsyncStorage(RECENT_DESTINATIONS_KEY)로 영속.
   */
  recentDestinations: Station[];
  customOrigin: Station | null;
  // #700 — useTripOrigin이 destination set 시점에 캡처한 origin. cold restart 시
  // 첫 GPS fix가 진짜 출발역과 다른 회귀를 막기 위해 영속화한다 (TRIP_ORIGIN_KEY).
  tripOrigin: Station | null;
  routePreference: RoutePreference;

  setDestination: (station: Station | null) => void;
  loadDestination: () => Promise<void>;
  addRecentDestination: (station: Station) => void;
  removeRecentDestination: (stationId: string) => void;
  loadRecentDestinations: () => Promise<void>;
  setCustomOrigin: (station: Station | null) => void;
  loadCustomOrigin: () => Promise<void>;
  setTripOrigin: (station: Station | null) => void;
  loadTripOrigin: () => Promise<void>;
  setRoutePreference: (pref: RoutePreference) => Promise<void>;
  loadRoutePreference: () => Promise<void>;
}

export const useDestinationStore = create<DestinationState>((set, get) => ({
  destination: null,
  recentDestinations: [],
  customOrigin: null,
  tripOrigin: null,
  routePreference: 'optimal' as RoutePreference,

  setDestination: (station: Station | null) => {
    // #1348 — caller stack 캡처. setDestination은 사용자 action 빈도(hot path 아님)라
    // Error 생성 비용이 무시 가능. 직접 탭 / hook 자동 호출 / silent push reconcile 등
    // 진입 경로를 사후 재구성하기 위함(예: 14:36:46 미식별 호출 evidence).
    const caller = captureCallerStack();
    // #1324 — 목적지 == 출발역이면 degenerate trip(0-waypoint → 방향 null → 빈 탑승목록)이
    // 생성된다. UX 경계(DestinationPicker.onSelect)에서 effectiveOrigin(=customOrigin ∪ GPS)을
    // 기준으로 우선 차단하지만, store가 권위적으로 아는 customOrigin과 같은 역을 목적지로
    // 지정하는 모든 경로(최근 목적지 탭/맵 탭/프로그램적 호출)에 대한 방어선으로 여기서도 거부한다.
    if (station && isDegenerateDestination(get().customOrigin, station)) {
      addDomainBreadcrumb('trip', 'degenerate-destination-blocked', {
        station: station.name,
        caller,
      });
      return;
    }
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
      // 도메인 이벤트 breadcrumb — trip start(새 destination 지정) / end(null로 해제).
      // 같은 destination 재설정은 isSwitch=false로 여기 진입하지 않으므로 noise 방지됨.
      // #1348 — caller stack을 첨부해 evidence 수집(미식별 호출 추적용).
      if (station) {
        addDomainBreadcrumb('trip', 'start', { destination: station.name, caller });
      } else {
        addDomainBreadcrumb('trip', 'end', { reason: 'user-clear', caller });
      }
      // #919 + cleanup + 새 trip 기록을 순서대로 chain. 각 단계는 자체 catch를 가져
      // 한 단계 실패가 다음 단계를 막지 않도록 한다 — 측정 인프라가 cleanup의 critical
      // path를 차단하면 안 된다.
      // 1) recall trigger: ROUTE_KEY/DESTINATION_KEY/TRIP_STARTED_AT_KEY를 cleanup 전에 읽어야 함
      // 2) trip-bound storage 키 cleanup
      //    새 trip-bound 키 추가 시 src/features/alarm/store/tripBoundCleanups.ts에 한 줄만
      //    추가하면 setDestination에서 누락 회귀가 차단된다. (#702 → #799 사이
      //    LAST_FIRED_ALARM_STATION_NAME_KEY, #746 dismissSilence 등 누락 사례 재발 방지.)
      // 3) 새 trip(station != null)이면 새 tripStart를 기록 — cleanup이 직전에 이전 키를 제거했으니
      //    여기서 set하면 다음 trip 측정 가능. station === null(trip 종료) 경로에서는 set 안 함.
      // #1321 — delete→recreate race 차단: tripTransitionQueue에 chain해 직렬화한다.
      // 직전 transition(예: delete)의 cleanup이 완전히 끝난 뒤에야 이번 transition(예: recreate)의
      // cleanup + setTripStartedAt이 시작된다.
      tripTransitionQueue = tripTransitionQueue
        .then(() => triggerTripEndRecall())
        .catch(noop)
        .then(() => runTripBoundCleanups())
        .catch(noop)
        .then(() => (station ? setTripStartedAt() : undefined))
        .catch(noop);
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

  // #1032 — 가장 최근 목적지를 리스트 맨 앞에 추가. 같은 id가 이미 있으면 제거 후 prepend(dedup).
  // 결과 길이는 RECENT_ROUTES_LIMIT으로 자른다.
  addRecentDestination: (station: Station) => {
    const prev = get().recentDestinations;
    const deduped = prev.filter((s) => s.id !== station.id);
    const next = [station, ...deduped].slice(0, RECENT_ROUTES_LIMIT);
    set({ recentDestinations: next });
    AsyncStorage.setItem(RECENT_DESTINATIONS_KEY, JSON.stringify(next)).catch(noop);
  },

  removeRecentDestination: (stationId: string) => {
    const next = get().recentDestinations.filter((s) => s.id !== stationId);
    set({ recentDestinations: next });
    if (next.length === 0) {
      AsyncStorage.removeItem(RECENT_DESTINATIONS_KEY).catch(noop);
    } else {
      AsyncStorage.setItem(RECENT_DESTINATIONS_KEY, JSON.stringify(next)).catch(noop);
    }
  },

  loadRecentDestinations: async () => {
    try {
      const raw = await AsyncStorage.getItem(RECENT_DESTINATIONS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          set({ recentDestinations: parsed.slice(0, RECENT_ROUTES_LIMIT) });
        }
      }
    } catch {
      // 저장된 데이터 없음 — 빈 배열 유지
    }
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
