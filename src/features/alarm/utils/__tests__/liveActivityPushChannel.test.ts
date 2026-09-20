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

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
}));

const mockRegisterLiveActivityToken = jest.fn();
const mockClearLiveActivityToken = jest.fn();

jest.mock('../../api/alarmBackend', () => ({
  registerLiveActivityToken: (...args: unknown[]) =>
    mockRegisterLiveActivityToken(...args),
  clearLiveActivityToken: (...args: unknown[]) =>
    mockClearLiveActivityToken(...args),
}));

// #2735 — 계측 dedup 검증을 위해 logLiveActivityAuthorityState만 spy 가능하게 mock한다.
// logLiveActivityUpdated는 다른 describe 블록에서 실호출 경로로 이미 검증되던 것과 동일하게
// no-op으로 유지(호출 여부를 검증하지 않는 기존 테스트에 영향 없음).
const mockLogLiveActivityAuthorityState = jest.fn();
jest.mock('../alarmLog', () => ({
  logLiveActivityAuthorityState: (...args: unknown[]) =>
    mockLogLiveActivityAuthorityState(...args),
  logLiveActivityUpdated: jest.fn(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  __resetLiveActivityPushChannelForTests,
  endLiveActivityWithDeregister,
  ensureLiveActivityRegistered,
  registerHeldLiveActivityTokenForCurrentTrip,
  shouldSkipDeviceLiveActivityWrite,
  startAmbientLiveActivityTokenRegistration,
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
    mockLogLiveActivityAuthorityState.mockReset();
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

    // #2310 — 마지막(3번째) attempt가 진행 중일 때 trip이 종료되면, 그 attempt의
    // 네트워크 응답이 돌아온 시점엔 이미 session.cancelled=true다. 이 경우 루프는
    // attempt 3까지 이미 소진했으므로 loop-start cancel 체크(attempt 1~3 진입 시)는
    // 전부 통과하고, "재시도 소진 — giving up" 로그만 스킵해야 한다(종료된 trip에
    // 대한 불필요한 warn 로그 방지).
    it('마지막 attempt 처리 중 trip cleanup되면 exhausted 로그 없이 조용히 종료', async () => {
      const handle = setupListener();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      let callCount = 0;
      mockRegisterLiveActivityToken.mockImplementation(async () => {
        callCount += 1;
        if (callCount === 3) {
          // 3번째 attempt가 backend 응답을 기다리는 동안 trip이 종료됨(teardown).
          void endLiveActivityWithDeregister('trip-1');
        }
        return { ok: false, status: 503 };
      });
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(500);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1000);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(3);

      // trip cleanup(endLiveActivityWithDeregister)이 완료됨 — subscription/backend 정리.
      expect(handle.remove).toHaveBeenCalledTimes(1);
      expect(mockClearLiveActivityToken).toHaveBeenCalledWith('trip-1');
      // "재시도 소진 — giving up" 로그는 남기지 않는다 (cancelled 세션이라 이미 정리됨).
      expect(
        warnSpy.mock.calls.some((call) =>
          call.some(
            (arg) => typeof arg === 'string' && arg.includes('exhausted retries'),
          ),
        ),
      ).toBe(false);
      warnSpy.mockRestore();
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

  // #2481 (backend-authority device 쓰기 억제 게이트, Wave 2) → #2735 (권위 이양 조건 수정) —
  // device W2/W3 두 writer가 공유하는 판정 함수 단독 검증. flag는
  // EXPO_PUBLIC_MINIMAL_ALARM(isMinimalAlarmEnabled SSoT)로 제어한다.
  describe('shouldSkipDeviceLiveActivityWrite (#2481, #2735)', () => {
    const originalFlag = process.env.EXPO_PUBLIC_MINIMAL_ALARM;

    afterEach(() => {
      if (originalFlag === undefined) {
        delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;
      } else {
        process.env.EXPO_PUBLIC_MINIMAL_ALARM = originalFlag;
      }
    });

    // #2735 RED — 이 테스트가 수정 전 코드(activeTripToken 기준)에서는 실패했다: 세션이
    // "시작"만 됐을 뿐 backend register 응답이 아직 안 왔는데도 구 코드는 activeTripToken을
    // 세션 시작 시점에 즉시 세팅해 스킵(true)을 반환했다 — device도 backend도 안 쓰는 구간의
    // 근본 원인. PR 본문에 이 테스트의 실패 로그(수정 전)를 첨부한다.
    it('세션 시작 직후, backend register 응답이 아직 안 왔으면 false(device가 계속 쓴다) — RED였던 케이스', async () => {
      delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;
      // register가 절대 resolve되지 않는 상황(응답 대기 중)을 흉내— 세션은 시작됐지만 확인 전.
      mockRegisterLiveActivityToken.mockImplementation(() => new Promise(() => undefined));
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      expect(shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(false);
    });

    // #2735 GREEN — registerWithRetry가 3회 모두 실패해 재시도를 소진해도 device는 계속 쓴다.
    it('backend register가 재시도 끝에 완전히 실패하면 false(device가 계속 쓴다) — LA freeze 방지', async () => {
      delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;
      mockRegisterLiveActivityToken.mockResolvedValue({ ok: false, status: 500 });
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      await jest.advanceTimersByTimeAsync(500);
      await jest.advanceTimersByTimeAsync(1000);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(3);
      expect(shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(false);
    });

    it('backend register가 실제로 성공(ok===true)한 뒤에만 true(스킵) — #2735 수정된 조건', async () => {
      delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      await Promise.resolve();
      expect(shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(true);
    });

    // 회귀 가드(#2481) — backend 등록 성공 + 아직 신선한 동안에는 device가 덮어쓰지 않는다.
    it('backend 등록 성공 + push 수신 중(신선함)에는 device가 덮어쓰지 않는다 (#2481 보존)', async () => {
      delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      await Promise.resolve();
      jest.advanceTimersByTime(4 * 60 * 1000); // 4분 — staleness backstop(5분) 이전
      expect(shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(true);
    });

    // #2735 요구사항 3 — 등록 성공 후에도 오래 재확인이 없으면 device가 쓰기를 재개한다.
    it('backend 등록 성공 후 재확인 없이 stale window(5분)를 넘기면 false(device 쓰기 재개)', async () => {
      delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      await Promise.resolve();
      expect(shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(true);
      jest.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(false);
    });

    it('dogfood 모드(flag ON)면 등록에 성공했어도 false(device가 계속 쓴다) — 회귀 방지', async () => {
      process.env.EXPO_PUBLIC_MINIMAL_ALARM = 'true';
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      await Promise.resolve();
      expect(shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(false);
    });

    it('backend-tracked trip 자체가 없으면(tripToken null) false — pre-boarding 등 lock 전 구간', () => {
      delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;
      expect(shouldSkipDeviceLiveActivityWrite(null)).toBe(false);
    });

    it('trip은 있지만 이 프로세스에서 아직 LA push 세션을 등록 못한 상태(첫 write)면 false — blank LA 방지', () => {
      delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;
      __resetLiveActivityPushChannelForTests();
      expect(shouldSkipDeviceLiveActivityWrite('trip-never-registered')).toBe(false);
    });

    it('다른 tripToken이 등록에 성공해 있으면(불일치) false — 새 trip 부트스트랩 허용', async () => {
      delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-old', SAMPLE_DATA);
      handle.emit('tok');
      await Promise.resolve();
      expect(shouldSkipDeviceLiveActivityWrite('trip-new')).toBe(false);
    });
  });

  // #2735 요구사항 4 — 권위 상태 전이 계측이 alarmLog(덤프에서 관측 가능)로 남는지 검증.
  describe('LA 권위 상태 계측 (#2735)', () => {
    afterEach(() => {
      delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;
    });

    it('상태가 바뀔 때만 alarmLog에 적재한다 — 같은 상태 반복 호출은 dedup', async () => {
      delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;
      // 1) trip 없음 → device-write
      shouldSkipDeviceLiveActivityWrite(null);
      shouldSkipDeviceLiveActivityWrite(null);
      expect(mockLogLiveActivityAuthorityState).toHaveBeenCalledTimes(1);
      expect(mockLogLiveActivityAuthorityState).toHaveBeenLastCalledWith(
        'live-activity-authority-device-write',
      );

      // 2) trip은 있지만 미등록 → backend-pending으로 전이 (1건 추가)
      shouldSkipDeviceLiveActivityWrite('trip-1');
      expect(mockLogLiveActivityAuthorityState).toHaveBeenCalledTimes(2);
      expect(mockLogLiveActivityAuthorityState).toHaveBeenLastCalledWith(
        'live-activity-authority-backend-pending',
      );

      // 3) 등록 성공 → backend-active로 전이 (1건 추가)
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      await Promise.resolve();
      shouldSkipDeviceLiveActivityWrite('trip-1');
      expect(mockLogLiveActivityAuthorityState).toHaveBeenCalledTimes(3);
      expect(mockLogLiveActivityAuthorityState).toHaveBeenLastCalledWith(
        'live-activity-authority-backend-active',
      );
    });
  });

  // #2667 — LA 세션 소유권과 무관한 ambient token 등록. 실제로 LA를 띄우는 경로들
  // (pre-boarding 훅 / lock 이전 GPS)은 startLiveActivityWithRegistration을 쓰지 않아 native가
  // emit한 token이 버려졌고, 그래서 backend는 LA push를 한 건도 못 보냈다(laPushDelivery=0/0).
  describe('ambient LA token 등록 (#2667)', () => {
    it('LA 세션을 시작하지 않아도 token emit을 현재 trip에 등록한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-ambient');
      const handle = setupListener();
      startAmbientLiveActivityTokenRegistration();

      handle.emit('tok-ambient');
      await jest.runAllTimersAsync();

      expect(mockStartLiveActivity).not.toHaveBeenCalled();
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-ambient', 'tok-ambient');
    });

    it('같은 (trip, token) 조합은 한 번만 등록한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-ambient');
      const handle = setupListener();
      startAmbientLiveActivityTokenRegistration();

      handle.emit('tok-ambient');
      await jest.runAllTimersAsync();
      registerHeldLiveActivityTokenForCurrentTrip();
      await jest.runAllTimersAsync();

      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);
    });

    it('token이 trip 등록보다 먼저 와도(ACTIVE_TRIP_KEY 부재) 나중에 등록된다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      const handle = setupListener();
      startAmbientLiveActivityTokenRegistration();

      handle.emit('tok-early');
      await jest.runAllTimersAsync();
      expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();

      // trip이 뒤늦게 등록됨 → 보관 중이던 token을 그 trip에 붙인다.
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-late');
      registerHeldLiveActivityTokenForCurrentTrip();
      await jest.runAllTimersAsync();

      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-late', 'tok-early');
    });

    it('중복 구독하지 않는다 — 두 번 호출해도 listener는 1개, 두 번째 teardown은 no-op', () => {
      const handle = setupListener();
      startAmbientLiveActivityTokenRegistration();
      const secondStop = startAmbientLiveActivityTokenRegistration();
      expect(mockAddPushTokenListener).toHaveBeenCalledTimes(1);

      // 두 번째 호출의 teardown은 실제 구독을 끊지 않는다(첫 구독 소유권은 첫 호출자에게 있다).
      secondStop();
      expect(handle.remove).not.toHaveBeenCalled();
    });

    it('같은 token이 연속 emit되면 등록을 다시 시도하지 않는다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-ambient');
      const handle = setupListener();
      startAmbientLiveActivityTokenRegistration();

      handle.emit('tok-same');
      await jest.runAllTimersAsync();
      handle.emit('tok-same');
      await jest.runAllTimersAsync();

      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);
    });

    it('emit된 token이 없으면 아무것도 하지 않는다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-ambient');
      setupListener();
      startAmbientLiveActivityTokenRegistration();

      registerHeldLiveActivityTokenForCurrentTrip();
      await jest.runAllTimersAsync();

      expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();
    });

    it('등록이 끝내 실패하면 dedup 키를 남기지 않는다 — 다음 기회에 재시도', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-ambient');
      mockRegisterLiveActivityToken.mockResolvedValue({ ok: false, status: 503 });
      const handle = setupListener();
      startAmbientLiveActivityTokenRegistration();

      handle.emit('tok-fail');
      await jest.runAllTimersAsync();
      const firstRoundCalls = mockRegisterLiveActivityToken.mock.calls.length;
      expect(firstRoundCalls).toBeGreaterThan(0);

      mockRegisterLiveActivityToken.mockResolvedValue({ ok: true });
      registerHeldLiveActivityTokenForCurrentTrip();
      await jest.runAllTimersAsync();

      expect(mockRegisterLiveActivityToken.mock.calls.length).toBeGreaterThan(firstRoundCalls);
    });

    it('trip을 기다리는 사이 더 새 token이 오면 옛 token 등록은 양보한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      const handle = setupListener();
      startAmbientLiveActivityTokenRegistration();

      handle.emit('tok-old');
      // 아직 trip이 없어 대기 중인 상태에서 새 token이 도착.
      handle.emit('tok-new');
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-late');
      await jest.runAllTimersAsync();

      const registeredTokens = mockRegisterLiveActivityToken.mock.calls.map((call) => call[1]);
      expect(registeredTokens).not.toContain('tok-old');
      expect(registeredTokens).toContain('tok-new');
    });

    it('trip 종료(endLiveActivityWithDeregister)는 in-flight ambient 재시도를 취소한다 (리뷰 P1-2)', async () => {
      // trip이 아직 없어 대기 루프에 들어간 상태에서 trip이 종료되는 시나리오 —
      // 취소가 없으면 늦은 POST가 DELETE 뒤에 도착해 죽은 trip의 token을 되살린다.
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      const handle = setupListener();
      startAmbientLiveActivityTokenRegistration();
      handle.emit('tok-cancel');

      await endLiveActivityWithDeregister('trip-ended');
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-ended');
      await jest.runAllTimersAsync();

      expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();
    });

    it('trip 종료 후 새 trip에서는 다시 등록된다 (취소가 영구 차단이 아니다)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-1');
      const handle = setupListener();
      startAmbientLiveActivityTokenRegistration();
      handle.emit('tok-1');
      await jest.runAllTimersAsync();
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-1', 'tok-1');

      await endLiveActivityWithDeregister('trip-1');
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-2');
      handle.emit('tok-2');
      await jest.runAllTimersAsync();

      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-2', 'tok-2');
    });

    it('AsyncStorage read 실패는 graceful — 등록만 skip하고 throw하지 않는다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('storage down'));
      const handle = setupListener();
      startAmbientLiveActivityTokenRegistration();

      handle.emit('tok-storage-fail');
      await expect(jest.runAllTimersAsync()).resolves.toBeUndefined();

      expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();
    });

    it('teardown 후에는 emit을 받지 않는다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-ambient');
      const handle = setupListener();
      const stop = startAmbientLiveActivityTokenRegistration();
      stop();
      expect(handle.remove).toHaveBeenCalledTimes(1);
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
