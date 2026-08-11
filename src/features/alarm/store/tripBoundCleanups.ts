/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LiveActivity from 'live-activity';
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
import { clearLastSilentPushReceivedAt } from '../utils/lastSilentPushReceivedAt';
import { clearPrescheduledLedger } from '../utils/prescheduledMetrics';
import { cancelAllSafetyNetAlarms, resolveEffectiveTripToken } from '../utils/safetyNetScheduler';
import { cancelAllPrescheduledAlarms } from '../utils/stationPrescheduler';
import { getTripStartedAt } from '../utils/tripStartStorage';
import { clearNavigationPausedAt } from '../utils/navigationPauseStorage';
import { clearTripCorrId } from '../../observability/utils/tripCorrId';
import { clearBackendSsotMirror } from '../utils/backendSsotMirror';
import { clearCrossCategoryDedup } from '../utils/crossCategoryStationDedup';
import { clearAlarmLogWindows } from '../utils/alarmLog';
import { clearActiveTrip, resetAlarmBackendDedup } from '../api/alarmBackend';
import { getNotificationRouter } from '../api/notificationRouter';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { useNavigationStore } from '../../route/store/useNavigationStore';
import { useBoardingLockStore } from './useBoardingLockStore';
import { useLegAdvanceStore } from './useLegAdvanceStore';
import { useAlarmEventStore } from './useAlarmEventStore';
import { resetUserIntentInfoMode } from './useUserIntentStore';
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
  // #773/#918 A3 PR4 → #2089 — safety-net(구 bl:/tba: 3종 통합) OS 사전 예약 cancel은
  // ACTIVE_TRIP_KEY(tripToken)를 필요로 하므로 이 배열보다 먼저 읽어야 한다(아래에서
  // ACTIVE_TRIP_KEY를 제거하기 전에). `runTripBoundCleanups`/`cancelTripBoundOsQueue`가
  // 별도로 `cancelAllSafetyNetAlarms(tripToken)`을 선행 실행한다 — graceful, 큐가 비어도 안전.
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
  // #1573 (T10) — backend SSoT mirror 제거.
  // 누락 시 새 trip 등록 직후 cascade picker가 이전 trip의 mirror entry를 freshness 윈도우
  // 내에서 backend-ssot tier로 채택할 수 있다(Mirror leak #3). 4개 cleanup 경로
  // (FG setDestination(null/switch) / silent push trip-ended / useStateRehydration sentinel /
  // useLaunchTripReconciliation cold-launch) 모두 runTripBoundCleanups를 호출하므로 본 배열에
  // 한 줄 추가로 4 경로 자동 wire.
  clearBackendSsotMirror,
  // #1524 — trip 종료 시 sticky station persisted lock 제거. useStickyStation의 메모리 lock은
  // motion.tripActive flip 감지로 즉시 해제되지만, BG silent push trip-ended 경로에서는 hook이
  // 실행되지 않으므로 storage를 직접 제거해야 다음 FG 재마운트 hydrate가 stale lock을 부활
  // 시키지 않는다(예: 자동 하차 후 현재역=군자 고착 회귀).
  () => AsyncStorage.removeItem(STICKY_STATION_KEY),
  // #1524 — trip 종료 시 위젯 stale 차단. saveStationToWidget은 sticky 또는 live 후보를 기준으로
  // 저장하므로 trip 끝나도 위젯에는 trip 중 마지막 역이 남는다. clearWidgetStation으로 즉시
  // "감지 중" 상태로 전환해 다음 fresh fix가 들어올 때까지 정확하지 않은 현재역 노출을 막는다.
  clearWidgetStation,
  // #1892 / #1885 — trip 종료 시 Live Activity dismiss. RC-9 cascade (Seoul outage → trip
  // auto-end → LA orphan 26분) root cause. backend trip auto-end 시 silent push `trip-ended`
  // 분기에서 runTripBoundCleanups가 호출되지만 기존엔 storage만 정리되고 native Live Activity
  // 인스턴스는 dismiss되지 않아 사용자에게 "건대입구 → 용마산"이 26분 동안 stuck 노출됨.
  // 4 entry point (FG setDestination(null/switch) / silent push trip-ended /
  // useStateRehydration sentinel / useLaunchTripReconciliation)에서 LA dismiss가 자동 wire되며
  // 멱등 — LA 비활성 또는 이미 ended 상태도 graceful 통과.
  // refreshLiveActivityFromBackgroundContext는 destination 없으면 endLiveActivity를 호출하지만
  // trip-ended 분기 자체는 이를 호출하지 않으므로 cleanup 배열로 wire가 본질 fix.
  endLiveActivityCleanup,
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
  // #1575 (T12, ADR-017) — NotificationRouter dedup map + delivery log + widget surface 클리어.
  // 새 trip 시작 시 직전 trip의 (alarmId, surface) dedup 상태가 leak되어 새 alarmId의 첫 발사를
  // 차단하는 회귀 방지. router.clearAllForTrip은 graceful — 내부 surface.clearAll 실패도 swallow.
  () => getNotificationRouter().clearAllForTrip(),
  // #1545 (S12) — in-memory zustand store mirror 클리어.
  // FG setDestination(null/switch) 경로는 useDestinationStore가 inline으로 customOrigin/
  // alarmEvent/dismissSilence 메모리를 동기화하지만, BG silent push trip-ended 경로는
  // runTripBoundCleanups만 호출되어 storage는 비워도 메모리는 stale로 남는다 (FG 복귀 시
  // useStateRehydration이 sentinel을 보고 destination/lock만 reset — alarmEvent 등은 누락).
  // 본 wiring으로 BG 경로에서도 메모리/storage가 동시에 일관 상태가 된다.
  clearTripBoundStoreMemory,
  // #1923 — trip 종료 시 사용자 명시 의향 토글 reset.
  // 이전 trip의 의향 신호가 새 trip에 leak되지 않도록 memory + storage 동시 false 처리.
  // 4 cleanup 경로 (FG setDestination(null/switch) / silent push trip-ended /
  // useStateRehydration sentinel / useLaunchTripReconciliation cold-launch) 모두 자동 wire.
  resetUserIntentInfoMode,
  // #2045 (Signal 4) — trip 종료 시 last-silent-push-received stamp 제거.
  // 새 trip의 첫 launch reconciliation 시점에 이전 trip의 last-received가 남아 있으면
  // (직전 trip이 정상 종료 후 새 trip 시작 X → 앱 launch) → 새 trip 판정 오염 방지.
  // 새 trip 등록 후 첫 silent push 수신 시점부터 stamp 재갱신 → clean baseline.
  clearLastSilentPushReceivedAt,
  // #2293 (PR #2301 리뷰 P1) — "일시정지" stamp 제거. storage 채널(NAVIGATION_PAUSED_AT_KEY,
  // cold-start backstop 판정용)과 memory 채널(useNavigationStore.pausedAt, FG 배지 카운트다운
  // 소스)을 반드시 같은 chokepoint에서 함께 지운다 — 산발 호출(startNavigation에서만 memory
  // clear) 시 "일시정지 상태에서 재개/종료 버튼 없이 새 목적지 바로 선택"
  // (handleSelectDestination, navigationActive 무검사 진입점) 경로에서 memory pausedAt만
  // stale로 남아 새 trip에 잔여 배지 + 조기 자동종료가 발생하는 회귀가 있었다.
  // trip 종료 전체 경로(FG setDestination(null/switch) / silent push trip-ended /
  // useStateRehydration sentinel / useLaunchTripReconciliation cold-launch / pause-auto-end
  // backstop 자체)가 모두 이 배열을 거치므로, 여기 한 줄 추가로 두 채널 모두 자동 wire된다.
  clearNavigationPauseState,
];

