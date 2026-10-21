/**
 * #3162 — LA 유령 불변식: "trip이 활성이고 그 trip의 LA가 존재하면 backend는 그 LA의 현재 push token을 가진다."
 *
 * 근거: 10/21 trip 173 — D1 `la-token-register` 0건(161~172는 전부 >=1). backend LA alert push는
 * `trip.activityPushToken && activityState==='live'`일 때만 나가므로(scheduled.ts) 06:30:46 탑승 프롬프트가
 * 알림으로만 도달하고 LA에는 안 떴다(유령). 173의 실제 사건 순서:
 *   10/20 18:40 trip 미종료 -> 06:17:57 FG 복귀 force-end(cleanup: LA end + ACTIVE_TRIP 정리)
 *   -> 06:18:00 새 trip LA start(토큰 emit) -> 새 trip register ack는 그 뒤.
 * 토큰은 emit 1회에만 의존했고, (H2) 종료 teardown이 대기 중 등록을 trip 무관하게 취소하거나, (H1) adopt된
 * Activity는 토큰을 재emit하지 않아, 한 번 놓치면 트립 끝까지 복구 경로가 없었다.
 *
 * 이 파일의 각 테스트는 "시퀀스를 재생한 뒤 종결 상태"를 assert한다: backend register가 (새 trip, 새 LA 토큰)으로
 * 호출됐는가 + 실패 사유(취소 로그가 남았는가 / 죽은 LA 토큰이 새 trip에 붙었는가).
 */
import { AppState } from 'react-native';

const mockStartLiveActivity = jest.fn();
const mockUpdateLiveActivity = jest.fn();
const mockEndLiveActivity = jest.fn();
const mockAddPushTokenListener = jest.fn();
const mockHasActiveLiveActivity = jest.fn();
const mockRequestLiveActivityPushToken = jest.fn();

jest.mock('../../../../../modules/live-activity', () => ({
  startLiveActivity: (...args: unknown[]) => mockStartLiveActivity(...args),
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
  endLiveActivity: () => mockEndLiveActivity(),
  hasActiveLiveActivity: () => mockHasActiveLiveActivity(),
  requestLiveActivityPushToken: () => mockRequestLiveActivityPushToken(),
  addPushTokenListener: (...args: unknown[]) => mockAddPushTokenListener(...args),
}));

const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStorage.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    mockStorage.delete(key);
  }),
}));

const mockRegisterLiveActivityToken = jest.fn();
const mockClearLiveActivityToken = jest.fn();
jest.mock('../../api/alarmBackend', () => ({
  registerLiveActivityToken: (...args: unknown[]) => mockRegisterLiveActivityToken(...args),
  clearLiveActivityToken: (...args: unknown[]) => mockClearLiveActivityToken(...args),
}));

const mockLogLaTokenRegister = jest.fn();
const mockLogLaLifecycle = jest.fn();
jest.mock('../alarmLog', () => ({
  logLiveActivityAuthorityState: jest.fn(),
  logLiveActivityUpdated: jest.fn(),
  logLiveActivityTokenRegister: (...args: unknown[]) => mockLogLaTokenRegister(...args),
  logLiveActivityLifecycle: (...args: unknown[]) => mockLogLaLifecycle(...args),
}));

import {
  __resetLiveActivityPushChannelForTests,
  endLiveActivityWithDeregister,
  ensureLiveActivityRegistered,
  registerHeldLiveActivityTokenForCurrentTrip,
  startAmbientLiveActivityTokenRegistration,
} from '../liveActivityPushChannel';
import { ACTIVE_TRIP_KEY, LA_DISMISSED_AT_KEY } from '../../../../shared/constants/storageKeys';

type TokenListener = (e: { token: string }) => void;
let emitToken: (token: string) => void = () => undefined;

const OLD_TRIP = 'trip-old-1840';
const NEW_TRIP = 'trip-173-0618';
const DATA = { stationName: '뚝섬', lineName: '2호선', lineColorHex: '#00A84D', distanceM: 0 };

function setActiveTrip(trip: string | null): void {
  if (trip === null) mockStorage.delete(ACTIVE_TRIP_KEY);
  else mockStorage.set(ACTIVE_TRIP_KEY, trip);
}

