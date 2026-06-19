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
  STICKY_STATION_KEY,
} from '../../../shared/constants/storageKeys';
import { clearWidgetStation } from '../../widget/api/widgetStorage';
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
import {
  getRegisteredBlRouteSig,
  purgeBoardingLockSchedulerQueue,
} from '../utils/boardingLockScheduler';
import {
  cancelTripBoundAlarms,
  getRegisteredTripRouteSig,
} from '../utils/tripBoundScheduler';
import { clearTripCorrId } from '../../observability/utils/tripCorrId';
import { clearCrossCategoryDedup } from '../utils/crossCategoryStationDedup';
import { clearAlarmLogWindows } from '../utils/alarmLog';
import { resetAlarmBackendDedup } from '../api/alarmBackend';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { useBoardingLockStore } from './useBoardingLockStore';
import { useAlarmEventStore } from './useAlarmEventStore';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('tripBoundCleanups');

/**
 * #1525 — defensive cancel retry interval (ms). trip 종료 직후 한 번 cancel 한 뒤
 * 이 시간 후 한 번 더 cancel을 시도해 ETA 도달 직전 race window를 좁힌다.
 *
 * 1분은 silent push 처리 → setDestination(null) → AsyncStorage settle → OS notification
 * scheduler 반영의 typical lag(수 초)보다 충분히 길고, 평균 hop time(2~3분) 보다 짧아
 * 다음 hop이 ETA에 도달하기 전에 두 번째 cancel이 들어간다.
 */
const DEFENSIVE_CANCEL_DELAY_MS = 60_000;

let defensiveTimer: ReturnType<typeof setTimeout> | null = null;

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
  // #1501 (ADR-015 §10 P5 / PR-A) — trip 종료 시 corrId 제거. 다음 trip은 새 corrId를
  // 받고 rawSignalBuffer entry가 어느 trip 소속인지 명확해진다.
  clearTripCorrId,
  // #1524 — trip 종료 시 sticky station persisted lock 제거. useStickyStation의 메모리 lock은
  // motion.tripActive flip 감지로 즉시 해제되지만, BG silent push trip-ended 경로에서는 hook이
  // 실행되지 않으므로 storage를 직접 제거해야 다음 FG 재마운트 hydrate가 stale lock을 부활
  // 시키지 않는다(예: 자동 하차 후 현재역=군자 고착 회귀).
  () => AsyncStorage.removeItem(STICKY_STATION_KEY),
  // #1524 — trip 종료 시 위젯 stale 차단. saveStationToWidget은 sticky 또는 live 후보를 기준으로
  // 저장하므로 trip 끝나도 위젯에는 trip 중 마지막 역이 남는다. clearWidgetStation으로 즉시
  // "감지 중" 상태로 전환해 다음 fresh fix가 들어올 때까지 정확하지 않은 현재역 노출을 막는다.
  clearWidgetStation,
  // #1545 (S12) — 모듈-level in-memory dedup 윈도우 클리어.
  // 같은 destination/같은 phase로 새 trip을 즉시 시작할 때 직전 trip의 fire 기록이
  // 새 trip 첫 fire를 silence하는 회귀 차단. BG silent push trip-ended 경로에서도
  // 동일하게 비워야 일관.
  clearCrossCategoryDedup,
  clearAlarmLogWindows,
  // #1545 (S12) — alarm-backend register dedup 캐시 클리어. clearActiveTrip이 token이 있을
  // 때만 호출되는 반면, BG silent push trip-ended 경로는 token 없이 cleanup만 진행 →
  // in-flight Promise/last hash가 다음 trip register에 stale로 재사용되는 회귀 차단.
  resetAlarmBackendDedup,
  // #1545 (S12) — in-memory zustand store mirror 클리어.
  // FG setDestination(null/switch) 경로는 useDestinationStore가 inline으로 customOrigin/
  // alarmEvent/dismissSilence 메모리를 동기화하지만, BG silent push trip-ended 경로는
  // runTripBoundCleanups만 호출되어 storage는 비워도 메모리는 stale로 남는다 (FG 복귀 시
  // useStateRehydration이 sentinel을 보고 destination/lock만 reset — alarmEvent 등은 누락).
  // 본 wiring으로 BG 경로에서도 메모리/storage가 동시에 일관 상태가 된다.
  clearTripBoundStoreMemory,
];

/**
 * #1545 (S12) — trip-bound zustand store의 in-memory mirror를 일괄 클리어.
 *
 * storage는 다른 항목에서 이미 removeItem 되므로 본 함수는 메모리 setState만 수행.
 * 멱등 — 이미 null인 state에 setState 호출은 graceful no-op.
 *
 * useDestinationStore.customOrigin / useBoardingLockStore.lock / useAlarmEventStore.alarmEvent /
 * useAlarmEventStore.dismissSilence를 한 번에 동기화한다. setState는 sync — Promise.resolve로
 * 반환해 TRIP_BOUND_CLEANUPS의 () => Promise<void> shape에 맞춘다.
 */