/**
 * #2293 (PR #2301 리뷰 P1) — 일시정지 storage stamp + memory pausedAt을 한 호출로 동시 clear.
 *
 * 두 채널(navigationPauseStorage의 AsyncStorage stamp / useNavigationStore.pausedAt 메모리)이
 * 서로 다른 시점에 개별 clear되면 한쪽만 지워진 채 새 trip이 시작될 수 있다 — 단일
 * chokepoint(TRIP_BOUND_CLEANUPS)에서 항상 함께 처리해 drift를 원천 차단한다.
 */
function clearNavigationPauseState(): Promise<void> {
  useNavigationStore.getState().clearPausedAt();
  return clearNavigationPausedAt();
}

/**
 * #1892 / #1885 — Live Activity 인스턴스 dismiss helper.
 *
 * silent push `trip-ended` 경로(silentPushTask.ts:889 runTripBoundCleanups 호출) +
 * FG setDestination(null/switch) 경로 모두 LA를 명시적으로 dismiss하지 않으면 사용자가 trip
 * 종료 후에도 "건대입구 → 용마산" 같은 stale LA를 26분 동안 보게 된다 (2026-06-26 T3/T4 회귀).
 *
 * `LiveActivity.endLiveActivity()`는 native module에서 이미 멱등 (활성 인스턴스 없으면
 * graceful no-op, 비-iOS 또는 모듈 미설치 시 즉시 Promise.resolve()). LA가 비활성이거나
 * 호출이 실패해도 reject를 swallow해 cleanup 흐름을 차단하지 않는다 — Promise.allSettled가
 * 일관성 보강하지만 본 helper 자체가 swallow하므로 단독 호출(예: 테스트)에서도 안전.
 */
