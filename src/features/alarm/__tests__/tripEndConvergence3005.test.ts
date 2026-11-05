/* eslint-disable import/no-restricted-paths --
 * whole-chain 테스트: alarm(LTR/DSE) + shared(RH) 종료 경로 4곳이 정본(`tripEndedCleanupSequence`)을 거쳐
 * route(destination store)·alarm(cleanup/sentinel/lock)까지 관통하는지 실제 모듈로 검증한다.
 */
/**
 * #3005 PR-C — 종료 경로 4곳(Signal 4 / 9시간 / 일시정지 / device self-end)을 정본으로 수렴.
 *
 * 모킹 경계는 OS(expo-notifications) / backend(clearActiveTrip, fetchTripStatus) / 관측(breadcrumb) /
 * 업로드(recall, ground-truth prompt)뿐이다. claim·notifyTripEnded·cleanup·sentinel·store는 실물.
 * 각 경로는 정본의 단계를 **분리 assert**한다(합산 카운트 금지): 알림 → recall → backend DELETE(사유·corrId) →
 * prompt(corrId snapshot) → 메모리 reset → breadcrumb → lock release 사유 → sentinel → ACTIVE_TRIP 제거.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import { runLaunchTripReconciliation } from '../hooks/useLaunchTripReconciliation';
import { useDeviceSelfEnd } from '../hooks/useDeviceSelfEnd';
import { useStateRehydration } from '../../../shared/hooks/useStateRehydration';
import { clearAndNotifyTripEnded } from '../utils/tripEndedNotification';
import { __resetTripEndClaimsForTests__, claimTripEndAction } from '../utils/tripEndClaim';
import { setLastSilentPushReceivedAt } from '../utils/lastSilentPushReceivedAt';
import { setTripStartedAt } from '../utils/tripStartStorage';
import { setNavigationPausedAt } from '../utils/navigationPauseStorage';
import { getTripEndedSentinel, setTripEndedSentinel } from '../utils/tripEndedSentinel';
import { setBoardingLock } from '../utils/boardingLockStorage';
import { cleanupBackendConfirmedEndedTrip } from '../utils/tripEndedCleanupSequence';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import {
  clearTripCorrId,
  getCurrentTripCorrId,
  getCurrentTripCorrIdSync,
  setTripCorrId,
} from '../../observability/utils/tripCorrId';
import {
  ACTIVE_TRIP_KEY,
  DESTINATION_KEY,
  TRIP_CORR_ID_KEY,
} from '../../../shared/constants/storageKeys';
import { PAUSE_AUTO_END_MS } from '../../../shared/constants/realtime';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { Station } from '../../../shared/types/station';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-notifications', () => ({
  SchedulableTriggerInputTypes: { DATE: 'date' },
  AndroidNotificationPriority: { MAX: 'max' },
  scheduleNotificationAsync: jest.fn().mockResolvedValue('id'),
  cancelScheduledNotificationAsync: jest.fn().mockResolvedValue(undefined),
  getAllScheduledNotificationsAsync: jest.fn().mockResolvedValue([]),
  getPresentedNotificationsAsync: jest.fn().mockResolvedValue([]),
  dismissNotificationAsync: jest.fn().mockResolvedValue(undefined),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  setNotificationHandler: jest.fn(),
}));
const order: string[] = [];
const mockClearActiveTrip = jest.fn();
jest.mock('../api/alarmBackend', () => ({
  ...jest.requireActual('../api/alarmBackend'),
  clearActiveTrip: (...a: unknown[]) => mockClearActiveTrip(...a),
  resetAlarmBackendDedup: jest.fn(),
}));
jest.mock('../api/signalDumpBackend', () => ({
  flushSignalDumpOutbox: jest.fn().mockResolvedValue(undefined),
}));
const mockFetchTripStatus = jest.fn();
jest.mock('../api/tripStatus', () => ({
  fetchTripStatus: (...a: unknown[]) => mockFetchTripStatus(...a),
}));
const mockRecall = jest.fn();
jest.mock('../utils/triggerTripEndRecall', () => ({
  triggerTripEndRecall: (...a: unknown[]) => mockRecall(...a),
}));
const mockPrompt = jest.fn();
jest.mock('../../debug/utils/triggerTripGroundTruthPrompt', () => ({
  triggerTripGroundTruthPrompt: (...a: unknown[]) => mockPrompt(...a),
}));
const mockBreadcrumb = jest.fn();
jest.mock('../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: (...a: unknown[]) => mockBreadcrumb(...a),
}));

const scheduleMock = Notifications.scheduleNotificationAsync as jest.Mock;

const DESTINATION: Station = {
  id: '7-015',
  name: '용마산',
  line: '7',
  lineColor: '#747F00',
  lat: 37.573,
  lng: 127.087,
};
const OTHER_DESTINATION: Station = { ...DESTINATION, id: '7-016', name: '중곡', lat: 37.565 };
const NOW = Date.parse('2026-11-03T20:08:20+09:00');
const HOUR_MS = 3_600_000;
const TRIP_STARTED_AT = NOW - 2 * HOUR_MS;
const CORR_ID = `${TRIP_STARTED_AT}-a1b2c3d4`;
const NEW_CORR_ID = `${NOW}-ffeeddcc`;
const TRIP_TOKEN = 'REDACTED-APNS-TOKEN';
const LOCK = {
  destinationId: DESTINATION.id,
  trainCode: '7123',
  boardingStationId: '7-001',
  boardingLine: '7',
  boardedAt: NOW - HOUR_MS,
  expectedDurationMs: HOUR_MS,
} as BoardingLock;

async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

function sentinelOf(): Promise<unknown> {
  return getTripEndedSentinel();
}

/** `lock-release` breadcrumb에 실린 사유들(정본이 한 번, 정확한 사유로 기록해야 한다). */
function lockReleaseReasons(): string[] {
  return mockBreadcrumb.mock.calls
    .filter(([scope, name]) => scope === 'boarding' && name === 'lock-release')
    .map(([, , data]) => (data as { reason: string }).reason);
}

