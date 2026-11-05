/* eslint-disable import/no-restricted-paths --
 * whole-chain 테스트: route(setDestination) → alarm(LTR Signal 4 / 종료 알림 / cleanup) 전체를 실제 모듈로 관통한다.
 */
/**
 * #3005 PR-B — 11/03 실측 트립 whole-chain: 종료 알림 2회(reason=arrived 20:08:22 + reason=backend-silent 20:08:23).
 *
 * 실측 사실(불변, 덤프 텍스트-1321808001AF-1.txt): lastSilentPush 19:06:48 KST, 앱 진입 now 20:08:20 KST
 * (침묵 61분 > Signal 4 임계 30분), 목적지 7호선 용마산(7-015), corrId 보유.
 * 기대: 어느 경로가 먼저든 종료 알림은 1건. 모킹 경계는 OS(expo-notifications) / backend / 관측뿐 —
 * `notifyTripEnded`·`tripEndClaim`·cleanup·store는 실물.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { runLaunchTripReconciliation } from '../hooks/useLaunchTripReconciliation';
import { clearAndNotifyTripEnded } from '../utils/tripEndedNotification';
import { __resetTripEndClaimsForTests__ } from '../utils/tripEndClaim';
import { setLastSilentPushReceivedAt } from '../utils/lastSilentPushReceivedAt';
import { setTripStartedAt } from '../utils/tripStartStorage';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { setBoardingLock } from '../utils/boardingLockStorage';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import {
  clearTripCorrId,
  getCurrentTripCorrId,
  getCurrentTripCorrIdSync,
} from '../../observability/utils/tripCorrId';
import { ACTIVE_TRIP_KEY, TRIP_CORR_ID_KEY } from '../../../shared/constants/storageKeys';
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
jest.mock('../api/alarmBackend', () => ({
  ...jest.requireActual('../api/alarmBackend'),
  clearActiveTrip: jest.fn().mockResolvedValue(undefined),
  resetAlarmBackendDedup: jest.fn(),
}));
jest.mock('../api/signalDumpBackend', () => ({
  flushSignalDumpOutbox: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../api/tripStatus', () => ({ fetchTripStatus: jest.fn() }));
const mockRecall = jest.fn();
jest.mock('../utils/triggerTripEndRecall', () => ({
  triggerTripEndRecall: (...a: unknown[]) => mockRecall(...a),
}));
jest.mock('../../debug/utils/triggerTripGroundTruthPrompt', () => ({
  triggerTripGroundTruthPrompt: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: jest.fn(),
}));

const YONGMASAN: Station = {
  id: '7-015',
  name: '용마산',
  line: '7',
  lineColor: '#747F00',
  lat: 37.573,
  lng: 127.087,
};
// 덤프 실측(KST): 마지막 silent push 19:06:48 / 앱 진입 20:08:20.
const LAST_SILENT_PUSH_AT = Date.parse('2026-11-03T19:06:48+09:00');
const NOW = Date.parse('2026-11-03T20:08:20+09:00');
// trip 시작 시각은 덤프에 없다 — Signal 4 상한(10h) 안쪽이면 되는 가정값.
const TRIP_STARTED_AT = Date.parse('2026-11-03T18:30:00+09:00');
const CORR_ID = `${TRIP_STARTED_AT}-a1b2c3d4`;
// 덤프의 APNs 토큰은 가린다.
const TRIP_TOKEN = 'REDACTED-APNS-TOKEN';
// #3005 PR-C — lock-only-alerts(10-21): Signal 4 / 도착 자동 해제의 종료 알림은 lock trip에만 나간다. 이 이중 알림
// 시나리오는 "알림이 나가는 trip"(= lock 있음)에서만 성립하므로 lock을 시드한다(덤프 값은 그대로).
const LOCK = {
  destinationId: '7-015',
  trainCode: '7123',
  boardingStationId: '7-001',
  boardingLine: '7',
  boardedAt: TRIP_STARTED_AT,
  expectedDurationMs: 3_600_000,
} as BoardingLock;

const scheduleMock = Notifications.scheduleNotificationAsync as jest.Mock;

async function flush(): Promise<void> {
  for (let i = 0; i < 120; i++) await Promise.resolve();
}

function endedReasons(): string[] {
  return scheduleMock.mock.calls.map(([req]) => req.content.data.reason);
}

describe('#3005 PR-B — 11/03 종료 알림 중복 (replay)', () => {
  const recallResolvers: Array<() => void> = [];
  const releaseRecall = (): void => {
    recallResolvers.splice(0).forEach((r) => r());
  };

  async function seedTrip(opts: { corrIdHydrated: boolean }): Promise<void> {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, TRIP_TOKEN);
    await setLastSilentPushReceivedAt(LAST_SILENT_PUSH_AT);
    await setTripStartedAt(TRIP_STARTED_AT);
    await AsyncStorage.setItem(TRIP_CORR_ID_KEY, CORR_ID);
    if (opts.corrIdHydrated) await getCurrentTripCorrId();
    useDestinationStore.setState({ destination: YONGMASAN, customOrigin: null, tripOrigin: null });
    await setBoardingLock(LOCK);
    useBoardingLockStore.setState({ lock: LOCK });
  }

  /** HomeScreen 도착 자동 해제(HS:497)와 같은 호출 모양. */
  function arrivalAutoClear(): void {
    clearAndNotifyTripEnded(
      () => useDestinationStore.getState().setDestination(null, 'arrival-auto-clear'),
      { destination: YONGMASAN, reason: 'arrived' },
    );
  }

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(NOW);
    jest.clearAllMocks();
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://backend.test';
    __resetTripEndClaimsForTests__();
    await AsyncStorage.clear();
    await clearTripCorrId();
    useDestinationStore.setState({ destination: null, customOrigin: null, tripOrigin: null });
    useBoardingLockStore.setState({ lock: null });
    recallResolvers.length = 0;
    // Signal 4의 recall(첫 호출)만 보류시켜 await 중에 다른 경로가 끼어들 수 있게 한다.
    // 끼어든 경로(도착 해제)의 recall은 즉시 끝나 cleanup이 corrId를 먼저 지운다 — 11/03 실측 순서.
    mockRecall.mockImplementation(() =>
      mockRecall.mock.calls.length > 1
        ? Promise.resolve({ uploaded: false })
        : new Promise((resolve) => {
            recallResolvers.push(() => resolve({ uploaded: false }));
          }),
    );
  });
  afterEach(() => jest.useRealTimers());

  async function expectEndedOnce(): Promise<void> {
    // 알림은 1건.
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    // cleanup 실질 효과(정리는 멱등이라 횟수가 아니라 종착 상태를 본다): 목적지·corrId·활성 trip 키 제거.
    expect(useDestinationStore.getState().destination).toBeNull();
    expect(getCurrentTripCorrIdSync()).toBeNull();
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
  }

  it.each([
    ['corrId 캐시가 hydrate된 상태', true],
    ['cold launch — corrId hydrate 전에 진입', false],
  ])('도착 해제가 Signal 4 recall 대기 중 끼어든다 (%s) → 알림 1건', async (_n, hydrated) => {
    await seedTrip({ corrIdHydrated: hydrated });
    const signal4 = runLaunchTripReconciliation();
    await flush(); // Signal 4: recall 대기
    expect(mockRecall).toHaveBeenCalledTimes(1);
    arrivalAutoClear(); // 20:08:22 도착 자동 해제
    await flush();
    releaseRecall(); // recall 해제 -> Signal 4 계속
    await signal4;
    await flush();
    await expectEndedOnce();
  });

  it.each([
    ['corrId 캐시가 hydrate된 상태', true],
    ['cold launch — corrId hydrate 전에 진입', false],
  ])('도착 해제 직후 recall이 풀려 Signal 4 알림이 같은 틱에 경쟁한다 (%s) → 알림 1건', async (_n, hydrated) => {
    await seedTrip({ corrIdHydrated: hydrated });
    const signal4 = runLaunchTripReconciliation();
    await flush();
    arrivalAutoClear();
    releaseRecall();
    await signal4;
    await flush();
    await expectEndedOnce();
  });

  it('거부 — 도착 해제 단독 종료는 여전히 알림 1건(arrived)', async () => {
    await seedTrip({ corrIdHydrated: true });
    arrivalAutoClear();
    await flush();
    expect(endedReasons()).toEqual(['arrived']);
    expect(useDestinationStore.getState().destination).toBeNull();
  });

  it('거부 — Signal 4 단독 종료도 알림 1건(backend-silent)', async () => {
    await seedTrip({ corrIdHydrated: true });
    const signal4 = runLaunchTripReconciliation();
    await flush();
    releaseRecall();
    await signal4;
    await flush();
    expect(endedReasons()).toEqual(['backend-silent']);
  });
});