function endLiveActivityCleanup(): Promise<void> {
  return LiveActivity.endLiveActivity().catch((e) => {
    log.warn('endLiveActivity threw', e);
  });
}

/**
 * #1545 (S12) — trip-bound zustand store의 in-memory mirror를 일괄 클리어.
 *
 * storage는 다른 항목에서 이미 removeItem 되므로 본 함수는 메모리 setState만 수행.
 * 멱등 — 이미 null인 state에 setState 호출은 graceful no-op.
 *
 * useDestinationStore.customOrigin / useBoardingLockStore.lock / useAlarmEventStore.alarmEvent /
 * useAlarmEventStore.dismissSilence를 한 번에 동기화한다. setState는 sync — Promise.resolve로
 * 반환해 TRIP_BOUND_CLEANUPS의 () => Promise<void> shape에 맞춘다.
 *
 * #2152 (P1 code-review) — boardingLock은 직접 `setState({ lock: null })`로 비우지 않고
 * `useBoardingLockStore.releaseLock('trip-cleanup')`을 경유한다. 이 함수는 silent push
 * trip-ended / FG setDestination(null/switch) / useStateRehydration sentinel /
 * cold-launch reconciliation 4개 trip 종료 경로가 모두 거치는 사실상 유일한 lock release
 * chokepoint인데, 직접 setState는 releaseLock 내부의 lifecycle breadcrumb
 * (`pushLockLifecycleEntry`) + Sentry breadcrumb(`addDomainBreadcrumb`)을 우회해 DebugModal
 * "BoardingLock Lifecycle" 섹션에 가장 흔한 release 경로가 전혀 기록되지 않는 관측 공백이었다.
 * releaseLock은 멱등(호출 시점 lock=null이면 no-op)이고 storage clearBoardingLock 재호출도
 * AsyncStorage.removeItem 멱등이라 이 배열의 다른 `BOARDING_LOCK_KEY` removeItem 항목과
 * 병렬 실행돼도 안전하다.
 */