function setAppState(state: 'active' | 'background'): void {
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: state });
}

/** 새 trip의 LA update tick — stationNotification이 30s마다 거치는 단일 진입점. */
async function laUpdateTick(): Promise<void> {
  await ensureLiveActivityRegistered(NEW_TRIP, DATA);
  await jest.advanceTimersByTimeAsync(0);
}

describe('LA 토큰 불변식 (#3162, trip 173 재생)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockStorage.clear();
    [
      mockStartLiveActivity,
      mockUpdateLiveActivity,
      mockEndLiveActivity,
      mockAddPushTokenListener,
      mockHasActiveLiveActivity,
      mockRequestLiveActivityPushToken,
      mockRegisterLiveActivityToken,
      mockClearLiveActivityToken,
      mockLogLaTokenRegister,
      mockLogLaLifecycle,
    ].forEach((m) => m.mockReset());
    mockStartLiveActivity.mockResolvedValue(undefined);
    mockUpdateLiveActivity.mockResolvedValue(undefined);
    mockEndLiveActivity.mockResolvedValue(undefined);
    mockRegisterLiveActivityToken.mockResolvedValue({ ok: true });
    mockClearLiveActivityToken.mockResolvedValue({ ok: true });
    mockHasActiveLiveActivity.mockReturnValue(true);
    mockRequestLiveActivityPushToken.mockResolvedValue(null);
    setAppState('active');
    mockAddPushTokenListener.mockImplementation((cb: TokenListener) => {
      emitToken = (token: string) => cb({ token });
      return { remove: jest.fn() };
    });
    __resetLiveActivityPushChannelForTests();
    startAmbientLiveActivityTokenRegistration();
  });

  afterEach(() => {
    jest.useRealTimers();
    __resetLiveActivityPushChannelForTests();
  });

  describe('H2 — teardown이 새 LA의 대기 중 등록을 삼킨다', () => {
    it('stale trip force-end cleanup이 새 LA 토큰 대기 중에 돌아도 trip 확정 뒤 (새 trip, 새 토큰)으로 등록된다', async () => {
      // 10/20 18:40 trip + 그 LA 토큰(T1)이 정상 등록돼 있던 상태.
      setActiveTrip(OLD_TRIP);
      emitToken('T1-old-la');
      await jest.advanceTimersByTimeAsync(0);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith(OLD_TRIP, 'T1-old-la');

      // 06:17:57 force-end: cleanup이 ACTIVE_TRIP을 비우는 중. 06:18:00 새 LA가 뜨고 T2 emit —
      // 새 trip은 아직 register ack 전이라 ACTIVE_TRIP이 없다(ambient가 trip 확정을 기다리는 중).
      setActiveTrip(null);
      emitToken('T2-new-la');
      await jest.advanceTimersByTimeAsync(100);

      // 대기 중에 이전 trip의 종료 teardown이 도착한다(3초 겹침).
      await endLiveActivityWithDeregister(OLD_TRIP);

      // 새 trip register ack — ACTIVE_TRIP 확정.
      setActiveTrip(NEW_TRIP);
      await jest.advanceTimersByTimeAsync(10_000);

      // 실패 사유 — 이전 trip 종료가 새 LA의 등록 세션을 취소(무음 반환)하면 안 된다.
      expect(mockLogLaLifecycle).not.toHaveBeenCalledWith(
        'la-register-cancelled',
        expect.anything(),
      );
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith(NEW_TRIP, 'T2-new-la');
    });
  });

  describe('trip register가 ambient 대기 창보다 늦다 (173 유력 경로)', () => {
    it('토큰 emit 후 대기 창이 지나 포기해도, 이후 LA update tick이 (새 trip, 새 토큰)으로 복구한다', async () => {
      setActiveTrip(null);
      emitToken('T2-new-la');
      // ambient 재시도 창(2s+4s+6s+8s)을 넘겨 'no-active-trip'으로 포기시킨다.
      await jest.advanceTimersByTimeAsync(60_000);
      expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();
      expect(mockLogLaTokenRegister).toHaveBeenCalledWith('no-active-trip');

      // 그 뒤 trip register ack -> 다음 기회(LA update tick)에 앱이 불변식을 복구해야 한다.
      setActiveTrip(NEW_TRIP);
      mockRequestLiveActivityPushToken.mockResolvedValue('T2-new-la');
      await laUpdateTick();
      await jest.advanceTimersByTimeAsync(5_000);

      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith(NEW_TRIP, 'T2-new-la');
    });
  });

  describe('H1 — adopt된 Activity는 토큰을 재emit하지 않는다', () => {
    it('emit이 한 번도 없어도 native에서 현재 토큰을 재조회해 (새 trip, 그 토큰)으로 등록한다', async () => {
      setActiveTrip(NEW_TRIP);
      mockRequestLiveActivityPushToken.mockResolvedValue('T-adopted');

      await laUpdateTick(); // ensure -> adopt 경로(채널 세션 없음 + native LA 존재)
      await jest.advanceTimersByTimeAsync(5_000);

      expect(mockUpdateLiveActivity).toHaveBeenCalled(); // adopt = native update만
      expect(mockStartLiveActivity).not.toHaveBeenCalled(); // 살아있는 LA를 kill-recreate하지 않는다(#2806)
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith(NEW_TRIP, 'T-adopted');
    });
  });

  describe('토큰을 얻을 수 없는 LA', () => {
    it('유예 시간 동안 토큰이 안 나오면 FG에서 LA를 끝내고 같은 trip으로 새로 시작한다', async () => {
      setActiveTrip(NEW_TRIP);
      mockRequestLiveActivityPushToken.mockResolvedValue(null);

      await laUpdateTick(); // 위반 최초 관측 — 아직 유예 중
      expect(mockEndLiveActivity).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(30_000);
      await laUpdateTick(); // 유예 경과 후에도 토큰 없음 -> 복구

      expect(mockEndLiveActivity).toHaveBeenCalledTimes(1);
      expect(mockStartLiveActivity).toHaveBeenCalledWith(DATA);
    });
  });

  describe('거부 케이스', () => {
    it('끝난 trip의 LA 토큰은 새 trip에 등록되지 않는다', async () => {
      setActiveTrip(OLD_TRIP);
      emitToken('T1-old-la');
      await jest.advanceTimersByTimeAsync(0);

      // 이전 trip 종료 -> native LA도 사라짐. 새 trip은 아직 LA가 없다.
      await endLiveActivityWithDeregister(OLD_TRIP);
      mockHasActiveLiveActivity.mockReturnValue(false);
      setActiveTrip(NEW_TRIP);

      registerHeldLiveActivityTokenForCurrentTrip(); // trip register ack 시점 트리거
      await laUpdateTick();
      await jest.advanceTimersByTimeAsync(60_000);

      const registeredToNew = mockRegisterLiveActivityToken.mock.calls.filter(
        ([trip]) => trip === NEW_TRIP,
      );
      expect(registeredToNew).toEqual([]);
    });

    it('백그라운드에서는 토큰이 없어도 LA를 끝내거나 새로 시작하지 않는다(BG start 금지)', async () => {
      setActiveTrip(NEW_TRIP);
      setAppState('background');
      mockRequestLiveActivityPushToken.mockResolvedValue(null);

      await laUpdateTick();
      await jest.advanceTimersByTimeAsync(30_000);
      await laUpdateTick();

      expect(mockEndLiveActivity).not.toHaveBeenCalled();
      expect(mockStartLiveActivity).not.toHaveBeenCalled();
    });

    it('사용자 swipe dismiss(sentinel 활성)를 존중한다 — 토큰이 없어도 LA를 되살리지 않는다', async () => {
      setActiveTrip(NEW_TRIP);
      mockStorage.set(LA_DISMISSED_AT_KEY, String(Date.now()));
      mockRequestLiveActivityPushToken.mockResolvedValue(null);

      await laUpdateTick();
      await jest.advanceTimersByTimeAsync(30_000);
      await laUpdateTick();

      expect(mockEndLiveActivity).not.toHaveBeenCalled();
      expect(mockStartLiveActivity).not.toHaveBeenCalled();
    });
  });
});
