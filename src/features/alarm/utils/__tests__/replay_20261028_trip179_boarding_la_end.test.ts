/* eslint-disable import/no-restricted-paths --
 * Cross-feature whole-chain replay: 응답 handler(hooks) -> lock primitive(store) -> 탑승 채널(utils) ->
 * 여정 채널을 한 테스트에서 연결한다. 대상 모듈들과 동일 사유로 옵트인.
 */
/**
 * #3221 PR-4 replay — 2026-10-28 trip 179 응답 시퀀스를 탑승 LA 종료 경로에 재생한다.
 *
 * fixture 시각은 실측이고 불변이다(통과시키려고 조정하지 않는다): `fixtures/replayLibrary/capture_20261028_trip179_*`
 * 의 응답 행 06:27:55 boarded / 06:36:51 not-boarded / 06:42:21 sync lock (plan #3221 F24, rca-2026-10-28-ride.md §1).
 *
 * 증명하는 것(부품이 아니라 whole):
 *   - 응답 3건 각각이 **실제** lock primitive / 응답 handler를 거쳐 `LiveActivity.endBoardingActivities`(마지막 소비자)에
 *     도달한다 — 총 3회.
 *   - 같은 구간에서 여정 LA는 종료되지 않고 여정 token 등록은 1회뿐이다(탑승 end가 여정 채널에 새지 않는다).
 */
const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItem: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
  removeItem: jest.fn(async (k: string) => {
    mockStore.delete(k);
  }),
}));

const mockEndBoardingActivities = jest.fn().mockResolvedValue(undefined);
const mockEndLiveActivity = jest.fn().mockResolvedValue(undefined);
const mockAddPushTokenListener = jest.fn();
const mockAddBoardingTokenListener = jest.fn();
function mockLiveActivityFactory() {
  return {
    isLiveActivityEnabled: () => true,
    startLiveActivity: jest.fn().mockResolvedValue(undefined),
    updateLiveActivity: jest.fn().mockResolvedValue(undefined),
    endLiveActivity: (...args: unknown[]) => mockEndLiveActivity(...args),
    hasActiveLiveActivity: () => true,
    requestLiveActivityPushToken: async () => null,
    addPushTokenListener: (...args: unknown[]) => mockAddPushTokenListener(...args),
    endBoardingActivities: (...args: unknown[]) => mockEndBoardingActivities(...args),
    addBoardingPushToStartTokenListener: (...args: unknown[]) => mockAddBoardingTokenListener(...args),
    requestBoardingPushToStartToken: async () => null,
    startBoardingActivity: jest.fn().mockResolvedValue(undefined),
  };
}
jest.mock('live-activity', () => mockLiveActivityFactory());
jest.mock('../../../../../modules/live-activity', () => mockLiveActivityFactory());

const mockRegisterLiveActivityToken = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../api/alarmBackend', () => ({
  registerLiveActivityToken: (...args: unknown[]) => mockRegisterLiveActivityToken(...args),
  clearLiveActivityToken: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../stationNotification', () => ({
  buildLiveActivityData: () => ({ stationName: 'STN', lineName: 'L', lineColorHex: '#000', distanceM: 0 }),
}));

jest.mock('../boardingLockStorage', () => ({
  getBoardingLock: jest.fn(),
  setBoardingLock: jest.fn().mockResolvedValue(undefined),
  clearBoardingLock: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../dismissSilenceStorage', () => ({
  clearDismissSilence: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: jest.fn(),
}));
jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
  DEFAULT_ACTION_IDENTIFIER: '$default',
}));
const mockDismissBoardingPrompt = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../nearest-station/api/positionUpload', () => ({
  dismissBoardingPrompt: (...args: unknown[]) => mockDismissBoardingPrompt(...args),
  postBoardingConfirm: jest.fn(),
}));

import { Platform } from 'react-native';
import {
  __resetLiveActivityPushChannelForTests,
  startLiveActivityWithRegistration,
} from '../liveActivityPushChannel';
import { handleResponse } from '../../hooks/useBoardingPromptResponder';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import { BOARDING_PROMPT_ACTION_NOT_BOARDED } from '../notificationCategory';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