async function clearTripBoundStoreMemory(): Promise<void> {
  const destState = useDestinationStore.getState();
  // customOrigin: setDestination 경로는 이미 null로 동기화하지만, BG silent push 경로는
  // 누락. 사용자가 직접 지정한 출발역이 새 trip에 leak되지 않도록 비운다.
  if (destState.customOrigin !== null) {
    useDestinationStore.setState({ customOrigin: null });
  }
  // boardingLock: releaseLock을 경유해 lifecycle breadcrumb을 남긴다 (#2152 P1).
  if (useBoardingLockStore.getState().lock !== null) {
    await useBoardingLockStore.getState().releaseLock('trip-cleanup');
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
  // #2278 — leg-advance stamp도 trip 경계에서 클리어. 이전 trip의 hop-end 확인이 새 trip의
  // getApproachLine 우선순위를 오염시키지 않도록 한다. #2278 (PR #2287 리뷰 P1-2) — 이 stamp는
  // 이제 trip-scoped storage(LEG_ADVANCE_KEY)로 영속화되므로, boardingLock과 동일하게 store의
  // `clearLegAdvance()` 액션을 경유해 memory + storage 동시 제거한다(직접 setState로 memory만
  // 비우면 storage에 stale 값이 남아 다음 launch reconciliation에서 loadLegAdvance가 이전
  // trip의 stamp를 복원하는 회귀가 생긴다).
  if (useLegAdvanceStore.getState().nextLine !== null) {
    await useLegAdvanceStore.getState().clearLegAdvance();
  }
  return Promise.resolve();
}

/**
 * 모든 trip-bound cleanup을 병렬로 실행한다. 항목들 사이에 순서 의존성이 없어
 * Promise.allSettled로 동시에 띄우고 모든 reject를 흡수한다 (한 항목 실패가
 * 다른 항목 실행이나 호출자에게 전파되지 않도록).
 */
export function runTripBoundCleanups(): Promise<void> {
  // #2089 — TRIP_BOUND_CLEANUPS가 ACTIVE_TRIP_KEY/TRIP_STARTED_AT_KEY를 제거하기 전에
  // effective tripToken을 먼저 읽어야 safetyNetScheduler의 tripToken-scoped cancel이
  // 가능하다(제거 후에는 둘 다 null). #2089 리뷰 P1-2 — backend 등록 없이 device-local id로
  // armed된 trip도 동일하게 cancel 대상이어야 하므로 tripStart도 함께 읽어
  // resolveEffectiveTripToken으로 실제 armed에 쓰인 id를 재구성한다(안 그러면 backend
  // outage 내내 진행된 trip의 안전망 예약이 cleanup에서 누락되는 zombie alarm이 된다).
  return Promise.all([
    AsyncStorage.getItem(ACTIVE_TRIP_KEY).catch(() => null),
    getTripStartedAt(),
  ]).then(([backendTripToken, tripStart]) => {
    const tripToken = resolveEffectiveTripToken(backendTripToken, tripStart);
    // #1525 — FG setDestination(null) 경로의 zombie alarm backstop. 1차 cleanup이 in-flight인
    // 동안 expo-notifications 내부 큐 race로 일부 사전 예약이 살아남는 사례를 1분 후 두번째
    // cancel pass로 정리. 새 trip이 시작되면 tripStart 가드가 skip한다.
    scheduleDefensiveCancel(tripToken);
    // #918 — stationPrescheduler(OS 사전예약 "매역" 채널)도 safetyNetScheduler와 동일하게
    // tripToken-scoped cancel 대상. 두 채널은 sleepMode로 상호 배타적이라 항상 한쪽만
    // 실제로 pending을 갖지만, 나머지 한쪽 cancel은 큐가 비어있어도 안전(멱등)하므로 항상 같이 호출.
    // #2129 — backend DELETE /trips wire. 이 배열의 ACTIVE_TRIP_KEY removeItem 항목이 먼저 돌면
    // 이후 아무 호출자도 backend token을 읽을 수 없어 DELETE가 영구히 발행되지 않는 회귀
    // (lockless trip 종료 경로 전부 — silent push trip-ended / useStateRehydration sentinel /
    // useLaunchTripReconciliation / useDeviceSelfEnd — 모두 본 함수만 호출하고 별도로
    // clearActiveTrip을 부르지 않았다). removeItem 전에 이미 읽어둔 backendTripToken(위)을
    // 그대로 사용 — device-local synthetic id(tripToken)는 backend가 모르는 값이라 제외.
    // fire-and-forget + 실패해도 흡수(allSettled) — backend TTL이 최종 안전망(현행 유지).
    const cleanups = tripToken
      ? [
          ...TRIP_BOUND_CLEANUPS,
          () => cancelAllSafetyNetAlarms(tripToken),
          () => cancelAllPrescheduledAlarms(tripToken),
          ...(backendTripToken
            ? [() => clearActiveTrip(backendTripToken).then(noop)]
            : []),
        ]
      : TRIP_BOUND_CLEANUPS;
    return Promise.allSettled(cleanups.map((cleanup) => cleanup())).then(noop);
  });
}

/**
 * #1370 L4 — OS scheduled notification queue만 즉시 cancel하는 정밀 helper.
 *
 * 종착역 도착 silent push 수신 시 ROUTE_KEY/DESTINATION_KEY 등 storage 정리에 앞서
 * OS 큐의 safety-net 사전 예약 알람을 우선 제거해 burst fire race를 좁힌다.
 * runTripBoundCleanups 전체 흐름은 그대로 유지하며(triggerTripEndRecall은 ROUTE_KEY를
 * 읽어야 해 storage 정리는 그 뒤에 와야 함), 본 helper는 storage를 건드리지 않는다.
 *
 * 멱등 — runTripBoundCleanups가 후속에서 동일 OS API를 다시 호출해도 이미 비어 있어 안전.
 *
 * 호출자(silentPushTask trip-ended 분기)가 이 결과를 await한 뒤 triggerTripEndRecall/
 * runTripBoundCleanups를 이어 호출하므로, OS reject(예: getAllScheduledNotificationsAsync
 * throw)가 그대로 전파되면 뒤따르는 cleanup 체인 전체가 중단된다. #918 A3 통합 이전에는
 * 두 채널을 Promise.allSettled로 묶어 이 전파를 흡수했으나, 단일 채널이 된 뒤에도 동일
 * 보장을 유지하기 위해 여기서 명시적으로 흡수한다.
 */
export function cancelTripBoundOsQueue(): Promise<void> {
  // #2089 리뷰 P1-2 — device-local id로 armed된 trip도 대상이어야 하므로 tripStart도 함께
  // 읽어 resolveEffectiveTripToken으로 재구성한다(runTripBoundCleanups와 동일 근거).
  return Promise.all([
    AsyncStorage.getItem(ACTIVE_TRIP_KEY).catch(() => null),
    getTripStartedAt(),
  ]).then(([backendTripToken, tripStart]) => {
    const tripToken = resolveEffectiveTripToken(backendTripToken, tripStart);
    scheduleDefensiveCancel(tripToken);
    if (!tripToken) return undefined;
    // #918 — stationPrescheduler(OS 사전예약 "매역" 채널)도 같은 tripToken-scoped cancel 대상.
    return Promise.all([
      cancelAllSafetyNetAlarms(tripToken).catch((e: unknown) => {
        log.warn('cancelTripBoundOsQueue: safety-net cancel 실패', e);
      }),
      cancelAllPrescheduledAlarms(tripToken).catch((e: unknown) => {
        log.warn('cancelTripBoundOsQueue: prescheduled cancel 실패', e);
      }),
    ]).then(noop);
  });
}

/**
 * #1525 — trip 종료 직후 1분 뒤 한 번 더 safety-net OS 사전 예약을 cancel한다.
 *
 * 1차 cancel 시점에 race로 schedule이 in-flight였거나, expo-notifications 내부 큐 반영
 * 지연으로 일부 identifier가 cancel을 빠져나가는 경우를 보강. 2026-06-19 trip 종료
 * 11분 후 "안내 종료" 알림이 사용자에게 도달한 사례(zombie alarm)의 backstop.
 *
 * 새 trip이 시작되었으면(tripStart 갱신) 정상 사전 예약을 지우면 안 되므로 skip.
 * 이미 예약된 defensive timer가 있으면 새 호출이 reset(이전 timer cancel → 새 timer).
 * tripToken은 호출 시점(=cleanup 시작 시점, ACTIVE_TRIP_KEY 제거 전)에 캡처해 1분 뒤에도
 * 같은 트립을 대상으로 cancel한다(#918 route-sig staleness 폐기 이후 tripStart 존재 여부만으로
 * "새 trip 진행 중"을 판별 — 2026-07-31 매트릭스 "route-sig staleness: trip 재등록 시 재예약으로
 * 대체 가능" 근거와 동형).
 *
 * 별도 export 없이 cancelTripBoundOsQueue / runTripBoundCleanups 내부에서만 호출.
 */
function scheduleDefensiveCancel(tripToken: string | null): void {
  if (defensiveTimer !== null) {
    clearTimeout(defensiveTimer);
  }
  defensiveTimer = setTimeout(() => {
    defensiveTimer = null;
    void runDefensiveCancel(tripToken);
  }, DEFENSIVE_CANCEL_DELAY_MS);
}

async function runDefensiveCancel(tripToken: string | null): Promise<void> {
  // 새 trip이 시작되어 tripStart가 다시 기록됐으면 사전 예약은 정상 — defensive cancel skip.
  const tripStart = await getTripStartedAt();
  if (tripStart !== null) {
    log.info('defensive cancel skip: new trip active');
    return;
  }
  if (!tripToken) return;
  log.info('defensive cancel: running second cancel pass (#1525)');
  await cancelAllSafetyNetAlarms(tripToken).catch((e) => {
    log.warn('defensive cancel 실패:', e);
  });
  // #918 — prescheduled(매역) 채널도 동일 backstop 대상.
  await cancelAllPrescheduledAlarms(tripToken).catch((e) => {
    log.warn('defensive cancel (prescheduled) 실패:', e);
  });
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
