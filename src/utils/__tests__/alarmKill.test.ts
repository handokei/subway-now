jest.mock('expo-notifications', () => ({
  cancelAllScheduledNotificationsAsync: jest.fn(),
  dismissAllNotificationsAsync: jest.fn(),
}));
jest.mock('../alarmSound', () => ({
  stopVibration: jest.fn(),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { stopVibration } from '../alarmSound';
import { isAlarmsKilled, killAllAlarms } from '../alarmKill';

const mockedCancelAll = Notifications.cancelAllScheduledNotificationsAsync as jest.Mock;
const mockedDismissAll = Notifications.dismissAllNotificationsAsync as jest.Mock;
const mockedStopVib = stopVibration as jest.Mock;
const mockedGetItem = AsyncStorage.getItem as jest.Mock;

describe('alarmKill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCancelAll.mockResolvedValue(undefined);
    mockedDismissAll.mockResolvedValue(undefined);
  });

  describe('killAllAlarms', () => {
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

  describe('isAlarmsKilled', () => {
    it('AsyncStorage true 저장 → true (#623 P0-2 BG-safe)', async () => {
      mockedGetItem.mockResolvedValueOnce(JSON.stringify(true));
      await expect(isAlarmsKilled()).resolves.toBe(true);
    });

    it('AsyncStorage false 저장 → false', async () => {
      mockedGetItem.mockResolvedValueOnce(JSON.stringify(false));
      await expect(isAlarmsKilled()).resolves.toBe(false);
    });

    it('AsyncStorage 비어있으면 false (default)', async () => {
      mockedGetItem.mockResolvedValueOnce(null);
      await expect(isAlarmsKilled()).resolves.toBe(false);
    });

    it('AsyncStorage 오류 시 false (fail-open으로 일관성 유지)', async () => {
      mockedGetItem.mockRejectedValueOnce(new Error('storage'));
      await expect(isAlarmsKilled()).resolves.toBe(false);
    });

    it('JSON 파싱 실패도 false', async () => {
      mockedGetItem.mockResolvedValueOnce('not-json{');
      await expect(isAlarmsKilled()).resolves.toBe(false);
    });
  });
});
