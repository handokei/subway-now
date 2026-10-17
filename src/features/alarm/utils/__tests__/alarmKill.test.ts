jest.mock('expo-notifications', () => ({
  cancelAllScheduledNotificationsAsync: jest.fn(),
  dismissAllNotificationsAsync: jest.fn(),
}));
jest.mock('../alarmSound', () => ({
  stopVibration: jest.fn(),
}));

import * as Notifications from 'expo-notifications';
import { stopVibration } from '../alarmSound';
import { killAllAlarms } from '../alarmKill';

const mockedCancelAll = Notifications.cancelAllScheduledNotificationsAsync as jest.Mock;
const mockedDismissAll = Notifications.dismissAllNotificationsAsync as jest.Mock;
const mockedStopVib = stopVibration as jest.Mock;

describe('killAllAlarms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCancelAll.mockResolvedValue(undefined);
    mockedDismissAll.mockResolvedValue(undefined);
  });

  it('진동 중단 + dismissAll + cancelAllScheduled 모두 호출', async () => {
    await killAllAlarms();
    expect(mockedStopVib).toHaveBeenCalledTimes(1);
    expect(mockedDismissAll).toHaveBeenCalledTimes(1);
    expect(mockedCancelAll).toHaveBeenCalledTimes(1);
  });

  it('stopVibration 실패해도 나머지 단계 계속', async () => {
    mockedStopVib.mockImplementationOnce(() => {
      throw new Error('vibrate-fail');
    });
    await killAllAlarms();
    expect(mockedDismissAll).toHaveBeenCalledTimes(1);
    expect(mockedCancelAll).toHaveBeenCalledTimes(1);
  });

  it('dismissAll 실패해도 cancelAll은 호출', async () => {
    mockedDismissAll.mockRejectedValueOnce(new Error('dismiss-fail'));
    await killAllAlarms();
    expect(mockedCancelAll).toHaveBeenCalledTimes(1);
  });

  it('cancelAll 실패 — graceful (예외 propagate 안 함)', async () => {
    mockedCancelAll.mockRejectedValueOnce(new Error('cancel-fail'));
    await expect(killAllAlarms()).resolves.toBeUndefined();
  });
});
