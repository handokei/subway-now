/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ROUTE_KEY,
  DESTINATION_KEY,
  CUSTOM_ORIGIN_KEY,
  BOARDING_LOCK_KEY,
  ACTIVE_TRIP_KEY,
  TRIP_ORIGIN_KEY,
  ALARM_EVENT_KEY,
  TRIP_STARTED_AT_KEY,
  LAST_UPLOADED_RECALL_TRIP_START_KEY,
} from '../../../shared/constants/storageKeys';
import {
  clearFiredAlarms,
  clearLastNotifiedStationId,
  clearLastFiredAlarmStationName,
} from '../utils/notificationState';
import { clearFiredPushIds } from '../utils/firedPushIds';
import { clearTripTrainCode } from '../../route/utils/tripTrainCode';
import { clearDismissSilence as clearDismissSilenceStorage } from '../utils/dismissSilenceStorage';
import { clearLaDismissSentinel } from '../utils/laDismissSentinel';
import { clearPrescheduledLedger } from '../utils/prescheduledMetrics';
import { purgeBoardingLockSchedulerQueue } from '../utils/boardingLockScheduler';
import { cancelTripBoundAlarms } from '../utils/tripBoundScheduler';

// trip-bound storage cleanup 단일 출처.
// useDestinationStore.setDestination이 isSwitch(목적지 변경 또는 null 클리어) 분기에서 호출한다.
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
  // setDestination(null) 경로는 useDestinationStore가 이미 inline으로 removeItem을 수행하지만,
  // 멱등 호출이라 중복 해도 무해. 이 배열은 BG cleanup의 single source.
  () => AsyncStorage.removeItem(DESTINATION_KEY),
  () => AsyncStorage.removeItem(CUSTOM_ORIGIN_KEY),
  () => AsyncStorage.removeItem(BOARDING_LOCK_KEY),
  // #773 — trip release 시점에 SCHEDULED_NOTIFICATIONS_KEY storage만 비우면 OS 사전 예약은
  // 그대로 큐에 남아 새 trip 시작 후 옛 알람이 burst로 발사된다 (#918 A3 일반화의 선행 조건).
  // purgeBoardingLockSchedulerQueue는 `bl:` prefix id를 모두 Notifications.cancelScheduledNotificationAsync
  // + dismiss 처리한 뒤 storage 큐를 clear한다 — OS 큐 한도(64) 도달과 정정 신호 없는 옛 알람
  // 발사 burst를 동시에 차단한다.
  purgeBoardingLockSchedulerQueue,
  // #918 A3 PR4 — `tba:` 채널의 OS 사전 예약도 cancel. 트립 종료 시점에 남아 있으면
  // 다음 trip 시작 후 옛 알람이 burst로 발사된다 (purgeBoardingLockSchedulerQueue가 `bl:`만
  // 제거하기 때문). cancelTripBoundAlarms는 graceful — 큐가 비어도 안전 통과.
  cancelTripBoundAlarms,
  () => AsyncStorage.removeItem(ACTIVE_TRIP_KEY),
  () => AsyncStorage.removeItem(TRIP_ORIGIN_KEY),
  clearLastNotifiedStationId,
  clearLastFiredAlarmStationName,
  clearFiredPushIds,
  clearTripTrainCode,
  () => AsyncStorage.removeItem(ALARM_EVENT_KEY),
  // #746 — 새 trip 시작 시 이전 trip의 dismiss silence는 무효 → 즉시 클리어.
  clearDismissSilenceStorage,
  // #926 — destination 재설정(switch/null) 시 LA dismiss sentinel도 해제 → 다음 silent push에서
  // LA 재상승 허용. TTL 30분은 보조 게이트, 사용자 명시 재설정이 더 강한 의도 신호이므로 즉시 reset.
  clearLaDismissSentinel,
  // #919 — trip 시작 시각만 제거. LAST_UPLOADED_RECALL_TRIP_START_KEY는 dedup 마커이므로
  // 새 trip이 시작될 때 (tripStart 값이 달라질 때) 자연 무효화된다. 여기서 같이 지우면
  // BG silent-push가 upload + 직후 FG setDestination(null)이 같은 tripStart로 재trigger되는
  // 경계(self review)에서 idempotency가 깨져 중복 upload 가능 → 보존이 안전.
  () => AsyncStorage.removeItem(TRIP_STARTED_AT_KEY),
  // #918 — A3 사전 예약 측정 ledger. 새 trip마다 클리어 — 직전 trip의 잔여 fire/scheduled가
  // 새 trip 분모에 섞이는 회귀 차단. LAST_UPLOADED_PRESCHEDULED_TRIP_START_KEY는 recall과
  // 같은 이유로 보존 (tripStart값으로 자연 무효화).
  clearPrescheduledLedger,
];

/**
 * 모든 trip-bound cleanup을 병렬로 실행한다. 항목들 사이에 순서 의존성이 없어
 * Promise.allSettled로 동시에 띄우고 모든 reject를 흡수한다 (한 항목 실패가
 * 다른 항목 실행이나 호출자에게 전파되지 않도록).
 */
export function runTripBoundCleanups(): Promise<void> {
  return Promise.allSettled(TRIP_BOUND_CLEANUPS.map((cleanup) => cleanup())).then(noop);
}

/**
 * #1370 L4 — OS scheduled notification queue만 즉시 cancel하는 정밀 helper.
 *
 * 종착역 도착 silent push 수신 시 ROUTE_KEY/DESTINATION_KEY 등 storage 정리에 앞서
 * OS 큐의 `bl:` / `tba:` 사전 예약 알람을 우선 제거해 burst fire race를 좁힌다.
 * runTripBoundCleanups 전체 흐름은 그대로 유지하며(triggerTripEndRecall은 ROUTE_KEY를
 * 읽어야 해 storage 정리는 그 뒤에 와야 함), 본 helper는 storage를 건드리지 않는다.
 *
 * 멱등 — runTripBoundCleanups가 후속에서 동일 OS API를 다시 호출해도 이미 비어 있어 안전.
 * 두 cancel은 독립적이라 allSettled로 묶어 한쪽 실패가 다른 쪽 실행을 막지 않도록 한다.
 */
export function cancelTripBoundOsQueue(): Promise<void> {
  return Promise.allSettled([
    purgeBoardingLockSchedulerQueue(),
    cancelTripBoundAlarms(),
  ]).then(noop);
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop(): void {}
