const mockStartLiveActivity = jest.fn();
const mockEndLiveActivity = jest.fn();
const mockAddPushTokenListener = jest.fn();

jest.mock('../../../modules/live-activity', () => ({
  startLiveActivity: (...args: unknown[]) => mockStartLiveActivity(...args),
  endLiveActivity: () => mockEndLiveActivity(),
  addPushTokenListener: (...args: unknown[]) =>
    mockAddPushTokenListener(...args),
}));

const mockRegisterLiveActivityToken = jest.fn();
const mockClearLiveActivityToken = jest.fn();

jest.mock('../../api/alarmBackend', () => ({
  registerLiveActivityToken: (...args: unknown[]) =>
    mockRegisterLiveActivityToken(...args),
  clearLiveActivityToken: (...args: unknown[]) =>
    mockClearLiveActivityToken(...args),
}));

import {
  endLiveActivityWithDeregister,
  startLiveActivityWithRegistration,
} from '../liveActivityPushChannel';

type TokenListener = (e: { token: string }) => void;

interface ListenerHandle {
  emit: (token: string) => void;
  remove: jest.Mock;
}

function setupListener(): ListenerHandle {
  const handle: ListenerHandle = {
    emit: () => undefined,
    remove: jest.fn(),
  };
  mockAddPushTokenListener.mockImplementation((cb: TokenListener) => {
    handle.emit = (token: string) => cb({ token });
    return { remove: handle.remove };
  });
  return handle;
}

const SAMPLE_DATA = {
  stationName: '강남',
  lineName: '2호선',
  lineColorHex: '#00A84D',
  distanceM: 0,
};

describe('liveActivityPushChannel', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockStartLiveActivity.mockReset();
    mockEndLiveActivity.mockReset();
    mockAddPushTokenListener.mockReset();
    mockRegisterLiveActivityToken.mockReset();
    mockClearLiveActivityToken.mockReset();
    mockStartLiveActivity.mockResolvedValue(undefined);
    mockEndLiveActivity.mockResolvedValue(undefined);
    mockRegisterLiveActivityToken.mockResolvedValue({ ok: true });
    mockClearLiveActivityToken.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('startLiveActivityWithRegistration', () => {
    it('start 호출 후 token emit 시 backend register', async () => {
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      expect(mockStartLiveActivity).toHaveBeenCalledWith(SAMPLE_DATA);
      handle.emit('aabbcc');
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-1', 'aabbcc');
      expect(handle.remove).toHaveBeenCalledTimes(1);
    });

    it('5s timeout 안에 token이 안 오면 subscription 정리 + register 미호출', async () => {
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      jest.advanceTimersByTime(5000);
      expect(handle.remove).toHaveBeenCalledTimes(1);
      expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();
    });

    it('token 도착 후 timer는 clearTimeout으로 cancel — 추가 register 없음', async () => {
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      jest.advanceTimersByTime(5000);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);
    });

    it('register fetch가 reject해도 throw하지 않음 (silent log)', async () => {
      const handle = setupListener();
      mockRegisterLiveActivityToken.mockRejectedValue(new Error('net'));
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      // promise rejection이 unhandled 되지 않도록 microtask 비움
      await Promise.resolve();
    });

    it('startLiveActivity가 throw하면 subscription/timer 정리 후 re-throw', async () => {
      const handle = setupListener();
      mockStartLiveActivity.mockRejectedValue(new Error('LA disabled'));
      await expect(
        startLiveActivityWithRegistration('trip-1', SAMPLE_DATA),
      ).rejects.toThrow('LA disabled');
      expect(handle.remove).toHaveBeenCalledTimes(1);
    });
  });

  describe('endLiveActivityWithDeregister', () => {
    it('end 호출 + backend DELETE', async () => {
      await endLiveActivityWithDeregister('trip-1');
      expect(mockEndLiveActivity).toHaveBeenCalled();
      expect(mockClearLiveActivityToken).toHaveBeenCalledWith('trip-1');
    });

    it('end가 throw해도 backend deregister는 시도', async () => {
      mockEndLiveActivity.mockRejectedValue(new Error('end failed'));
      await expect(endLiveActivityWithDeregister('trip-1')).rejects.toThrow(
        'end failed',
      );
      expect(mockClearLiveActivityToken).toHaveBeenCalledWith('trip-1');
    });

    it('clear fetch가 reject해도 throw하지 않음 (silent log)', async () => {
      mockClearLiveActivityToken.mockRejectedValue(new Error('net'));
      await endLiveActivityWithDeregister('trip-1');
      expect(mockEndLiveActivity).toHaveBeenCalled();
    });
  });
});
