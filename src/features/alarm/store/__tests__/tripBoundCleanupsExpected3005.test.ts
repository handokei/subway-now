/**
 * #3005 PR-A — runTripBoundCleanups(expected): 정리는 "등록 시점에 캡처한 trip"에만 적용된다.
 * 시나리오(S1·S2)는 route/store/__tests__/tripEndCleanup3005.scenarios.test.ts, 여기는 분기 단위 계약.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { runTripBoundCleanups, __resetDefensiveCancelForTest } from '../tripBoundCleanups';
import { ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';
import { setTripCorrId, __resetTripCorrIdForTests__ } from '../../../observability/utils/tripCorrId';
import { useNavigationStore } from '../../../route/store/useNavigationStore';
import { useUserIntentStore } from '../useUserIntentStore';
import * as alarmBackend from '../../api/alarmBackend';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-notifications');
jest.mock('live-activity', () => ({ endLiveActivity: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../widget/api/widgetStorage', () => ({
  clearWidgetStation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../utils/liveActivityPushChannel', () => ({
  resetLiveActivityChannelAfterExternalEnd: jest.fn().mockResolvedValue(undefined),
}));
const mockCancelSafetyNet = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/safetyNetScheduler', () => ({
  ...jest.requireActual('../../utils/safetyNetScheduler'),
  cancelAllSafetyNetAlarms: (...a: unknown[]) => mockCancelSafetyNet(...a),
}));
const mockCancelPrescheduled = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/stationPrescheduler', () => ({
  ...jest.requireActual('../../utils/stationPrescheduler'),
  cancelAllPrescheduledAlarms: (...a: unknown[]) => mockCancelPrescheduled(...a),
}));

const TOKEN = 'apns-token';
let clearSpy: jest.SpyInstance;

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  __resetDefensiveCancelForTest();
  __resetTripCorrIdForTests__();
  clearSpy = jest.spyOn(alarmBackend, 'clearActiveTrip').mockResolvedValue({ ok: true, status: 200 });
  useNavigationStore.setState({ navigationActive: true });
  useUserIntentStore.setState({ trackingOptIn: true, promptOptIn: true });
});

afterEach(() => {
  __resetDefensiveCancelForTest();
  clearSpy.mockRestore();
});

describe('runTripBoundCleanups expected (#3005)', () => {
  it('같은 trip(corrId 일치): 신원 묶인 항목을 모두 정리하고 DELETE에 corrId를 싣는다', async () => {
    await setTripCorrId('corr-1');
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, TOKEN);

    await runTripBoundCleanups('user-clear', { expected: { corrId: 'corr-1', activeTripToken: TOKEN } });

    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
    expect(useNavigationStore.getState().navigationActive).toBe(false);
    expect(useUserIntentStore.getState().trackingOptIn).toBe(false);
    expect(clearSpy).toHaveBeenCalledWith(TOKEN, 'user-clear', 'corr-1');
    expect(mockCancelSafetyNet).toHaveBeenCalledWith(TOKEN);
  });

  it('같은 trip이지만 캡처 corrId가 없으면 DELETE는 corrId 없이 기존 형태로 나간다', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, TOKEN);

    await runTripBoundCleanups('user-clear', { expected: { corrId: null, activeTripToken: TOKEN } });

    expect(clearSpy).toHaveBeenCalledWith(TOKEN, 'user-clear');
  });

  it('다른 trip(corrId 불일치, 같은 token): ACTIVE_TRIP·opt-in·navigationActive·OS 예약은 건드리지 않고, DELETE만 corrId와 함께 보낸다', async () => {
    await setTripCorrId('corr-NEW');
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, TOKEN);

    await runTripBoundCleanups('destination-switch', {
      expected: { corrId: 'corr-OLD', activeTripToken: TOKEN },
    });

    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBe(TOKEN);
    expect(useNavigationStore.getState().navigationActive).toBe(true);
    expect(useUserIntentStore.getState().trackingOptIn).toBe(true);
    expect(useUserIntentStore.getState().promptOptIn).toBe(true);
    expect(mockCancelSafetyNet).not.toHaveBeenCalled();
    expect(mockCancelPrescheduled).not.toHaveBeenCalled();
    // 같은 token이라 backend가 corrId로 판정한다.
    expect(clearSpy).toHaveBeenCalledWith(TOKEN, 'destination-switch', 'corr-OLD');
  });

  it('다른 trip(corrId·token 모두 불일치): DELETE 0회, 캡처한 옛 token의 예약만 취소한다', async () => {
    await setTripCorrId('corr-NEW');
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'token-NEW');

    await runTripBoundCleanups('destination-switch', {
      expected: { corrId: 'corr-OLD', activeTripToken: 'token-OLD' },
    });

    expect(clearSpy).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBe('token-NEW');
    expect(mockCancelSafetyNet).toHaveBeenCalledWith('token-OLD');
    expect(mockCancelSafetyNet).not.toHaveBeenCalledWith('token-NEW');
  });

  it('expected 생략: 기존 동작(무조건 정리)', async () => {
    await setTripCorrId('corr-1');
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, TOKEN);

    await runTripBoundCleanups('user-clear');

    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
    expect(clearSpy).toHaveBeenCalledWith(TOKEN, 'user-clear');
  });
});