function clearTripBoundStoreMemory(): Promise<void> {
  const destState = useDestinationStore.getState();
  // customOrigin: setDestination 경로는 이미 null로 동기화하지만, BG silent push 경로는
  // 누락. 사용자가 직접 지정한 출발역이 새 trip에 leak되지 않도록 비운다.
  if (destState.customOrigin !== null) {
    useDestinationStore.setState({ customOrigin: null });
  }
  // boardingLock: storage(BOARDING_LOCK_KEY)는 이미 removeItem 됐지만 zustand snapshot이
  // 메모리에 lock을 갖고 있으면 FG UI가 stale lock UI를 일시 노출한다.
  if (useBoardingLockStore.getState().lock !== null) {
    useBoardingLockStore.setState({ lock: null });
  }
  // alarmEvent / dismissSilence: storage(ALARM_EVENT_KEY/dismissSilenceStorage)도 위에서
  // 이미 cleanup. 메모리만 추가 동기화 — 새 trip UI에 이전 alarm overlay/silence가 leak 차단.
  const alarmState = useAlarmEventStore.getState();
  if (alarmState.alarmEvent !== null) {
    useAlarmEventStore.setState({ alarmEvent: null });
  }
  if (alarmState.dismissSilence !== null) {
    useAlarmEventStore.setState({ dismissSilence: null });
  }
  return Promise.resolve();
}

/**
 * 모든 trip-bound cleanup을 병렬로 실행한다. 항목들 사이에 순서 의존성이 없어
 * Promise.allSettled로 동시에 띄우고 모든 reject를 흡수한다 (한 항목 실패가
 * 다른 항목 실행이나 호출자에게 전파되지 않도록).
 */
export function runTripBoundCleanups(): Promise<void> {
  // #1525 — FG setDestination(null) 경로의 zombie alarm backstop. 1차 cleanup이 in-flight인
  // 동안 expo-notifications 내부 race로 일부 사전 예약이 살아남는 사례를 1분 후 두번째
  // cancel pass로 정리. 새 trip이 시작되면 route sig 가드가 skip한다.
  scheduleDefensiveCancel();
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
  scheduleDefensiveCancel();
  return Promise.allSettled([
    purgeBoardingLockSchedulerQueue(),
    cancelTripBoundAlarms(),
  ]).then(noop);
}

/**
 * #1525 — trip 종료 직후 1분 뒤 한 번 더 `tba:`/`bl:` OS 사전 예약을 cancel한다.
 *
 * 1차 cancel 시점에 race로 schedule이 in-flight였거나, expo-notifications 내부 큐 반영
 * 지연으로 일부 identifier가 cancel을 빠져나가는 경우를 보강. 2026-06-19 trip 종료
 * 11분 후 "안내 종료" 알림이 사용자에게 도달한 사례(zombie alarm)의 backstop.
 *
 * 새 trip이 시작되어 routeSig가 다시 기록됐다면 정상 사전 예약을 지우면 안 되므로 skip.
 * 이미 예약된 defensive timer가 있으면 새 호출이 reset(이전 timer cancel → 새 timer).
 *
 * 별도 export 없이 cancelTripBoundOsQueue / runTripBoundCleanups 내부에서만 호출.
 */
function scheduleDefensiveCancel(): void {
  if (defensiveTimer !== null) {
    clearTimeout(defensiveTimer);
  }
  defensiveTimer = setTimeout(() => {
    defensiveTimer = null;
    void runDefensiveCancel();
  }, DEFENSIVE_CANCEL_DELAY_MS);
}

async function runDefensiveCancel(): Promise<void> {
  // 새 trip이 시작되어 route sig가 기록됐으면 사전 예약은 정상 — defensive cancel skip.
  // `tba:` / `bl:` 두 채널 중 하나라도 sig가 살아있으면 새 trip 진행 중으로 판단.
  // getRegisteredXxxRouteSig는 storage 실패를 내부에서 catch해 null 반환 — 본 함수의
  // try/catch 없이도 throw가 외부로 새지 않는다 (Promise.allSettled가 cancel 양쪽을 흡수).
  const [tbaSig, blSig] = await Promise.all([
    getRegisteredTripRouteSig(),
    getRegisteredBlRouteSig(),
  ]);
  if (tbaSig !== null || blSig !== null) {
    log.info(`defensive cancel skip: new trip active (tbaSig=${tbaSig !== null} blSig=${blSig !== null})`);
    return;
  }
  log.info('defensive cancel: running second cancel pass (#1525)');
  await Promise.allSettled([
    purgeBoardingLockSchedulerQueue(),
    cancelTripBoundAlarms(),
  ]);
}

/**
 * 테스트용 — pending defensive timer를 즉시 cancel + 모듈 상태 reset. production 호출자 없음.
 */
export function __resetDefensiveCancelForTest(): void {
  if (defensiveTimer !== null) {
    clearTimeout(defensiveTimer);
    defensiveTimer = null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop(): void {}
