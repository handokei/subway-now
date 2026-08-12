const mockStartLiveActivity = jest.fn();
const mockUpdateLiveActivity = jest.fn();
const mockEndLiveActivity = jest.fn();
const mockAddPushTokenListener = jest.fn();

jest.mock('../../../../../modules/live-activity', () => ({
  startLiveActivity: (...args: unknown[]) => mockStartLiveActivity(...args),
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
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
  ensureLiveActivityRegistered,
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
    mockUpdateLiveActivity.mockReset();
    mockEndLiveActivity.mockReset();
    mockAddPushTokenListener.mockReset();
    mockRegisterLiveActivityToken.mockReset();
    mockClearLiveActivityToken.mockReset();
    mockStartLiveActivity.mockResolvedValue(undefined);
    mockUpdateLiveActivity.mockResolvedValue(undefined);
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

  describe('register retry (#1288)', () => {
    it('register가 status!ok 응답이면 재시도 후 성공', async () => {
      const handle = setupListener();
      mockRegisterLiveActivityToken
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({ ok: true });
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      // 첫 호출이 동기적으로 발사된다
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);
      // 첫 backoff sleep을 진행
      await jest.advanceTimersByTimeAsync(500);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(2);
    });

    it('register가 3회 모두 실패해도 throw 없이 silent log', async () => {
      const handle = setupListener();
      mockRegisterLiveActivityToken.mockResolvedValue({ ok: false, status: 500 });
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      await jest.advanceTimersByTimeAsync(500);
      await jest.advanceTimersByTimeAsync(1000);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(3);
    });

    it('register throw 후 재시도 → 마지막은 성공', async () => {
      const handle = setupListener();
      mockRegisterLiveActivityToken
        .mockRejectedValueOnce(new Error('net'))
        .mockResolvedValueOnce({ ok: true });
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      await jest.advanceTimersByTimeAsync(500);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(2);
    });

    // 회귀 가드: status 없는 실패 응답도 log 분기 처리 (status=none 출력)
    it('register status 미지정 실패 응답도 graceful', async () => {
      const handle = setupListener();
      mockRegisterLiveActivityToken
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true });
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      await jest.advanceTimersByTimeAsync(500);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(2);
    });

    // #1899 — 404 (trip_not_found)는 trip register propagate race. longer backoff(2s)로 흡수.
    // 500ms backoff로 재시도해도 같은 race를 hit하면 retry 효과가 0이라 무의미하다.
    it('register 404 응답 시 2s longer backoff (trip register race)', async () => {
      const handle = setupListener();
      mockRegisterLiveActivityToken
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockResolvedValueOnce({ ok: true });
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      // 첫 호출 동기 발사
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);
      // 500ms로는 재시도 안 됨 (404 backoff는 2s)
      await jest.advanceTimersByTimeAsync(500);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);
      // 2s 도달 후 재시도
      await jest.advanceTimersByTimeAsync(1500);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(2);
    });

    // #1899 — 404가 3회 연속이면 8s까지 backoff 확장. 마지막은 silent log.
    it('register 404 3회 연속 시 2s → 4s exponential backoff 후 포기', async () => {
      const handle = setupListener();
      mockRegisterLiveActivityToken.mockResolvedValue({ ok: false, status: 404 });
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2000);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(4000);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(3);
    });

    // #2310 — trip 종료(cleanup) 후 진행 중이던 backoff 재시도가 그대로 발화하면
    // 이미 사라진 trip에 계속 register POST를 쏴 backend에 404 storm을 만든다.
    // cleanup(teardown) 시 in-flight 재시도 루프도 함께 cancel되어야 한다.
    it('trip cleanup 후 진행 중이던 register 재시도는 발화하지 않음', async () => {
      const handle = setupListener();
      mockRegisterLiveActivityToken.mockResolvedValue({ ok: false, status: 503 });
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      // 첫 호출 동기 발사 — 실패 → 500ms backoff 대기 중
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);

      // backoff 대기 중 trip이 종료됨(cleanup)
      await endLiveActivityWithDeregister('trip-1');

      // 대기하던 backoff가 지나도 재시도가 발화하면 안 된다
      await jest.advanceTimersByTimeAsync(2000);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);
    });

    // 회귀 가드 — throw가 났을 때 lastStatus는 undefined로 reset되어 기본 backoff(500ms) 사용.
    // 404 backoff가 stale하게 다음 throw 시 적용되면 graceful 보장 깨짐.
    it('register throw 후 다음 attempt는 기본 500ms backoff (404 stale 안 됨)', async () => {
      const handle = setupListener();
      mockRegisterLiveActivityToken
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockRejectedValueOnce(new Error('net'))
        .mockResolvedValueOnce({ ok: true });
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      // 첫 404 → 2s 대기
      await jest.advanceTimersByTimeAsync(2000);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(2);
      // 2번째 throw → 기본 1s(500*2) 대기. 1s 후 3번째 발사.
      await jest.advanceTimersByTimeAsync(1000);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(3);
    });
  });

  describe('ensureLiveActivityRegistered (#1288)', () => {
    it('활성 세션 없으면 startLiveActivityWithRegistration 경로 사용', async () => {
      const handle = setupListener();
      await ensureLiveActivityRegistered('trip-1', SAMPLE_DATA);
      expect(mockStartLiveActivity).toHaveBeenCalledWith(SAMPLE_DATA);
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
      handle.emit('tok');
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-1', 'tok');
    });

    it('동일 tripToken으로 재호출 시 native update만 — subscription 보존', async () => {
      const handle = setupListener();
      await ensureLiveActivityRegistered('trip-1', SAMPLE_DATA);
      await ensureLiveActivityRegistered('trip-1', SAMPLE_DATA);
      expect(mockStartLiveActivity).toHaveBeenCalledTimes(1);
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
      handle.emit('tok');
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-1', 'tok');
      expect(handle.remove).not.toHaveBeenCalled();
    });

    it('다른 tripToken으로 호출 시 이전 세션 deregister 후 새 세션 시작', async () => {
      const first = setupListener();
      await ensureLiveActivityRegistered('trip-1', SAMPLE_DATA);
      const second = setupListener();
      await ensureLiveActivityRegistered('trip-2', SAMPLE_DATA);
      expect(mockEndLiveActivity).toHaveBeenCalled();
      expect(mockClearLiveActivityToken).toHaveBeenCalledWith('trip-1');
      expect(first.remove).toHaveBeenCalledTimes(1);
      second.emit('tok');
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-2', 'tok');
    });

    it('이전 세션 deregister가 throw해도 새 세션은 시작', async () => {
      setupListener();
      await ensureLiveActivityRegistered('trip-1', SAMPLE_DATA);
      mockEndLiveActivity.mockRejectedValueOnce(new Error('end failed'));
      const second = setupListener();
      await ensureLiveActivityRegistered('trip-2', SAMPLE_DATA);
      expect(mockStartLiveActivity).toHaveBeenCalledTimes(2);
      second.emit('tok');
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-2', 'tok');
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