function tripEndBreadcrumbReasons(): string[] {
  return mockBreadcrumb.mock.calls
    .filter(([scope, name]) => scope === 'trip' && name === 'end')
    .map(([, , data]) => (data as { reason: string }).reason);
}

async function seedTrip(opts: { lock: boolean; startedAt?: number }): Promise<void> {
  await AsyncStorage.setItem(ACTIVE_TRIP_KEY, TRIP_TOKEN);
  await setTripStartedAt(opts.startedAt ?? TRIP_STARTED_AT);
  await AsyncStorage.setItem(TRIP_CORR_ID_KEY, CORR_ID);
  await getCurrentTripCorrId();
  await AsyncStorage.setItem(DESTINATION_KEY, JSON.stringify(DESTINATION));
  useDestinationStore.setState({ destination: DESTINATION, customOrigin: null, tripOrigin: null });
  if (opts.lock) {
    await setBoardingLock(LOCK);
    useBoardingLockStore.setState({ lock: LOCK });
  }
}

interface Site {
  name: string;
  reason: string;
  /** 종료 알림 문구 사유. */
  noticeReason: string;
  /** lock 없는 trip에는 알림을 내지 않는다(10-21 lock-only-alerts). */
  noticeOnlyWithLock: boolean;
  seed: (lock: boolean) => Promise<void>;
  /** 경로를 한 번 구동하고 종료 처리가 끝날 때까지 기다린다. */
  run: () => Promise<void>;
}