const kst = (hms: string): number => new Date(`2026-10-28T${hms}+09:00`).getTime();

// --- 실측 fixture (불변) -------------------------------------------------------------------------
const TRIP_179_LA_START = '06:26:46';
const TRIP_179_BOARDED_RESPONSE = '06:27:55';
const TRIP_179_NOT_BOARDED_RESPONSE = '06:36:51';
const TRIP_179_SYNC_LOCK = '06:42:21';
// -----------------------------------------------------------------------------------------------

const lockAt = (at: number, trainCode: string): BoardingLock => ({
  destinationId: '0228',
  trainCode,
  boardingStationId: '0328',
  boardingLine: '7',
  boardedAt: at,
  expectedDurationMs: 600_000,
});

describe('replay 20261028 trip 179 — 응답 시퀀스가 탑승 LA를 닫는다 (#3221 PR-4)', () => {
  const originalOs = Platform.OS;

  beforeEach(() => {
    jest.useFakeTimers();
    mockStore.clear();
    jest.clearAllMocks();
    __resetLiveActivityPushChannelForTests();
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    Object.defineProperty(Platform, 'Version', { value: '17.4', configurable: true });
    useBoardingLockStore.setState({ lock: null });
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  });

  it('boarded / not-boarded / sync lock 3건 -> 탑승 end 3회, 여정 end 0회, 여정 token 등록 1회', async () => {
    // 06:26:46 여정 LA 시작 + ambient token 1회 등록(실제 채널).
    jest.setSystemTime(kst(TRIP_179_LA_START));
    let emit: (token: string) => void = () => undefined;
    mockAddPushTokenListener.mockImplementation((cb: (e: { token: string }) => void) => {
      emit = (token) => cb({ token });
      return { remove: jest.fn() };
    });
    await startLiveActivityWithRegistration('apns-trip-179', {
      stationName: '중곡',
      lineName: '7호선',
      lineColorHex: '#747F00',
      distanceM: 0,
    });
    emit('journey-la-token');
    await jest.advanceTimersByTimeAsync(0);
    expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);

    // 06:27:55 [탑승] 응답 -> lock primitive.
    jest.setSystemTime(kst(TRIP_179_BOARDED_RESPONSE));
    await useBoardingLockStore.getState().createLock(lockAt(Date.now(), '7123'), false, 'boarding-prompt-response');
    expect(mockEndBoardingActivities).toHaveBeenCalledTimes(1);

    // 06:36:51 [미탑승] 응답 -> 응답 handler.
    jest.setSystemTime(kst(TRIP_179_NOT_BOARDED_RESPONSE));
    await handleResponse(
      BOARDING_PROMPT_ACTION_NOT_BOARDED,
      { kind: 'boarding-prompt', originStation: '중곡', line: '7', tripToken: 'apns-trip-179', destinationDirection: 'up' },
      {
        fetchArrivalsForStation: jest.fn(),
        destinationId: '0228',
        expectedDurationMs: 600_000,
        createLock: useBoardingLockStore.getState().createLock,
      },
    );
    expect(mockDismissBoardingPrompt).toHaveBeenCalledWith('apns-trip-179');
    expect(mockEndBoardingActivities).toHaveBeenCalledTimes(2);

    // 06:42:21 sync lock -> lock primitive 재진입.
    jest.setSystemTime(kst(TRIP_179_SYNC_LOCK));
    await useBoardingLockStore.getState().createLock(lockAt(Date.now(), '7456'), false, 'other');

    expect(mockEndBoardingActivities).toHaveBeenCalledTimes(3);
    // 탑승 end가 여정 채널로 새지 않는다.
    expect(mockEndLiveActivity).not.toHaveBeenCalled();
    expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);
    // ambient listener는 여정 이벤트만 구독한다 — 탑승 push-to-start token은 여정 trip에 등록되지 않는다.
    expect(mockAddBoardingTokenListener).not.toHaveBeenCalled();
  });
});
