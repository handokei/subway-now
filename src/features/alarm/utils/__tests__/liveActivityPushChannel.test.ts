const mockStartLiveActivity = jest.fn();
const mockEndLiveActivity = jest.fn();
const mockAddPushTokenListener = jest.fn();

jest.mock('../../../../../modules/live-activity', () => ({
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
  __resetLiveActivityPushChannelForTests,
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
    __resetLiveActivityPushChannelForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
    __resetLiveActivityPushChannelForTests();
  });

  describe('startLiveActivityWithRegistration', () => {
    it('start 호출 후 token emit 시 backend register', async () => {
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      expect(mockStartLiveActivity).toHaveBeenCalledWith(SAMPLE_DATA);
      handle.emit('aabbcc');
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-1', 'aabbcc');
    });

    it('subscription은 첫 token 이후에도 유지 — 새 token 회전 시 재등록', async () => {
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok-a');
      handle.emit('tok-b');
      expect(mockRegisterLiveActivityToken).toHaveBeenNthCalledWith(1, 'trip-1', 'tok-a');
      expect(mockRegisterLiveActivityToken).toHaveBeenNthCalledWith(2, 'trip-1', 'tok-b');
      expect(handle.remove).not.toHaveBeenCalled();
    });

    it('동일 token 재emit은 dedup — backend 재호출 없음', async () => {
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok-a');
      handle.emit('tok-a');
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);
    });

    it('5s timeout 안에 token이 안 와도 subscription은 유지 (로그만)', async () => {
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      jest.advanceTimersByTime(5000);
      expect(handle.remove).not.toHaveBeenCalled();
      expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();
      // 늦게라도 token이 오면 그제서야 register
      handle.emit('late');
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-1', 'late');
    });

    it('token 도착 후 timer는 정리 — 이후 advanceTimers 영향 없음', async () => {
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

    it('start가 await 중 다른 호출이 activeTeardown을 교체했고, 이후 throw 시 새 세션을 건드리지 않음', async () => {
      // 첫 start가 await에 걸려 있는 동안 두 번째 start가 들어오는 시나리오.
      let resolveFirst!: () => void;
      let rejectFirst!: (e: Error) => void;
      mockStartLiveActivity.mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            resolveFirst = resolve;
            rejectFirst = reject;
          }),
      );
      mockStartLiveActivity.mockResolvedValueOnce(undefined);

      const first = setupListener();
      const firstPromise = startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      // 두 번째 호출 — 기존 teardown을 교체
      const second = setupListener();
      await startLiveActivityWithRegistration('trip-2', SAMPLE_DATA);
      expect(first.remove).toHaveBeenCalledTimes(1);

      // 이제 첫 호출의 start가 throw — 두 번째 세션을 건드리지 않아야 한다
      rejectFirst(new Error('first failed'));
      void resolveFirst; // unused but captured for symmetry
      await expect(firstPromise).rejects.toThrow('first failed');

      // 두 번째 세션은 여전히 살아 있어야 함
      second.emit('tok-2');
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-2', 'tok-2');
      expect(second.remove).not.toHaveBeenCalled();
    });

    it('이전 세션이 살아 있는 상태로 재호출하면 이전 subscription 정리', async () => {
      const first = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      const second = setupListener();
      await startLiveActivityWithRegistration('trip-2', SAMPLE_DATA);
      expect(first.remove).toHaveBeenCalledTimes(1);
      second.emit('tok');
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-2', 'tok');
    });
  });

  describe('endLiveActivityWithDeregister', () => {
    it('end 호출 + backend DELETE + 활성 subscription 정리', async () => {
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      await endLiveActivityWithDeregister('trip-1');
      expect(mockEndLiveActivity).toHaveBeenCalled();
      expect(mockClearLiveActivityToken).toHaveBeenCalledWith('trip-1');
      expect(handle.remove).toHaveBeenCalledTimes(1);
    });

    it('활성 세션이 없을 때도 end + clear 호출', async () => {
      await endLiveActivityWithDeregister('trip-x');
      expect(mockEndLiveActivity).toHaveBeenCalled();
      expect(mockClearLiveActivityToken).toHaveBeenCalledWith('trip-x');
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

  describe('__resetLiveActivityPushChannelForTests', () => {
    it('활성 세션 정리', async () => {
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      __resetLiveActivityPushChannelForTests();
      expect(handle.remove).toHaveBeenCalledTimes(1);
    });

    it('활성 세션이 없을 때도 안전하게 no-op', () => {
      expect(() => __resetLiveActivityPushChannelForTests()).not.toThrow();
    });
  });
});
