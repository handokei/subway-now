/* eslint-disable import/no-restricted-paths --
 * whole-chain 테스트: route(setDestination) → alarm(lock / cleanup / responder) 사슬 전체를
 * 실제 모듈로 관통한다. cross-feature가 본질.
 */
/**
 * #3007 A — 10/20 실측 트립 whole-chain.
 *
 * 실측 사실(불변): 목적지를 18:40:11 KST에 설정했고 lock은 끝내 붙지 않았다(lockless). 이후
 * 좀비 trip이 06:17까지 살아 있었다. 기대: 18:55:11에 "종료할까요?" 제안이 OS 예약돼 있다.
 * 모킹 경계는 OS(expo-notifications) / backend(alarmBackend) / 관측뿐 — store·cleanup·responder는 실물.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { runTripBoundCleanups } from '../store/tripBoundCleanups';
import { handleAlarmEndTripResponse } from '../hooks/useAlarmEndTripResponder';
import { ALARM_ACTION_END_TRIP } from '../utils/notificationCategory';
import { getTripStartedAt } from '../utils/tripStartStorage';
import { ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import { clearActiveTrip } from '../api/alarmBackend';
import type { Station } from '../../../shared/types/station';
import type { BoardingLock } from '../../../shared/types/boardingLock';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockScheduled = new Map<string, { identifier: string; content: any; trigger: any }>();
jest.mock('expo-notifications', () => ({
  SchedulableTriggerInputTypes: { DATE: 'date' },
  AndroidNotificationPriority: { MAX: 'max' },
  scheduleNotificationAsync: jest.fn(async (req: any) => {
    mockScheduled.set(req.identifier, req);
    return req.identifier;
  }),
  cancelScheduledNotificationAsync: jest.fn(async (id: string) => {
    mockScheduled.delete(id);
  }),
  getAllScheduledNotificationsAsync: jest.fn(async () => [...mockScheduled.values()]),
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
jest.mock('../../observability/utils/tripCorrId', () => ({
  generateTripCorrId: jest.fn(() => 'cid-test'),
  setTripCorrId: jest.fn().mockResolvedValue(undefined),
  clearTripCorrId: jest.fn().mockResolvedValue(undefined),
  getCurrentTripCorrIdSync: jest.fn(() => null),
  refreshCorrId: jest.fn(),
}));
jest.mock('../utils/triggerTripEndRecall', () => ({
  triggerTripEndRecall: jest.fn().mockResolvedValue({ uploaded: false }),
}));
jest.mock('../../debug/utils/triggerTripGroundTruthPrompt', () => ({
  triggerTripGroundTruthPrompt: jest.fn().mockResolvedValue(undefined),
}));
const mockBreadcrumb = jest.fn();
jest.mock('../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: (...a: unknown[]) => mockBreadcrumb(...a),
}));

const YONGMASAN: Station = {
  id: '5-yongmasan',
  name: '용마산',
  line: '7',
  lineColor: '#747F00',
  lat: 37.573,
  lng: 127.087,
};
const SET_AT = Date.parse('2026-10-20T09:40:11Z'); // 18:40:11 KST
const OFFER_AT = Date.parse('2026-10-20T09:55:11Z'); // 18:55:11 KST
const OFFER_ID = 'trip-end-offer';
const DEFAULT_TAP = 'expo.modules.notifications.actions.DEFAULT';
const OFFER_DATA = { kind: 'trip-end-offer' };

const lock: BoardingLock = {
  destinationId: YONGMASAN.id,
  trainCode: '7001',
  boardingStationId: 'x',
  boardingLine: '7',
  boardedAt: SET_AT + 60_000,
  expectedDurationMs: 600_000,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

describe('#3007 A — 10/20 lockless 트립 whole-chain', () => {
  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(SET_AT);
    jest.clearAllMocks();
    mockScheduled.clear();
    await AsyncStorage.clear();
    useDestinationStore.setState({ destination: null, customOrigin: null, tripOrigin: null });
    useBoardingLockStore.setState({ lock: null });
    (clearActiveTrip as jest.Mock).mockResolvedValue(undefined);
  });
  afterEach(() => jest.useRealTimers());

  async function startTrip(): Promise<void> {
    useDestinationStore.getState().setDestination(YONGMASAN);
    await flush();
    // 취소/거부 테스트가 "애초에 예약이 없어서" 공허하게 통과하지 않도록 전제를 강제한다.
    expect(mockScheduled.has(OFFER_ID)).toBe(true);
  }

  it('목적지 설정 18:40:11 + lock 없음 → 18:55:11에 제안 1건이 예약돼 있다', async () => {
    await startTrip();
    const offer = mockScheduled.get(OFFER_ID);
    expect(offer).toBeDefined();
    expect(offer!.trigger.date.getTime()).toBe(OFFER_AT);
    expect(offer!.content.data.kind).toBe('trip-end-offer');
    expect(offer!.content.sound).toBeTruthy();
    expect(mockScheduled.size).toBe(1);
  });

  it('다른 목적지로 전환하면 이전 제안을 덮어쓴다 (여전히 1건, 새 시작 기준)', async () => {
    await startTrip();
    jest.setSystemTime(SET_AT + 5 * 60_000);
    useDestinationStore.getState().setDestination({ ...YONGMASAN, id: '5-other', name: '아차산' });
    await flush();
    expect(mockScheduled.size).toBe(1);
    expect(mockScheduled.get(OFFER_ID)!.trigger.date.getTime()).toBe(OFFER_AT + 5 * 60_000);
  });

  it('탑승 lock이 붙으면(createLock) 제안이 취소된다', async () => {
    await startTrip();
    await useBoardingLockStore.getState().createLock(lock, true, 'other');
    expect(mockScheduled.has(OFFER_ID)).toBe(false);
  });

  it('trip 종료(runTripBoundCleanups)에서 취소된다 — ACTIVE_TRIP_KEY(tripToken)가 없어도', async () => {
    await startTrip();
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
    await runTripBoundCleanups('backend-confirmed');
    expect(mockScheduled.has(OFFER_ID)).toBe(false);
  });

  it('사용자가 목적지를 해제(setDestination(null))해도 취소된다', async () => {
    await startTrip();
    useDestinationStore.getState().setDestination(null);
    await flush();
    expect(mockScheduled.has(OFFER_ID)).toBe(false);
  });

  it('A-2: lock이 trip 종료 없이 해제되면(환승 release) 지금부터 15분 뒤로 재arm', async () => {
    await startTrip();
    await useBoardingLockStore.getState().createLock(lock, true, 'other');
    jest.setSystemTime(SET_AT + 30 * 60_000);
    await useBoardingLockStore.getState().releaseLock('auto-release-transfer');
    await flush();
    expect(mockScheduled.get(OFFER_ID)!.trigger.date.getTime()).toBe(SET_AT + 45 * 60_000);
  });

  it('A-2 거부: trip 종료로 인한 lock release는 재arm하지 않는다', async () => {
    await startTrip();
    await useBoardingLockStore.getState().createLock(lock, true, 'other');
    await runTripBoundCleanups('backend-confirmed');
    await flush();
    expect(mockScheduled.has(OFFER_ID)).toBe(false);
  });

  it('제안 본문 탭($default)은 trip을 종료하지 않는다 (ADR-014)', async () => {
    await startTrip();
    await handleAlarmEndTripResponse(DEFAULT_TAP, OFFER_DATA);
    await flush();
    expect(useDestinationStore.getState().destination?.id).toBe(YONGMASAN.id);
    expect(await getTripStartedAt()).not.toBeNull();
    expect(mockBreadcrumb).not.toHaveBeenCalledWith('trip', 'end', expect.anything());
  });

  it("[종료] 버튼 → trip 종료 + 종료 사유 'user-end-offer'(기존 'user-end-trip-button'과 구분)", async () => {
    await startTrip();
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tok-1020');
    await handleAlarmEndTripResponse(ALARM_ACTION_END_TRIP, OFFER_DATA);
    await flush();
    expect(useDestinationStore.getState().destination).toBeNull();
    expect(await getTripStartedAt()).toBeNull();
    expect(clearActiveTrip).toHaveBeenCalledWith('tok-1020', 'user-end-offer');
    expect(mockBreadcrumb).toHaveBeenCalledWith('trip', 'end', { reason: 'user-end-offer' });
    expect(mockScheduled.has(OFFER_ID)).toBe(false);
  });

  it("다른 ALARM_CATEGORY 알림의 [종료]는 여전히 'user-end-trip-button' (회귀)", async () => {
    await startTrip();
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tok-1020');
    await handleAlarmEndTripResponse(ALARM_ACTION_END_TRIP, { channel: 'safety-net' });
    await flush();
    expect(clearActiveTrip).toHaveBeenCalledWith('tok-1020', 'user-end-trip-button');
  });
});