const sites: Site[] = [
  {
    name: 'Signal 4 (LTR)',
    reason: 'launch-backend-silent-timeout',
    noticeReason: 'backend-silent',
    noticeOnlyWithLock: true,
    seed: async (lock) => {
      await seedTrip({ lock });
      await setLastSilentPushReceivedAt(NOW - HOUR_MS);
    },
    run: async () => {
      await runLaunchTripReconciliation();
      await flush();
    },
  },
  {
    name: '9시간 force-end (RH)',
    reason: 'lifecycle-9h-force-end',
    noticeReason: 'lifecycle',
    noticeOnlyWithLock: false,
    seed: (lock) => seedTrip({ lock, startedAt: NOW - 10 * HOUR_MS }),
    run: async () => {
      renderHook(() => useStateRehydration());
      await act(flush);
    },
  },
  {
    name: '일시정지 15분 backstop (RH)',
    reason: 'navigation-pause-auto-end',
    noticeReason: 'paused',
    noticeOnlyWithLock: false,
    seed: async (lock) => {
      await seedTrip({ lock });
      await setNavigationPausedAt(NOW - PAUSE_AUTO_END_MS - 1_000);
    },
    run: async () => {
      renderHook(() => useStateRehydration());
      await act(flush);
    },
  },
  {
    name: 'device self-end (DSE)',
    reason: 'trip-device-self-end-arc-completion',
    noticeReason: 'arrived',
    noticeOnlyWithLock: true,
    seed: (lock) => seedTrip({ lock }),
    run: async () => {
      const inputs = (): Parameters<typeof useDeviceSelfEnd>[0] => ({
        // 새 객체 -> effect deps 변경. 목적지와 다른 역이라 Signal 1은 불성립(Signal 2만 발화).
        currentStation: { ...OTHER_DESTINATION },
        confidence: null,
        arcProgress: 0.97,
        positionStability: 'static',
        expectedTripDurationMs: null,
      });
      const { rerender } = renderHook((p: Parameters<typeof useDeviceSelfEnd>[0]) => useDeviceSelfEnd(p), {
        initialProps: inputs(),
      });
      await act(flush);
      // Signal 2: arc >= 0.95 + stationary 60s 지속.
      jest.setSystemTime(NOW + 61_000);
      rerender({ ...inputs() });
      await act(flush);
    },
  },
];

beforeEach(async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  order.length = 0;
  process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://backend.test';
  __resetTripEndClaimsForTests__();
  await AsyncStorage.clear();
  await clearTripCorrId();
  useDestinationStore.setState({ destination: null, customOrigin: null, tripOrigin: null });
  useBoardingLockStore.setState({ lock: null });
  mockFetchTripStatus.mockResolvedValue({ status: 'active' });
  mockClearActiveTrip.mockImplementation(async () => {
    order.push('backend-delete');
  });
  mockRecall.mockImplementation(async () => {
    order.push('recall');
    return { uploaded: false };
  });
  mockPrompt.mockImplementation(async () => {
    order.push('prompt');
  });
  scheduleMock.mockImplementation(async () => {
    order.push('notice');
    return 'id';
  });
});
afterEach(() => jest.useRealTimers());

