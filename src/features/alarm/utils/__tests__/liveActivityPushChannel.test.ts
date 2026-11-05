const mockStartLiveActivity = jest.fn();
const mockUpdateLiveActivity = jest.fn();
const mockEndLiveActivity = jest.fn();
const mockAddPushTokenListener = jest.fn();
const mockHasActiveLiveActivity = jest.fn();

jest.mock('../../../../../modules/live-activity', () => ({
  startLiveActivity: (...args: unknown[]) => mockStartLiveActivity(...args),
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
  endLiveActivity: () => mockEndLiveActivity(),
  hasActiveLiveActivity: () => mockHasActiveLiveActivity(),
  // #3162 — native 토큰 재조회. 이 파일의 기존 케이스는 emit 경로만 보므로 기본은 "조회 불가(null)".
  requestLiveActivityPushToken: async () => null,
  addPushTokenListener: (...args: unknown[]) =>
    mockAddPushTokenListener(...args),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
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
const mockLogLaTokenRegister = jest.fn();
const mockLogLaLifecycle = jest.fn();
const mockLogLaWrite = jest.fn();
jest.mock('../alarmLog', () => ({
  logLaWrite: (...args: unknown[]) => mockLogLaWrite(...args),
  logLiveActivityAuthorityState: (...args: unknown[]) =>
    mockLogLiveActivityAuthorityState(...args),
  logLiveActivityUpdated: jest.fn(),
  // #2977 — ambient 등록 결과 계측. 이 모듈의 4갈래 결과를 덤프로 가시화한다.
  logLiveActivityTokenRegister: (...args: unknown[]) => mockLogLaTokenRegister(...args),
  // #3107 — 세션 teardown / 취소 무음 반환 가시화.
  logLiveActivityLifecycle: (...args: unknown[]) => mockLogLaLifecycle(...args),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  __resetLiveActivityPushChannelForTests,
  endLiveActivityWithDeregister,
  ensureLiveActivityRegistered,
  markBackendLiveActivityTokenMissing,
  registerHeldLiveActivityTokenForCurrentTrip,
  resetLiveActivityChannelAfterExternalEnd,
  resolveDeviceFallbackSource,
  shouldSkipDeviceLiveActivityWrite,
  startAmbientLiveActivityTokenRegistration,
  startLiveActivityWithRegistration,
} from '../liveActivityPushChannel';
import { setLastSilentPushReceivedAt } from '../lastSilentPushReceivedAt';
import { BOARDING_LOCK_KEY } from '../../../../shared/constants/storageKeys';

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
    mockLogLaLifecycle.mockReset();
    mockHasActiveLiveActivity.mockReset();
    mockHasActiveLiveActivity.mockReturnValue(false);
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

    // #2977 — 3회 전부 throw(네트워크 단절)로 끝나면 backend status 자체가 없다. detail을
    // 'none'으로 적재해 "status를 받았지만 실패"(not-ok:503 등)와 "응답조차 못 받음"을
    // 덤프에서 구별할 수 있게 한다 — 원인이 다르다(서버 거부 vs 네트워크/오프라인).
    it('#2977 3회 모두 throw면 exhausted detail이 none이다 (status 없음)', async () => {
      const handle = setupListener();
      mockRegisterLiveActivityToken.mockRejectedValue(new Error('net'));
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      await jest.runAllTimersAsync();

      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(3);
      expect(mockLogLaTokenRegister).toHaveBeenCalledWith('exhausted', 'none');
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

  // #2806 잔여 절반 — 세션 미등록(activeTeardown===null) + native LA는 이미 활성(FG pre-boarding
  // 훅/useEnsureLiveActivity가 채널을 거치지 않고 직접 시작한 세션)일 때 kill-recreate가 아니라
  // adopt(native start 생략 + update만 + 채널 세션 상태만 채움)해야 한다.
  // #2735 PR-1 — D8(채널 세션 start/adopt) 쓰기 관측. 동일 trip update(D1 경유)는 D1이 적재하므로 중복 금지.
  describe('#2735 PR-1 la-write (D8)', () => {
    beforeEach(() => {
      mockLogLaWrite.mockClear();
    });

    it('세션 시작(native start) 성공 후 source=session-start로 1건', async () => {
      mockHasActiveLiveActivity.mockReturnValue(false);
      setupListener();
      await ensureLiveActivityRegistered('trip-1', SAMPLE_DATA);
      expect(mockLogLaWrite).toHaveBeenCalledTimes(1);
      expect(mockLogLaWrite).toHaveBeenCalledWith({
        writer: 'D8',
        source: 'session-start',
        data: SAMPLE_DATA,
        authority: 'unknown',
      });
    });

    it('adopt(native update만) 성공 후 source=session-adopt로 1건', async () => {
      mockHasActiveLiveActivity.mockReturnValue(true);
      setupListener();
      await ensureLiveActivityRegistered('trip-1', SAMPLE_DATA);
      expect(mockLogLaWrite).toHaveBeenCalledTimes(1);
      expect(mockLogLaWrite).toHaveBeenCalledWith(
        expect.objectContaining({ writer: 'D8', source: 'session-adopt' }),
      );
    });

    it('세션 보존 update(동일 tripToken)는 D8로 적재하지 않는다 — D1 소관', async () => {
      mockHasActiveLiveActivity.mockReturnValue(false);
      setupListener();
      await ensureLiveActivityRegistered('trip-1', SAMPLE_DATA);
      mockLogLaWrite.mockClear();
      await ensureLiveActivityRegistered('trip-1', SAMPLE_DATA);
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
      expect(mockLogLaWrite).not.toHaveBeenCalled();
    });

    it('native start가 실패하면 적재하지 않는다', async () => {
      mockHasActiveLiveActivity.mockReturnValue(false);
      mockStartLiveActivity.mockRejectedValueOnce(new Error('Activity.request throw'));
      setupListener();
      await expect(ensureLiveActivityRegistered('trip-1', SAMPLE_DATA)).rejects.toThrow();
      expect(mockLogLaWrite).not.toHaveBeenCalled();
    });
  });

  describe('ensureLiveActivityRegistered — 세션 미등록 + 활성 LA 존재 시 adopt (#2806)', () => {
    it('kill(endLiveActivity) 미호출 + update만 호출 — 살아있는 LA를 죽이지 않는다', async () => {
      mockHasActiveLiveActivity.mockReturnValue(true);
      const handle = setupListener();
      await ensureLiveActivityRegistered('trip-1', SAMPLE_DATA);
      expect(mockEndLiveActivity).not.toHaveBeenCalled();
      expect(mockStartLiveActivity).not.toHaveBeenCalled();
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(SAMPLE_DATA);
      // adopt 후에도 채널 세션이 채워져 token 구독이 살아있어야 한다.
      handle.emit('tok');
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-1', 'tok');
    });

    it('adopt 이후 동일 tripToken 재호출은 세션 보존 — update만, kill 없음', async () => {
      mockHasActiveLiveActivity.mockReturnValue(true);
      setupListener();
      await ensureLiveActivityRegistered('trip-1', SAMPLE_DATA);
      await ensureLiveActivityRegistered('trip-1', SAMPLE_DATA);
      expect(mockEndLiveActivity).not.toHaveBeenCalled();
      expect(mockStartLiveActivity).not.toHaveBeenCalled();
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(2);
    });

    it('회귀 안전 — 진짜 다른 tripToken의 기존 세션(activeTeardown 존재)이 있으면 여전히 kill+deregister 후 재시작', async () => {
      mockHasActiveLiveActivity.mockReturnValue(false);
      const first = setupListener();
      await ensureLiveActivityRegistered('trip-1', SAMPLE_DATA);
      const second = setupListener();
      await ensureLiveActivityRegistered('trip-2', SAMPLE_DATA);
      expect(mockEndLiveActivity).toHaveBeenCalled();
      expect(mockClearLiveActivityToken).toHaveBeenCalledWith('trip-1');
      expect(first.remove).toHaveBeenCalledTimes(1);
      expect(mockStartLiveActivity).toHaveBeenCalledWith(SAMPLE_DATA);
      second.emit('tok');
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-2', 'tok');
    });
  });

  // #2735 PR-4 — device 권위 게이트. 판정 입력은 "등록 시각"이 아니라 (등록 확인 + lock + 마지막 유효
  // silent push 수신 공백 ≤ T). 판정은 AsyncStorage를 읽으므로 async. 이 describe는 in-memory storage를
  // 쓰고, `__resetLiveActivityPushChannelForTests()`는 메모리만 비우므로 "BG JS 재기동"을 흉내낸다.
  describe('shouldSkipDeviceLiveActivityWrite (#2481, #2735 PR-4)', () => {
    const T0 = Date.UTC(2026, 9, 28, 8, 26, 7); // 17:26:07 KST (trip 180 첫 SSoT 없는 wake)
    const T_MS = 10 * 60 * 1000;
    let store: Map<string, string>;

    function useMemoryStorage(): void {
      store = new Map();
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (k: string) => store.get(k) ?? null);
      (AsyncStorage.setItem as jest.Mock).mockImplementation(async (k: string, v: string) => {
        store.set(k, v);
      });
      (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (k: string) => {
        store.delete(k);
      });
    }

    function putLock(): void {
      store.set(
        BOARDING_LOCK_KEY,
        JSON.stringify({
          destinationId: 'd',
          trainCode: '7123',
          boardingStationId: 's',
          boardingLine: '2',
          boardedAt: T0 - 90_000,
          expectedDurationMs: 600_000,
        }),
      );
    }

    async function registerOk(tripToken = 'trip-1'): Promise<void> {
      const handle = setupListener();
      await startLiveActivityWithRegistration(tripToken, SAMPLE_DATA);
      handle.emit('tok');
      await jest.advanceTimersByTimeAsync(0);
    }

    beforeEach(() => {
      jest.setSystemTime(T0);
      useMemoryStorage();
    });

    afterEach(() => {
      (AsyncStorage.getItem as jest.Mock).mockReset();
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      (AsyncStorage.setItem as jest.Mock).mockReset();
      (AsyncStorage.removeItem as jest.Mock).mockReset();
    });

    it('세션 시작 직후 backend register 응답이 아직 안 왔으면 false(device가 계속 쓴다)', async () => {
      mockRegisterLiveActivityToken.mockImplementation(() => new Promise(() => undefined));
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      putLock();
      await setLastSilentPushReceivedAt(T0);
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(false);
    });

    it('backend register가 재시도 끝에 완전히 실패하면 false — LA freeze 방지', async () => {
      mockRegisterLiveActivityToken.mockResolvedValue({ ok: false, status: 500 });
      const handle = setupListener();
      await startLiveActivityWithRegistration('trip-1', SAMPLE_DATA);
      handle.emit('tok');
      await jest.advanceTimersByTimeAsync(500);
      await jest.advanceTimersByTimeAsync(1000);
      putLock();
      await setLastSilentPushReceivedAt(T0);
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(false);
    });

    it('등록 확인 + lock + 신선한 silent push 수신이면 true(스킵)', async () => {
      await registerOk();
      putLock();
      await setLastSilentPushReceivedAt(T0);
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(true);
    });

    // trip 180 RED — 등록(17:13:29) 5분 뒤인 17:26:07 이후 수신이 계속 신선한데도 구 코드는 등록 시각 기준이라
    // 만료(backend-pending)로 판정해 device가 썼다.
    it('등록 후 5분을 훌쩍 넘겨도 silent push 수신이 T 안이면 계속 true — 등록 시각은 입력이 아니다', async () => {
      await registerOk();
      putLock();
      jest.setSystemTime(T0 + 13 * 60 * 1000);
      await setLastSilentPushReceivedAt(T0 + 13 * 60 * 1000 - 92_000);
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(true);
    });

    it('수신 공백이 T(10분)를 넘으면 false(device 재개), T 이내면 true — 경계', async () => {
      await registerOk();
      putLock();
      await setLastSilentPushReceivedAt(T0);
      jest.setSystemTime(T0 + T_MS);
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(true);
      jest.setSystemTime(T0 + T_MS + 1);
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(false);
    });

    it('[거부] 수신 stamp가 한 번도 없으면 false', async () => {
      await registerOk();
      putLock();
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(false);
    });

    it('[거부] lock이 없으면(lockless) 수신이 신선해도 false — lockless 이중 writer 허용', async () => {
      await registerOk();
      await setLastSilentPushReceivedAt(T0);
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(false);
    });

    it('BG JS 재기동(메모리 소실) 뒤에도 등록 확인은 유지된다 — 영속', async () => {
      await registerOk();
      putLock();
      await setLastSilentPushReceivedAt(T0);
      __resetLiveActivityPushChannelForTests();
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(true);
    });

    it('token-missing 응답 → false, JS 재기동 뒤에도 false, 재등록 성공하면 다시 true', async () => {
      await registerOk();
      putLock();
      await setLastSilentPushReceivedAt(T0);
      markBackendLiveActivityTokenMissing();
      await jest.advanceTimersByTimeAsync(0);
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(false);
      __resetLiveActivityPushChannelForTests();
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(false);
      await registerOk();
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(true);
    });

    it('tripToken null이면 false — pre-boarding 등 lock 전 구간', async () => {
      expect(await shouldSkipDeviceLiveActivityWrite(null)).toBe(false);
    });

    it('아직 등록 못한 trip(첫 write)이면 false — blank LA 방지', async () => {
      putLock();
      await setLastSilentPushReceivedAt(T0);
      expect(await shouldSkipDeviceLiveActivityWrite('trip-never-registered')).toBe(false);
    });

    it('다른 tripToken이 등록돼 있으면(불일치) false — 새 trip 부트스트랩 허용', async () => {
      await registerOk('trip-old');
      putLock();
      await setLastSilentPushReceivedAt(T0);
      expect(await shouldSkipDeviceLiveActivityWrite('trip-new')).toBe(false);
    });

    it('외부 종료(resetLiveActivityChannelAfterExternalEnd) 뒤 같은 tripToken이어도 false', async () => {
      await registerOk();
      putLock();
      await setLastSilentPushReceivedAt(T0);
      resetLiveActivityChannelAfterExternalEnd();
      await jest.advanceTimersByTimeAsync(0);
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(false);
    });

    it('등록 확인 저장이 실패해도 체인이 끊기지 않는다 — 그 등록은 미확인(false), 다음 등록 성공은 반영', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
      await registerOk();
      putLock();
      await setLastSilentPushReceivedAt(T0);
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(false);
      await registerOk();
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(true);
    });

    it('storage 읽기가 throw해도 false(device 쓰기 유지) — 게이트가 쓰기를 막는 쪽으로 실패하지 않는다', async () => {
      await registerOk();
      (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('down'));
      __resetLiveActivityPushChannelForTests();
      expect(await shouldSkipDeviceLiveActivityWrite('trip-1')).toBe(false);
    });

    describe('resolveDeviceFallbackSource (ADR-041 결정 4 — 침묵 뒤 device 쓰기에 출처)', () => {
      it('등록 확인 + lock 상태에서 수신이 T를 넘기면 deviceFallback', async () => {
        await registerOk();
        putLock();
        await setLastSilentPushReceivedAt(T0 - T_MS - 1);
        expect(await resolveDeviceFallbackSource('trip-1')).toBe('deviceFallback');
      });

      it('[거부] 권위 활성이면 undefined', async () => {
        await registerOk();
        putLock();
        await setLastSilentPushReceivedAt(T0);
        expect(await resolveDeviceFallbackSource('trip-1')).toBeUndefined();
      });

      it('[거부] 미등록/lockless/tripToken null이면 undefined — 침묵 판정이 아니라 원래 device writer', async () => {
        await setLastSilentPushReceivedAt(T0 - T_MS - 1);
        expect(await resolveDeviceFallbackSource('trip-1')).toBeUndefined();
        expect(await resolveDeviceFallbackSource(null)).toBeUndefined();
        await registerOk();
        expect(await resolveDeviceFallbackSource('trip-1')).toBeUndefined();
      });
    });
  });

  // #2735 요구사항 4 — 권위 상태 전이 계측이 alarmLog(덤프에서 관측 가능)로 남는지 검증.
  describe('LA 권위 상태 계측 (#2735)', () => {
    it('상태가 바뀔 때만 alarmLog에 적재한다 — 같은 상태 반복 호출은 dedup', async () => {
      await shouldSkipDeviceLiveActivityWrite(null);
      await shouldSkipDeviceLiveActivityWrite(null);
      expect(mockLogLiveActivityAuthorityState).toHaveBeenCalledTimes(1);
      expect(mockLogLiveActivityAuthorityState).toHaveBeenLastCalledWith(
        'live-activity-authority-device-write',
      );

      await shouldSkipDeviceLiveActivityWrite('trip-1');
      expect(mockLogLiveActivityAuthorityState).toHaveBeenCalledTimes(2);
      expect(mockLogLiveActivityAuthorityState).toHaveBeenLastCalledWith(
        'live-activity-authority-backend-pending',
      );
    });
  });

  // #2667 — LA 세션 소유권과 무관한 ambient token 등록. 실제로 LA를 띄우는 경로들
  // (pre-boarding 훅 / lock 이전 GPS)은 startLiveActivityWithRegistration을 쓰지 않아 native가
  // emit한 token이 버려졌고, 그래서 backend는 LA push를 한 건도 못 보냈다(laPushDelivery=0/0).
  describe('ambient LA token 등록 (#2667)', () => {
    // #3162 — 보관 token 재등록(registerHeld...)은 LA 존재를 전제로 한다(죽은 LA의 token을 새 trip에 붙이지 않는다).
    beforeEach(() => {
      mockHasActiveLiveActivity.mockReturnValue(true);
    });

    it('LA 세션을 시작하지 않아도 token emit을 현재 trip에 등록한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-ambient');
      const handle = setupListener();
      startAmbientLiveActivityTokenRegistration();

      handle.emit('tok-ambient');
      await jest.runAllTimersAsync();

      expect(mockStartLiveActivity).not.toHaveBeenCalled();
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-ambient', 'tok-ambient');
      // #2977 — 이 1건이 "backend LA push 채널이 열렸다"의 유일한 device측 증거다. 호출만
      // 되고 적재되지 않으면 덤프에서 여전히 보이지 않는다(계측의 wire-completion).
      expect(mockLogLaTokenRegister).toHaveBeenCalledWith('registered', 'trip-amb');
    });

    // #2977 — 활성 trip이 없어 등록을 skip한 경우. 기존엔 `log.info`만 남아 "등록 시도조차
    // 없었다"와 "시도했는데 실패했다"를 구별할 수 없었다.
    it('#2977 활성 trip 부재로 skip하면 no-active-trip을 적재한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      const handle = setupListener();
      startAmbientLiveActivityTokenRegistration();

      handle.emit('tok-ambient');
      await jest.runAllTimersAsync();

      expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();
      expect(mockLogLaTokenRegister).toHaveBeenCalledWith('no-active-trip');
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

    // #3107 — H2 판별: 대기 중이던 ambient 등록이 teardown으로 무음 취소되는지 덤프로 보이게 한다.
    // 기존 `if (session.cancelled) return;`은 아무 흔적도 남기지 않아 "토큰 emit 후 등록 0행"의
    // 원인(취소 vs 미시도)을 구별할 수 없었다.
    describe('#3107 세션 teardown / 취소 계측', () => {
      // #3162 — 취소 범위는 "종료되는 trip에 묶인 등록"뿐이다. 이전(#3107) 동작은 trip 무관 전부 취소였고
      // 그것이 173의 새 LA 토큰 유실(H2) 원인이었다.
      it('종료되는 trip에 묶인 등록 중 trip 종료 -> la-session-teardown heldToken=true + 그 등록은 cancelled', async () => {
        (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-ended');
        mockRegisterLiveActivityToken.mockResolvedValue({ ok: false, status: 503 });
        const handle = setupListener();
        startAmbientLiveActivityTokenRegistration();
        handle.emit('tok-cancel');
        await jest.advanceTimersByTimeAsync(100); // 등록이 trip-ended에 묶이고 backoff 대기 중

        await endLiveActivityWithDeregister('trip-ended');
        await jest.runAllTimersAsync();

        expect(mockLogLaLifecycle).toHaveBeenCalledWith('la-session-teardown', 'heldToken=true');
        expect(mockLogLaTokenRegister).toHaveBeenCalledWith('cancelled');
        expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1); // 종료된 trip에 더 쏘지 않는다
      });

      it('전체 초기화(trip 미지정)는 trip에 묶이지 않은 대기 등록도 취소하고 la-register-cancelled를 적재한다', async () => {
        (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
        const handle = setupListener();
        startAmbientLiveActivityTokenRegistration();
        handle.emit('tok-pending');
        await jest.advanceTimersByTimeAsync(100);

        __resetLiveActivityPushChannelForTests();
        await jest.runAllTimersAsync();

        expect(mockLogLaLifecycle).toHaveBeenCalledWith(
          'la-register-cancelled',
          expect.stringMatching(/^attempt=\d+$/),
        );
        expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();
      });

      it('[거부] 아직 trip에 묶이지 않은 대기 등록은 다른 trip의 종료로 취소되지 않는다(#3162)', async () => {
        (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
        const handle = setupListener();
        startAmbientLiveActivityTokenRegistration();
        handle.emit('tok-pending');

        await endLiveActivityWithDeregister('trip-other');
        (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-new');
        await jest.runAllTimersAsync();

        expect(mockLogLaLifecycle).not.toHaveBeenCalledWith('la-register-cancelled', expect.anything());
        expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-new', 'tok-pending');
      });

      it('[거부] 방금 종료된 trip의 token이 storage에 남아 있어도 새 LA 토큰을 그 trip에 붙이지 않는다(#3162)', async () => {
        (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-ended');
        const handle = setupListener();
        startAmbientLiveActivityTokenRegistration();
        await endLiveActivityWithDeregister('trip-ended');

        handle.emit('tok-next-la');
        await jest.advanceTimersByTimeAsync(5_000);
        expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();

        (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-new');
        await jest.runAllTimersAsync();
        expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('trip-new', 'tok-next-la');
      });

      it('보관 토큰이 없으면 heldToken=false', async () => {
        await endLiveActivityWithDeregister('trip-none');
        expect(mockLogLaLifecycle).toHaveBeenCalledWith('la-session-teardown', 'heldToken=false');
        expect(mockLogLaLifecycle).not.toHaveBeenCalledWith('la-register-cancelled', expect.anything());
      });

      it('[거부] 취소 없이 정상 등록되면 la-register-cancelled를 적재하지 않는다', async () => {
        (AsyncStorage.getItem as jest.Mock).mockResolvedValue('trip-ok');
        const handle = setupListener();
        startAmbientLiveActivityTokenRegistration();
        handle.emit('tok-ok');
        await jest.runAllTimersAsync();

        expect(mockLogLaLifecycle).not.toHaveBeenCalledWith('la-register-cancelled', expect.anything());
      });
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
