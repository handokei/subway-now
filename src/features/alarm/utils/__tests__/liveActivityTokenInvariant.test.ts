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
const mockLogLaWrite = jest.fn();
jest.mock('../alarmLog', () => ({
  logLaWrite: (...args: unknown[]) => mockLogLaWrite(...args),
  logLiveActivityAuthorityState: jest.fn(),
  logLiveActivityUpdated: jest.fn(),
  logLiveActivityTokenRegister: (...args: unknown[]) => mockLogLaTokenRegister(...args),
  logLiveActivityLifecycle: (...args: unknown[]) => mockLogLaLifecycle(...args),
}));

import {
  __resetLiveActivityPushChannelForTests,
  acknowledgeTripRegistration,
  endLiveActivityWithDeregister,
  markBackendLiveActivityTokenMissing,
  resetLiveActivityChannelAfterExternalEnd,
  shouldSkipDeviceLiveActivityWrite,
  startLiveActivityWithRegistration,
  ensureLiveActivityRegistered,
  reconcileLiveActivityToken,
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
      mockLogLaWrite,
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
      // #2735 PR-1 — 토큰 없는 LA 재생성은 D8(source=session-recreate)로 1건 적재된다.
      expect(mockLogLaWrite).toHaveBeenCalledWith({
        writer: 'D8',
        source: 'session-recreate',
        data: DATA,
        authority: 'unknown',
      });
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

    it('재생성 직후 쿨다운 안에서는 또 끝내고 시작하지 않는다(LA 깜빡임 방지)', async () => {
      setActiveTrip(NEW_TRIP);
      await laUpdateTick();
      await jest.advanceTimersByTimeAsync(30_000);
      await laUpdateTick();
      expect(mockEndLiveActivity).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(30_000);
      await laUpdateTick();
      await jest.advanceTimersByTimeAsync(30_000);
      await laUpdateTick();

      expect(mockEndLiveActivity).toHaveBeenCalledTimes(1);
      expect(mockStartLiveActivity).toHaveBeenCalledTimes(1);
    });

    it('LA를 만들 data가 없는 호출(trip register / FG 복귀 트리거)은 토큰이 없어도 LA를 건드리지 않는다', async () => {
      setActiveTrip(NEW_TRIP);

      registerHeldLiveActivityTokenForCurrentTrip();
      await jest.advanceTimersByTimeAsync(30_000);
      registerHeldLiveActivityTokenForCurrentTrip();
      await jest.advanceTimersByTimeAsync(0);

      expect(mockEndLiveActivity).not.toHaveBeenCalled();
      expect(mockStartLiveActivity).not.toHaveBeenCalled();
    });

    it('복구 중 예외는 호출자(LA update 경로)로 전파되지 않는다', async () => {
      setActiveTrip(NEW_TRIP);
      mockHasActiveLiveActivity.mockImplementation(() => {
        throw new Error('native gone');
      });

      await expect(reconcileLiveActivityToken(DATA)).resolves.toBeUndefined();
    });

    it('storage 읽기가 실패하면 trip을 알 수 없으므로 아무 등록도 하지 않는다', async () => {
      const storage = jest.requireMock('@react-native-async-storage/async-storage') as {
        getItem: jest.Mock;
      };
      storage.getItem.mockRejectedValueOnce(new Error('disk'));

      await reconcileLiveActivityToken(DATA);

      expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();
      expect(mockEndLiveActivity).not.toHaveBeenCalled();
    });

    it('native 토큰 조회가 throw해도 emit으로 받아 둔 같은 LA의 토큰으로 등록한다', async () => {
      setActiveTrip(NEW_TRIP);
      emitToken('T-emitted');
      await jest.advanceTimersByTimeAsync(100);
      mockRegisterLiveActivityToken.mockClear();
      mockRequestLiveActivityPushToken.mockRejectedValue(new Error('old native build'));

      // 조회 실패는 "토큰 없음"이 아니다 — held 토큰으로 폴백하므로 LA를 끝내지 않고(재생성 X) 이미 등록된 키는 dedup된다.
      await reconcileLiveActivityToken(DATA);
      await jest.advanceTimersByTimeAsync(100);

      expect(mockEndLiveActivity).not.toHaveBeenCalled();
      expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled(); // 이미 (trip, T-emitted)가 등록됨 -> dedup
    });

    it('동시에 여러 번 호출돼도 native 조회는 1회만 일어난다(in-flight 합류)', async () => {
      setActiveTrip(NEW_TRIP);
      mockRequestLiveActivityPushToken.mockResolvedValue('T-once');

      await Promise.all([
        reconcileLiveActivityToken(),
        reconcileLiveActivityToken(),
        reconcileLiveActivityToken(),
      ]);
      await jest.advanceTimersByTimeAsync(5_000);

      expect(mockRequestLiveActivityPushToken).toHaveBeenCalledTimes(1);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);
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

  // ---------------------------------------------------------------------------------------------
  // audit-sides 후속(#3163): ACTIVE_TRIP_KEY는 **기기 APNs token**이라(useApnsTripRegistration
  // `setItem(ACTIVE_TRIP_KEY, token)`) 같은 기기의 모든 trip이 같은 trip token을 쓴다. "종료된 trip 식별"을
  // token 값으로 하면 한 번 종료된 뒤 그 기기의 이후 모든 trip이 영구 차단된다 — trip *인스턴스*(register ack)로 푼다.
  // ---------------------------------------------------------------------------------------------
  describe('P0 — 같은 기기 토큰을 재사용하는 연속 trip', () => {
    const SAME = 'apns-device-token';

    it('trip A 종료 뒤 같은 토큰으로 시작한 trip B의 새 LA 토큰이 register ack 뒤 등록된다', async () => {
      setActiveTrip(SAME);
      emitToken('T1-trip-a');
      await jest.advanceTimersByTimeAsync(0);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith(SAME, 'T1-trip-a');

      await endLiveActivityWithDeregister(SAME);
      setActiveTrip(null); // cleanup이 ACTIVE_TRIP을 비움
      emitToken('T2-trip-b'); // 06:18:00 새 LA
      await jest.advanceTimersByTimeAsync(100);
      setActiveTrip(SAME); // trip B register ack — 같은 기기 토큰
      acknowledgeTripRegistration();
      await jest.advanceTimersByTimeAsync(5_000);

      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith(SAME, 'T2-trip-b');
    });

    it('[거부] ack 전에는 종료 직후 storage에 남은 옛 trip 토큰에 새 LA 토큰을 붙이지 않는다', async () => {
      setActiveTrip(SAME);
      emitToken('T1-trip-a');
      await jest.advanceTimersByTimeAsync(0);
      await endLiveActivityWithDeregister(SAME);
      mockRegisterLiveActivityToken.mockClear();

      emitToken('T2-trip-b'); // storage에는 아직 옛 trip(SAME)이 남아 있다
      await jest.advanceTimersByTimeAsync(5_000);

      expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();
    });

    it('종료 뒤 LA update tick(reconcile)도 register ack 이후에는 같은 토큰 trip에서 동작한다', async () => {
      setActiveTrip(SAME);
      await endLiveActivityWithDeregister(SAME);
      setActiveTrip(SAME);
      acknowledgeTripRegistration();
      mockRequestLiveActivityPushToken.mockResolvedValue('T-adopted-b');

      await ensureLiveActivityRegistered(SAME, DATA);
      await jest.advanceTimersByTimeAsync(5_000);

      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith(SAME, 'T-adopted-b');
    });
  });

  describe('P1-a — backend가 device 몰래 LA 토큰을 지웠다(410/종료 dismissal/DELETE)', () => {
    const SAME = 'apns-device-token';

    it('LA가 살아 있으면 dedup을 풀고 같은 (trip, 현재 토큰)을 다시 등록한다', async () => {
      setActiveTrip(SAME);
      emitToken('T1');
      await jest.advanceTimersByTimeAsync(0);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(1);
      mockRequestLiveActivityPushToken.mockResolvedValue('T1');

      markBackendLiveActivityTokenMissing();
      await jest.advanceTimersByTimeAsync(5_000);

      expect(mockRegisterLiveActivityToken).toHaveBeenCalledTimes(2);
      expect(mockRegisterLiveActivityToken).toHaveBeenLastCalledWith(SAME, 'T1');
    });

    it('backend 권위 확인(backendConfirmed)도 풀려 device 쓰기가 재개된다', async () => {
      setActiveTrip(SAME);
      await startLiveActivityWithRegistration(SAME, DATA);
      emitToken('T-sess');
      await jest.advanceTimersByTimeAsync(0);
      expect(shouldSkipDeviceLiveActivityWrite(SAME)).toBe(true);
      mockHasActiveLiveActivity.mockReturnValue(false); // 재등록은 안 일어나게 — 권위 해제만 본다

      markBackendLiveActivityTokenMissing();

      expect(shouldSkipDeviceLiveActivityWrite(SAME)).toBe(false);
    });

    it('[거부] trip이 이미 끝났으면(ACTIVE_TRIP 없음) 재등록하지 않는다', async () => {
      setActiveTrip(SAME);
      emitToken('T1');
      await jest.advanceTimersByTimeAsync(0);
      mockRegisterLiveActivityToken.mockClear();
      setActiveTrip(null);

      markBackendLiveActivityTokenMissing();
      await jest.advanceTimersByTimeAsync(5_000);

      expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();
    });

    it('[거부] LA가 이미 사라졌으면 죽은 토큰을 재등록하지 않는다', async () => {
      setActiveTrip(SAME);
      emitToken('T1');
      await jest.advanceTimersByTimeAsync(0);
      mockRegisterLiveActivityToken.mockClear();
      mockHasActiveLiveActivity.mockReturnValue(false);

      markBackendLiveActivityTokenMissing();
      await jest.advanceTimersByTimeAsync(5_000);

      expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();
    });
  });

  describe('P1-b — 앱이 FG로 돌아오지 않는 BG-only trip (173 주머니 케이스)', () => {
    it('BG에서 data 없이 호출돼도 native 토큰을 재조회해 등록하고 LA는 건드리지 않는다', async () => {
      setActiveTrip('apns-device-token');
      setAppState('background');
      mockRequestLiveActivityPushToken.mockResolvedValue('T-bg');

      await reconcileLiveActivityToken();
      await jest.advanceTimersByTimeAsync(5_000);

      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith('apns-device-token', 'T-bg');
      expect(mockEndLiveActivity).not.toHaveBeenCalled();
      expect(mockStartLiveActivity).not.toHaveBeenCalled();
    });
  });

  describe('P2 — 재생성/외부 종료 시 backend 권위 상태', () => {
    const SAME = 'apns-device-token';

    it('토큰 없는 LA를 재생성하면 backendConfirmed를 풀어 최대 5분 무음 구간을 없앤다', async () => {
      setActiveTrip(SAME);
      await startLiveActivityWithRegistration(SAME, DATA);
      emitToken('T-old');
      await jest.advanceTimersByTimeAsync(0);
      expect(shouldSkipDeviceLiveActivityWrite(SAME)).toBe(true);
      mockRequestLiveActivityPushToken.mockResolvedValue(null);

      await ensureLiveActivityRegistered(SAME, DATA);
      await jest.advanceTimersByTimeAsync(30_000);
      await ensureLiveActivityRegistered(SAME, DATA);
      await jest.advanceTimersByTimeAsync(0);

      expect(mockStartLiveActivity).toHaveBeenCalled(); // 재생성 발생
      expect(shouldSkipDeviceLiveActivityWrite(SAME)).toBe(false);
    });

    it('cleanup 경로의 native 종료(외부 종료)도 backend 권위 상태/세션을 정리한다', async () => {
      setActiveTrip(SAME);
      await startLiveActivityWithRegistration(SAME, DATA);
      emitToken('T-old');
      await jest.advanceTimersByTimeAsync(0);
      expect(shouldSkipDeviceLiveActivityWrite(SAME)).toBe(true);

      resetLiveActivityChannelAfterExternalEnd();

      expect(shouldSkipDeviceLiveActivityWrite(SAME)).toBe(false);
    });

    it('외부 종료로 끝난 LA의 등록된 토큰은 폐기되어 다음 복구 때 다시 붙지 않는다', async () => {
      setActiveTrip(SAME);
      emitToken('T-dead');
      await jest.advanceTimersByTimeAsync(0);
      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith(SAME, 'T-dead');
      mockRegisterLiveActivityToken.mockClear();

      resetLiveActivityChannelAfterExternalEnd();
      await reconcileLiveActivityToken(); // 새 LA는 있지만 아직 토큰 없음(native null)
      await jest.advanceTimersByTimeAsync(5_000);

      expect(mockRegisterLiveActivityToken).not.toHaveBeenCalled();
    });

    it('[거부] 외부 종료 정리가 trip에 아직 안 묶인 새 LA의 대기 토큰을 삼키지 않는다', async () => {
      setActiveTrip(null);
      emitToken('T2-new-la');
      await jest.advanceTimersByTimeAsync(100);

      resetLiveActivityChannelAfterExternalEnd();
      setActiveTrip(SAME);
      acknowledgeTripRegistration();
      await jest.advanceTimersByTimeAsync(10_000);

      expect(mockRegisterLiveActivityToken).toHaveBeenCalledWith(SAME, 'T2-new-la');
    });
  });
});