describe.each(sites)('#3005 PR-C — $name 가 정본 8단을 단계별로 수행한다', (site) => {
  it('lock trip: 알림 → recall → backend DELETE → prompt 순서 + 각 단계 분리 assert', async () => {
    await site.seed(true);
    await site.run();

    // (1) 종료 알림 1건, 문구 사유 정확, corrId가 지워지기 전에(= recall·cleanup보다 앞서) 나간다.
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0][0].content.data.reason).toBe(site.noticeReason);
    // (2) recall 1회.
    expect(mockRecall).toHaveBeenCalledTimes(1);
    // (3) backend DELETE는 경로 고유 사유 + 캡처한 corrId로 compare-and-delete.
    expect(mockClearActiveTrip).toHaveBeenCalledTimes(1);
    expect(mockClearActiveTrip).toHaveBeenCalledWith(TRIP_TOKEN, site.reason, CORR_ID);
    // (4) prompt는 종료된 trip의 corrId snapshot으로.
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockPrompt).toHaveBeenCalledWith(CORR_ID);
    // 순서: 알림 -> recall -> DELETE -> prompt.
    expect(order).toEqual(['notice', 'recall', 'backend-delete', 'prompt']);
    // (5) 메모리 store reset.
    expect(useDestinationStore.getState().destination).toBeNull();
    expect(useDestinationStore.getState().tripOrigin).toBeNull();
    // (6) trip 종료 breadcrumb — 경로 사유.
    expect(tripEndBreadcrumbReasons()).toContain(site.reason);
    // (7) lock release는 정확히 한 번, 경로 사유로.
    expect(lockReleaseReasons()).toEqual([site.reason]);
    expect(useBoardingLockStore.getState().lock).toBeNull();
    // (8) sentinel(corrId 동봉) + ACTIVE_TRIP 제거.
    expect(await sentinelOf()).toEqual(expect.objectContaining({ corrId: CORR_ID }));
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
    expect(getCurrentTripCorrIdSync()).toBeNull();
  });

  it('lockless trip: 종료는 동일하게 수행하되 알림은 사유별 규칙(lock 전용 경로는 0건)', async () => {
    await site.seed(false);
    await site.run();

    expect(scheduleMock).toHaveBeenCalledTimes(site.noticeOnlyWithLock ? 0 : 1);
    expect(mockRecall).toHaveBeenCalledTimes(1);
    expect(mockClearActiveTrip).toHaveBeenCalledWith(TRIP_TOKEN, site.reason, CORR_ID);
    expect(mockPrompt).toHaveBeenCalledWith(CORR_ID);
    expect(useDestinationStore.getState().destination).toBeNull();
    expect(await sentinelOf()).toEqual(expect.objectContaining({ corrId: CORR_ID }));
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
  });

  it('거부 — 같은 종료를 다른 경로가 먼저 선점했으면 알림·recall·cleanup·sentinel 모두 skip', async () => {
    await site.seed(true);
    const preempt = await claimTripEndAction();
    expect(preempt.claimed).toBe(true);
    await site.run();

    expect(scheduleMock).not.toHaveBeenCalled();
    expect(mockRecall).not.toHaveBeenCalled();
    expect(mockClearActiveTrip).not.toHaveBeenCalled();
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(await sentinelOf()).toBeNull();
    expect(useDestinationStore.getState().destination).toEqual(DESTINATION);
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBe(TRIP_TOKEN);
  });
});

describe('#3005 PR-C — 정본 안의 identity 가드(PR-A expected)', () => {
  /** recall을 보류시켜, 그 사이 새 trip이 등록되는 경합을 만든다. */
  function holdRecall(): { release: () => void } {
    let release = (): void => undefined;
    mockRecall.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ uploaded: false });
        }),
    );
    return { release: () => release() };
  }

  async function registerNewTrip(): Promise<void> {
    await setTripCorrId(NEW_CORR_ID);
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, TRIP_TOKEN); // 운영 token은 APNs 토큰이라 trip마다 같다.
    await AsyncStorage.setItem(DESTINATION_KEY, JSON.stringify(OTHER_DESTINATION));
    useDestinationStore.setState({ destination: OTHER_DESTINATION });
  }

  it.each(sites.filter((s) => s.name.startsWith('Signal 4') || s.name.startsWith('9시간')))(
    '$name — recall 대기 중 새 trip이 등록되면 새 trip의 메모리·ACTIVE_TRIP·corrId·sentinel을 건드리지 않는다',
    async (site) => {
      await site.seed(false);
      const hold = holdRecall();
      const running = site.run();
      await flush();
      expect(mockRecall).toHaveBeenCalledTimes(1);
      await registerNewTrip();
      hold.release();
      await running;
      await act(flush);

      expect(useDestinationStore.getState().destination).toEqual(OTHER_DESTINATION);
      expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBe(TRIP_TOKEN);
      expect(getCurrentTripCorrIdSync()).toBe(NEW_CORR_ID);
      expect(await sentinelOf()).toBeNull();
    },
  );

  it('기존 정본 진입점(backend-confirmed)도 같은 가드를 받는다', async () => {
    await seedTrip({ lock: false });
    const hold = holdRecall();
    const running = cleanupBackendConfirmedEndedTrip(NOW);
    await flush();
    await registerNewTrip();
    hold.release();
    await running;

    expect(useDestinationStore.getState().destination).toEqual(OTHER_DESTINATION);
    expect(getCurrentTripCorrIdSync()).toBe(NEW_CORR_ID);
    expect(await sentinelOf()).toBeNull();
    expect(mockPrompt).toHaveBeenCalledWith(CORR_ID);
  });
});

