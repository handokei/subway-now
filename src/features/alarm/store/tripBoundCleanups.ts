import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ROUTE_KEY,
  DESTINATION_KEY,
  CUSTOM_ORIGIN_KEY,
  BOARDING_LOCK_KEY,
  SCHEDULED_NOTIFICATIONS_KEY,
  ACTIVE_TRIP_KEY,
  TRIP_ORIGIN_KEY,
  ALARM_EVENT_KEY,
} from '../../../shared/constants/storageKeys';
import {
  clearFiredAlarms,
  clearLastNotifiedStationId,
  clearLastFiredAlarmStationName,
} from '../utils/notificationState';
import { clearFiredPushIds } from '../utils/firedPushIds';
import { clearTripTrainCode } from '../../route/utils/tripTrainCode';
import { clearDismissSilence as clearDismissSilenceStorage } from '../utils/dismissSilenceStorage';

// trip-bound storage cleanup 단일 출처.
// useAppStore.setDestination이 isSwitch(목적지 변경 또는 null 클리어) 분기에서 호출한다.
//
// 새 trip-bound 키를 추가할 때 이 배열에 한 줄만 더하면 회귀 자동 차단.
// (#702 → #799 사이 LAST_FIRED_ALARM_STATION_NAME_KEY 등 setDestination cleanup에서
// 누락된 사례 재발 방지. 각 키의 trip-bound 정당성은 storageKeys.ts 주석 참고.)
//
// 호출자는 결과를 await할 필요 없이 fire-and-forget으로 실행한다 — runTripBoundCleanups가
// 모든 reject를 흡수하므로 한 항목이 실패해도 다음 항목 실행에 영향이 없다.
//
// 각 항목은 단일 storage 작업만 wrap한 thunk. helper 함수(`clearFiredAlarms` 등)는
// 이미 내부에서 reject를 swallow하지만, AsyncStorage.removeItem 직접 호출 항목은
// runTripBoundCleanups의 allSettled가 reject를 흡수한다.
export const TRIP_BOUND_CLEANUPS: ReadonlyArray<() => Promise<void>> = [
  clearFiredAlarms,
  () => AsyncStorage.removeItem(ROUTE_KEY),
  // #868 — silent push trip-ended 경로에서는 zustand store에 접근 불가하므로 storage를 직접 제거.
  // setDestination(null) 경로는 useAppStore가 이미 inline으로 removeItem을 수행하지만,
  // 멱등 호출이라 중복 해도 무해. 이 배열은 BG cleanup의 single source.
  () => AsyncStorage.removeItem(DESTINATION_KEY),
  () => AsyncStorage.removeItem(CUSTOM_ORIGIN_KEY),
  () => AsyncStorage.removeItem(BOARDING_LOCK_KEY),
  () => AsyncStorage.removeItem(SCHEDULED_NOTIFICATIONS_KEY),
  () => AsyncStorage.removeItem(ACTIVE_TRIP_KEY),
  () => AsyncStorage.removeItem(TRIP_ORIGIN_KEY),
  clearLastNotifiedStationId,
  clearLastFiredAlarmStationName,
  clearFiredPushIds,
  clearTripTrainCode,
  () => AsyncStorage.removeItem(ALARM_EVENT_KEY),
  // #746 — 새 trip 시작 시 이전 trip의 dismiss silence는 무효 → 즉시 클리어.
  clearDismissSilenceStorage,
];

/**
 * 모든 trip-bound cleanup을 병렬로 실행한다. 항목들 사이에 순서 의존성이 없어
 * Promise.allSettled로 동시에 띄우고 모든 reject를 흡수한다 (한 항목 실패가
 * 다른 항목 실행이나 호출자에게 전파되지 않도록).
 */
export function runTripBoundCleanups(): Promise<void> {
  return Promise.allSettled(TRIP_BOUND_CLEANUPS.map((cleanup) => cleanup())).then(noop);
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop(): void {}
