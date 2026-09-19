import * as Notifications from 'expo-notifications';
import { renderHook } from '@testing-library/react-native';
import {
  handleAlarmEndTripResponse,
  useAlarmEndTripResponder,
} from '../useAlarmEndTripResponder';
import { ALARM_ACTION_ACKNOWLEDGE, ALARM_ACTION_END_TRIP } from '../../utils/notificationCategory';

jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(),
  DEFAULT_ACTION_IDENTIFIER: '$default',
}));

const mockGetTripStartedAt = jest.fn<Promise<number | null>, []>();
jest.mock('../../utils/tripStartStorage', () => ({
  getTripStartedAt: () => mockGetTripStartedAt(),
}));

const mockCleanupUserInitiatedEndedTrip = jest.fn<Promise<void>, [number]>();
jest.mock('../../utils/tripEndedCleanupSequence', () => ({
  cleanupUserInitiatedEndedTrip: (...args: [number]) =>
    mockCleanupUserInitiatedEndedTrip(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('handleAlarmEndTripResponse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ALARM_ACTION_END_TRIP 이외의 액션은 무시 (cleanup 미호출)', async () => {
    await handleAlarmEndTripResponse(ALARM_ACTION_ACKNOWLEDGE);
    expect(mockGetTripStartedAt).not.toHaveBeenCalled();
    expect(mockCleanupUserInitiatedEndedTrip).not.toHaveBeenCalled();
  });

  it('$default(배너 탭) 등 임의 문자열도 무시', async () => {
    await handleAlarmEndTripResponse('$default');
    expect(mockCleanupUserInitiatedEndedTrip).not.toHaveBeenCalled();
  });

  it('ALARM_ACTION_END_TRIP + 활성 trip 없음 → no-op (cleanup 미호출)', async () => {
    mockGetTripStartedAt.mockResolvedValue(null);

    await handleAlarmEndTripResponse(ALARM_ACTION_END_TRIP);

    expect(mockGetTripStartedAt).toHaveBeenCalled();
    expect(mockCleanupUserInitiatedEndedTrip).not.toHaveBeenCalled();
  });

  it('ALARM_ACTION_END_TRIP + 활성 trip 있음 → cleanupUserInitiatedEndedTrip 호출', async () => {
    mockGetTripStartedAt.mockResolvedValue(1_700_000_000_000);
    const now = 1_700_000_500_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await handleAlarmEndTripResponse(ALARM_ACTION_END_TRIP);

    expect(mockCleanupUserInitiatedEndedTrip).toHaveBeenCalledWith(now);

    (Date.now as jest.Mock).mockRestore();
  });
});

describe('useAlarmEndTripResponder hook wiring', () => {
  let registeredHandler: ((response: any) => void) | null = null;
  const subscriptionRemove = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    registeredHandler = null;
    (Notifications.addNotificationResponseReceivedListener as jest.Mock).mockImplementation(
      (handler) => {
        registeredHandler = handler;
        return { remove: subscriptionRemove };
      },
    );
  });

  it('마운트 시 listener 1회 등록', () => {
    renderHook(() => useAlarmEndTripResponder());
    expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
    expect(registeredHandler).not.toBeNull();
  });

  it('unmount 시 subscription remove', () => {
    const { unmount } = renderHook(() => useAlarmEndTripResponder());
    unmount();
    expect(subscriptionRemove).toHaveBeenCalled();
  });

  it('ALARM_ACTION_END_TRIP 응답 수신 시 cleanup 발화', async () => {
    mockGetTripStartedAt.mockResolvedValue(1_700_000_000_000);
    renderHook(() => useAlarmEndTripResponder());

    registeredHandler!({ actionIdentifier: ALARM_ACTION_END_TRIP });
    await new Promise((r) => setTimeout(r, 0));

    expect(mockCleanupUserInitiatedEndedTrip).toHaveBeenCalled();
  });

  it('다른 액션 응답은 cleanup 미발화', async () => {
    renderHook(() => useAlarmEndTripResponder());

    registeredHandler!({ actionIdentifier: ALARM_ACTION_ACKNOWLEDGE });
    await new Promise((r) => setTimeout(r, 0));

    expect(mockCleanupUserInitiatedEndedTrip).not.toHaveBeenCalled();
  });
});