describe('#3005 PR-C — 정본 실패 시 claim 해제(재시도 가능)', () => {
  it('Signal 4: recall이 throw하면 claim을 풀어 다음 launch가 종료를 재시도한다', async () => {
    await sites[0].seed(true);
    mockRecall.mockRejectedValueOnce(new Error('recall boom'));
    await sites[0].run();
    expect(await sentinelOf()).toBeNull();

    await sites[0].run();
    expect(await sentinelOf()).toEqual(expect.objectContaining({ corrId: CORR_ID }));
  });
});

describe('#3005 PR-C — #2425 pause sentinel 가드', () => {
  it('일시정지 자동 종료는 sentinel을 반드시 남긴다(정본 경유로 보장) — 다음 FG가 소비한다', async () => {
    await sites[2].seed(false);
    await sites[2].run();
    expect(await sentinelOf()).toEqual(expect.objectContaining({ corrId: CORR_ID }));
  });
});

describe('#3005 PR-C — HomeScreen 도착 자동 해제 알림은 lock trip에만(lock-only-alerts)', () => {
  function arrivalAutoClear(): void {
    clearAndNotifyTripEnded(
      () => useDestinationStore.getState().setDestination(null, 'arrival-auto-clear'),
      { destination: DESTINATION, reason: 'arrived' },
    );
  }

  it('lock trip → 알림 1건(arrived)', async () => {
    await seedTrip({ lock: true });
    arrivalAutoClear();
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0][0].content.data.reason).toBe('arrived');
  });

  it('lockless trip → 알림 0건, 종료(destination clear)는 그대로', async () => {
    await seedTrip({ lock: false });
    arrivalAutoClear();
    await flush();
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(useDestinationStore.getState().destination).toBeNull();
  });
});

describe('#3005 PR-C — 수렴 불가 3곳: 정본을 쓰면 깨지는 것을 고정', () => {
  it('목적지 전환(DST): 정본은 새 목적지를 지우고 sentinel을 남기지만, setDestination(station)은 새 목적지를 보존하고 sentinel을 남기지 않는다', async () => {
    await seedTrip({ lock: false });
    // 대조군: 정본으로 "전환"을 흉내 내면 방금 설정한 목적지가 사라지고 trip-ended sentinel이 남는다(새 trip 즉사).
    useDestinationStore.setState({ destination: OTHER_DESTINATION });
    await cleanupBackendConfirmedEndedTrip(NOW);
    expect(useDestinationStore.getState().destination).toBeNull();
    expect(await sentinelOf()).not.toBeNull();

    // 실제 전환 경로.
    await AsyncStorage.clear();
    await clearTripCorrId();
    await seedTrip({ lock: false });
    useDestinationStore.getState().setDestination(OTHER_DESTINATION, 'destination-switch');
    await flush();
    await act(flush);
    expect(useDestinationStore.getState().destination).toEqual(OTHER_DESTINATION);
    expect(await sentinelOf()).toBeNull();
  });

  it('silent push BG(SPT): 정본은 AppState와 무관하게 zustand를 setState하지만 BG 경로는 하지 않는다(silentPushTask.test의 BG 가드와 짝)', async () => {
    await seedTrip({ lock: false });
    const original = Object.getOwnPropertyDescriptor(AppState, 'currentState');
    Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
    await cleanupBackendConfirmedEndedTrip(NOW);
    // 정본에는 BG 가드가 없다 — 그래서 SPT BG 경로는 정본으로 수렴할 수 없다.
    expect(useDestinationStore.getState().destination).toBeNull();
    if (original) Object.defineProperty(AppState, 'currentState', original);
  });

  it('sentinel 소비(RH:127): sentinel을 set이 아니라 clear로 끝내고 recall을 하지 않는다 — 정본과 정반대', async () => {
    await seedTrip({ lock: false });
    await setTripEndedSentinel(NOW - 1_000, CORR_ID);
    renderHook(() => useStateRehydration());
    await act(flush);
    expect(await sentinelOf()).toBeNull();
    expect(mockRecall).not.toHaveBeenCalled();
    expect(useDestinationStore.getState().destination).toBeNull();
  });
});
