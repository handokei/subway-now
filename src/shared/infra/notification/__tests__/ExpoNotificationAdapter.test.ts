import { expoNotificationAdapter } from '../ExpoNotificationAdapter';
import * as Notifications from 'expo-notifications';

jest.mock('expo-notifications', () => ({
  dismissNotificationAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

const dismissMock = Notifications.dismissNotificationAsync as jest.Mock;
const scheduleMock = Notifications.scheduleNotificationAsync as jest.Mock;
const requestMock = Notifications.requestPermissionsAsync as jest.Mock;

beforeEach(() => {
  dismissMock.mockReset();
  scheduleMock.mockReset();
  requestMock.mockReset();
});

describe('ExpoNotificationAdapter.scheduleImmediate', () => {
  it('기존 알림 dismiss 실패해도 새 알림은 예약된다', async () => {
    dismissMock.mockRejectedValueOnce(new Error('not found'));
    scheduleMock.mockResolvedValueOnce(undefined);

    await expoNotificationAdapter.scheduleImmediate({
      id: 'alarm-1',
      title: 'T',
      body: 'B',
    });

    expect(dismissMock).toHaveBeenCalledWith('alarm-1');
    expect(scheduleMock).toHaveBeenCalledWith({
      identifier: 'alarm-1',
      content: {
        title: 'T',
        body: 'B',
        sound: undefined,
      },
      trigger: null,
    });
  });

  it('iOS interruptionLevel과 Android channelId를 content에 포함시킨다', async () => {
    dismissMock.mockResolvedValueOnce(undefined);
    scheduleMock.mockResolvedValueOnce(undefined);

    await expoNotificationAdapter.scheduleImmediate({
      id: 'alarm-2',
      title: 'T2',
      body: 'B2',
      sound: 'alarm.wav',
      interruptionLevel: 'timeSensitive',
      channelId: 'station-alarm',
    });

    expect(scheduleMock).toHaveBeenCalledWith({
      identifier: 'alarm-2',
      content: {
        title: 'T2',
        body: 'B2',
        sound: 'alarm.wav',
        interruptionLevel: 'timeSensitive',
        channelId: 'station-alarm',
      },
      trigger: null,
    });
  });
});

describe('ExpoNotificationAdapter.dismiss', () => {
  it('id를 그대로 expo-notifications에 위임한다', async () => {
    dismissMock.mockResolvedValueOnce(undefined);
    await expoNotificationAdapter.dismiss('alarm-X');
    expect(dismissMock).toHaveBeenCalledWith('alarm-X');
  });
});

describe('ExpoNotificationAdapter.requestPermissions', () => {
  it('status granted이면 granted=true', async () => {
    requestMock.mockResolvedValueOnce({ status: 'granted' });
    const result = await expoNotificationAdapter.requestPermissions();
    expect(result).toEqual({ granted: true });
    expect(requestMock).toHaveBeenCalledWith({
      ios: { allowAlert: true, allowSound: true, allowCriticalAlerts: true },
    });
  });

  it('status가 granted가 아니면 granted=false', async () => {
    requestMock.mockResolvedValueOnce({ status: 'denied' });
    const result = await expoNotificationAdapter.requestPermissions();
    expect(result).toEqual({ granted: false });
  });
});
