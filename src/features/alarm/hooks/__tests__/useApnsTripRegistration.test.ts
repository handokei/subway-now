import { renderHook, waitFor, act } from '@testing-library/react-native';

const mockGetDevicePushTokenAsync = jest.fn();
const mockAddPushTokenListener = jest.fn();

jest.mock('expo-notifications', () => ({
  getDevicePushTokenAsync: (...args: unknown[]) => mockGetDevicePushTokenAsync(...args),
  addPushTokenListener: (...args: unknown[]) => mockAddPushTokenListener(...args),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

const mockRegister = jest.fn();
const mockClear = jest.fn();
jest.mock('../../api/alarmBackend', () => ({
  registerActiveTrip: (...args: unknown[]) => mockRegister(...args),
  clearActiveTrip: (...args: unknown[]) => mockClear(...args),
}));

// #2089 — 옛 tripBoundScheduler.cancelTripBoundAlarms(무인자)가 safetyNetScheduler 단일 채널
// 통합으로 tripToken 인자를 받는 cancelAllSafetyNetAlarms로 대체됐다.
const mockCancelTripBoundAlarms = jest.fn();
jest.mock('../../utils/safetyNetScheduler', () => ({
  cancelAllSafetyNetAlarms: (...args: unknown[]) => mockCancelTripBoundAlarms(...args),
}));

// R11-a (#1612) — POST /trips 직전 backend SSoT mirror 강제 clean 검증.
const mockClearBackendSsotMirror = jest.fn();
jest.mock('../../utils/backendSsotMirror', () => ({
  clearBackendSsotMirror: (...args: unknown[]) => mockClearBackendSsotMirror(...args),
}));

// #1628 — R11-a 차단 1건 측정 검증. clear 호출과 짝지어 같은 site에서 1회만 발사.
const mockLogCrossTripMirrorSkip = jest.fn();
jest.mock('../../utils/alarmLog', () => ({
  logCrossTripMirrorSkip: (...args: unknown[]) => mockLogCrossTripMirrorSkip(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import i18next from 'i18next';
import { useApnsTripRegistration } from '../useApnsTripRegistration';
import type { Station } from '../../../../shared/types/station';
import type { Route } from '../../../../shared/utils/stationRoute';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';
import {
  BOARDING_LOCK_RELEASE_DEBOUNCE_MS,
  CONTEXT_HEAL_MAX_ATTEMPTS_PER_SESSION,
  CONTEXT_HEAL_TIER2_DELAY_MS,
  REGISTER_RETRY_BACKOFF_MS,
  REGISTER_RETRY_HEAL_BUSY_MAX_RESCHEDULES,
  REGISTER_RETRY_HEAL_BUSY_RECHECK_MS,
} from '../../../../shared/constants/boardingLock';
import { makeDirectRoute, makeMultiTransferRoute } from '../../../../testUtils/routeFixtures';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import { getStationById } from '../../../../shared/utils/stationRoute';

const station: Station = {
  // stations.json 강남(2호선)과 id 일치 — #622 buildBoardingLockMeta가 boardingStationId로 조회.
  id: '2-022',
  name: '강남',
  line: '2',
  lat: 37.5,
  lng: 127.0,
  lineColor: '#00A84D',
};

const directRoute: Route = makeDirectRoute(5, '2');

/** #1960 Acceptance 4 — stations.json 실제 역 조회 (없으면 fixture 오류로 즉시 fail). */
function st(id: string): Station {
  const s = getStationById(id);
  if (!s) throw new Error(`fixture station not found: ${id}`);
  return s;
}

describe('useApnsTripRegistration', () => {
  let listenerRemove: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    listenerRemove = jest.fn();
    mockAddPushTokenListener.mockReturnValue({ remove: listenerRemove });
    mockGetDevicePushTokenAsync.mockResolvedValue({ data: 'token-abc' });
    mockRegister.mockResolvedValue({ ok: true });
    mockClear.mockResolvedValue({ ok: true });
    mockCancelTripBoundAlarms.mockResolvedValue(undefined);
    mockClearBackendSsotMirror.mockResolvedValue(undefined);
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === APNS_TOKEN_KEY) return 'token-abc';
      return null;
    });
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
  });

  it('마운트 시 device push token을 발급해 AsyncStorage에 저장', async () => {
    renderHook(() =>
      useApnsTripRegistration({ route: null, destination: null, nextStationEtaSeconds: null }),
    );
    await waitFor(() => {
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(APNS_TOKEN_KEY, 'token-abc');
    });
  });

  it('토큰 발급 실패 시 throw 없이 graceful', async () => {
    mockGetDevicePushTokenAsync.mockRejectedValue(new Error('denied'));
    renderHook(() =>
      useApnsTripRegistration({ route: null, destination: null, nextStationEtaSeconds: null }),
    );
    await waitFor(() => expect(mockGetDevicePushTokenAsync).toHaveBeenCalled());
    // 토큰 저장 안 됨
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(APNS_TOKEN_KEY, expect.anything());
  });

  it('토큰이 비어 있으면 저장하지 않는다', async () => {
    mockGetDevicePushTokenAsync.mockResolvedValue({ data: '' });
    renderHook(() =>
      useApnsTripRegistration({ route: null, destination: null, nextStationEtaSeconds: null }),
    );
    await waitFor(() => expect(mockGetDevicePushTokenAsync).toHaveBeenCalled());
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(APNS_TOKEN_KEY, '');
  });

  it('route + destination 활성 시 registerActiveTrip 호출 + ACTIVE_TRIP_KEY 저장', async () => {
    renderHook(() =>
      useApnsTripRegistration({
        route: directRoute,
        destination: station,
        nextStationEtaSeconds: 120,
      }),
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'token-abc',
        destination: '2-022',
        waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
        apnsEnv: expect.stringMatching(/^(sandbox|production)$/) as unknown as 'sandbox' | 'production',
      }),
    );
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(ACTIVE_TRIP_KEY, 'token-abc'),
    );
  });

  // R11-a (#1612) — POST /trips 직전 backend SSoT mirror 강제 clean (cross-trip 잔재 root).
  describe('R11-a (#1612) — POST /trips 직전 clearBackendSsotMirror', () => {
    it('register 호출 직전 clearBackendSsotMirror가 1회 호출된다 (호출 순서: clear → register)', async () => {
      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
        }),
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockClearBackendSsotMirror).toHaveBeenCalledTimes(1);
      // invocationCallOrder로 clear가 register보다 먼저 실행됐는지 검증 — race A 차단의 1단계 보장.
      const clearOrder = mockClearBackendSsotMirror.mock.invocationCallOrder[0];
      const registerOrder = mockRegister.mock.invocationCallOrder[0];
      expect(clearOrder).toBeLessThan(registerOrder);
      // #1628 — R11-a 측정 wire-completion: clear와 짝지어 logCrossTripMirrorSkip('register') 1회.
      expect(mockLogCrossTripMirrorSkip).toHaveBeenCalledWith('register');
      expect(mockLogCrossTripMirrorSkip).toHaveBeenCalledTimes(1);
    });

    it('route/destination 없으면 clearBackendSsotMirror 호출 안 함 (trip 종료 경로는 별경로)', async () => {
      renderHook(() =>
        useApnsTripRegistration({ route: null, destination: null, nextStationEtaSeconds: null }),
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockClearBackendSsotMirror).not.toHaveBeenCalled();
      // #1628 — clear가 안 됐으면 측정도 안 발사.
      expect(mockLogCrossTripMirrorSkip).not.toHaveBeenCalled();
    });

    it('토큰 없으면 register skip되고 clearBackendSsotMirror도 호출 안 함', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
        }),
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).not.toHaveBeenCalled();
      expect(mockClearBackendSsotMirror).not.toHaveBeenCalled();
      expect(mockLogCrossTripMirrorSkip).not.toHaveBeenCalled();
    });
  });

  it('register 실패 시 ACTIVE_TRIP_KEY 저장 안 함', async () => {
    mockRegister.mockResolvedValue({ ok: false });
    renderHook(() =>
      useApnsTripRegistration({
        route: directRoute,
        destination: station,
        nextStationEtaSeconds: 120,
      }),
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalled());
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(ACTIVE_TRIP_KEY, expect.anything());
  });

  it('토큰이 없으면 register skip', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    renderHook(() =>
      useApnsTripRegistration({
        route: directRoute,
        destination: station,
        nextStationEtaSeconds: 120,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('route/destination 없으면 + 이전 트립 있으면 clear', async () => {
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === APNS_TOKEN_KEY) return 'token-abc';
      if (key === ACTIVE_TRIP_KEY) return 'token-abc';
      return null;
    });
    renderHook(() =>
      useApnsTripRegistration({ route: null, destination: null, nextStationEtaSeconds: null }),
    );
    await waitFor(() => expect(mockClear).toHaveBeenCalledWith('token-abc'));
    await waitFor(() => expect(AsyncStorage.removeItem).toHaveBeenCalledWith(ACTIVE_TRIP_KEY));
  });

  it('route/destination 없고 이전 트립도 없으면 clear 안 함', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    renderHook(() =>
      useApnsTripRegistration({ route: null, destination: null, nextStationEtaSeconds: null }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('push token listener: 토큰 갱신 시 AsyncStorage 업데이트 + 활성 트립이면 재등록', async () => {
    renderHook(() =>
      useApnsTripRegistration({
        route: directRoute,
        destination: station,
        nextStationEtaSeconds: 120,
      }),
    );
    await waitFor(() => expect(mockAddPushTokenListener).toHaveBeenCalled());
    const listener = mockAddPushTokenListener.mock.calls[0][0];

    mockRegister.mockClear();
    (AsyncStorage.setItem as jest.Mock).mockClear();
    await act(async () => {
      listener({ data: 'token-NEW' });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(APNS_TOKEN_KEY, 'token-NEW'),
    );
    await waitFor(() =>
      expect(mockRegister).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'token-NEW' }),
      ),
    );
  });

  it('push token listener: 빈 토큰은 무시', async () => {
    renderHook(() =>
      useApnsTripRegistration({
        route: directRoute,
        destination: station,
        nextStationEtaSeconds: 120,
      }),
    );
    await waitFor(() => expect(mockAddPushTokenListener).toHaveBeenCalled());
    const listener = mockAddPushTokenListener.mock.calls[0][0];

    mockRegister.mockClear();
    (AsyncStorage.setItem as jest.Mock).mockClear();
    act(() => listener({ data: '' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(APNS_TOKEN_KEY, '');
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('push token listener: 활성 트립 없으면 재등록 안 함', async () => {
    renderHook(() =>
      useApnsTripRegistration({ route: null, destination: null, nextStationEtaSeconds: null }),
    );
    await waitFor(() => expect(mockAddPushTokenListener).toHaveBeenCalled());
    const listener = mockAddPushTokenListener.mock.calls[0][0];

    mockRegister.mockClear();
    await act(async () => {
      listener({ data: 'token-NEW' });
      await Promise.resolve();
    });
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('push token listener: setItem 실패해도 graceful', async () => {
    renderHook(() =>
      useApnsTripRegistration({ route: null, destination: null, nextStationEtaSeconds: null }),
    );
    await waitFor(() => expect(mockAddPushTokenListener).toHaveBeenCalled());
    const listener = mockAddPushTokenListener.mock.calls[0][0];

    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk'));
    await act(async () => {
      listener({ data: 'token-NEW' });
      await Promise.resolve();
    });
    // throw 없이 통과 — assertion 도달이 곧 성공.
    expect(true).toBe(true);
  });

  it('unmount 시 listener.remove 호출', async () => {
    const { unmount } = renderHook(() =>
      useApnsTripRegistration({ route: null, destination: null, nextStationEtaSeconds: null }),
    );
    await waitFor(() => expect(mockAddPushTokenListener).toHaveBeenCalled());
    unmount();
    expect(listenerRemove).toHaveBeenCalled();
  });

  it('nextStationEtaSeconds null이면 alarmAt = now', async () => {
    const fixed = new Date('2026-05-13T12:00:00Z').getTime();
    jest.spyOn(Date, 'now').mockReturnValue(fixed);
    renderHook(() =>
      useApnsTripRegistration({
        route: directRoute,
        destination: station,
        nextStationEtaSeconds: null,
      }),
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalled());
    expect(mockRegister.mock.calls[0][0].alarmAtEpochMs).toBe(fixed);
    (Date.now as jest.Mock).mockRestore();
  });

  it('unmount 직후 getDevicePushTokenAsync resolve해도 setItem 호출 안 함', async () => {
    let resolveToken!: (v: { data: string }) => void;
    mockGetDevicePushTokenAsync.mockImplementation(
      () => new Promise((res) => { resolveToken = res; }),
    );
    const { unmount } = renderHook(() =>
      useApnsTripRegistration({ route: null, destination: null, nextStationEtaSeconds: null }),
    );
    unmount();
    (AsyncStorage.setItem as jest.Mock).mockClear();
    await act(async () => {
      resolveToken({ data: 'late-token' });
      await Promise.resolve();
    });
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(APNS_TOKEN_KEY, 'late-token');
  });

  it('unmount 직후 getItem resolve해도 후속 동작 안 함 (register 분기)', async () => {
    let resolveGet!: (v: string | null) => void;
    (AsyncStorage.getItem as jest.Mock).mockImplementation(
      () => new Promise((res) => { resolveGet = res; }),
    );
    const { unmount } = renderHook(() =>
      useApnsTripRegistration({
        route: directRoute,
        destination: station,
        nextStationEtaSeconds: 120,
      }),
    );
    unmount();
    mockRegister.mockClear();
    await act(async () => {
      resolveGet('token-abc');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('unmount 직후 getItem resolve해도 후속 동작 안 함 (clear 분기)', async () => {
    let callCount = 0;
    let resolvePrev!: (v: string | null) => void;
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      callCount++;
      if (callCount === 1) return null; // APNS_TOKEN_KEY
      return new Promise((res) => { resolvePrev = res; }); // ACTIVE_TRIP_KEY
    });
    const { unmount } = renderHook(() =>
      useApnsTripRegistration({ route: null, destination: null, nextStationEtaSeconds: null }),
    );
    // 첫 getItem(APNS_TOKEN_KEY)을 통과시키고 두 번째 getItem(ACTIVE_TRIP_KEY)에서 멈추기 위해 microtask 양보
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    mockClear.mockClear();
    await act(async () => {
      resolvePrev('token-abc');
      await Promise.resolve();
    });
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('#669 unmount/deps 변경 후 register resolve도 ACTIVE_TRIP_KEY 저장 — race로 잃지 않음', async () => {
    let resolveReg!: (v: { ok: boolean }) => void;
    mockRegister.mockImplementation(
      () => new Promise((res) => { resolveReg = res; }),
    );
    const { unmount } = renderHook(() =>
      useApnsTripRegistration({
        route: directRoute,
        destination: station,
        nextStationEtaSeconds: 120,
      }),
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalled());
    unmount();
    (AsyncStorage.setItem as jest.Mock).mockClear();
    await act(async () => {
      resolveReg({ ok: true });
      await Promise.resolve();
    });
    // backend register 성공 → cleanup 후에도 ACTIVE_TRIP_KEY 동기화 (DebugModal activeTrip 정확도).
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(ACTIVE_TRIP_KEY, 'token-abc');
  });

  it('nextStationEtaSeconds > 0 이면 alarmAt = now + eta*1000', async () => {
    const fixed = new Date('2026-05-13T12:00:00Z').getTime();
    jest.spyOn(Date, 'now').mockReturnValue(fixed);
    renderHook(() =>
      useApnsTripRegistration({
        route: directRoute,
        destination: station,
        nextStationEtaSeconds: 300,
      }),
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalled());
    expect(mockRegister.mock.calls[0][0].alarmAtEpochMs).toBe(fixed + 300 * 1000);
    (Date.now as jest.Mock).mockRestore();
  });

  it('route 객체 reference만 바뀌고 내용이 같으면 register 재호출하지 않는다', async () => {
    const { rerender } = renderHook(
      ({ route }: { route: Route }) =>
        useApnsTripRegistration({ route, destination: station, nextStationEtaSeconds: 120 }),
      { initialProps: { route: makeDirectRoute(5, '2') as Route } },
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    // 내용 동일, reference만 신규
    rerender({ route: makeDirectRoute(5, '2') as Route });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('#589 — 같은 (token, route, destination)으로 재호출 시 동일 createdAt 전달', async () => {
    // #703: eta 변경은 더 이상 재등록을 유발하지 않는다. 같은 세션 재등록은
    // boardingLock 토글로 트리거 (session key = token+routeSig+destinationId, lock은 미포함).
    const lock = {
      destinationId: station.id,
      trainCode: '7246',
      boardingStationId: station.id,
      boardingLine: '2' as const,
      boardedAt: 1_700_000_000_000,
      expectedDurationMs: 600_000,
    };
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const { rerender } = renderHook(
      ({ bl }: { bl: typeof lock | null }) =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          boardingLock: bl,
        }),
      { initialProps: { bl: null as typeof lock | null } },
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    const firstCreatedAt = mockRegister.mock.calls[0][0].createdAt as number;
    expect(firstCreatedAt).toBe(1_700_000_000_000);

    // boardingLock 추가 → 같은 session key 재등록
    now = 1_700_000_999_999;
    rerender({ bl: lock });
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
    expect(mockRegister.mock.calls[1][0].createdAt).toBe(firstCreatedAt);
    (Date.now as jest.Mock).mockRestore();
  });

  it('#703 — nextStationEtaSeconds만 바뀌면 register 재호출 안 함 (30s polling churn 차단)', async () => {
    const { rerender } = renderHook(
      ({ eta }: { eta: number }) =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: eta,
        }),
      { initialProps: { eta: 120 } },
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    rerender({ eta: 60 });
    rerender({ eta: 30 });
    rerender({ eta: null as unknown as number });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('#703 — currentStation만 바뀌면 register 재호출 안 함', async () => {
    // #2150 — cold-start currentStation을 route 위 유효 station(선릉, 2-020)으로 세팅해 첫
    // register부터 promptContext를 확보한다(lastRegisterMissingContextRef=false 고정). 이렇게
    // 하면 Tier 1 context-heal(별도 effect, #2130/#2150)이 전혀 발동하지 않아 이 테스트가 검증하려는
    // "currentStation은 main register effect의 deps가 아니다" 항목만 순수하게 검증된다.
    const initialStation: Station = { ...station, id: '2-020', name: '선릉' };
    const altStation: Station = { ...station, id: '2-023', name: '역삼' };
    const { rerender } = renderHook(
      ({ cs }: { cs: Station | null }) =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          currentStation: cs,
        }),
      { initialProps: { cs: initialStation as Station | null } },
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    expect(mockRegister.mock.calls[0][0].promptGeoContext).toBeDefined();
    rerender({ cs: station });
    rerender({ cs: altStation });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('#589 — route 내용 변경 시 새 createdAt 발급', async () => {
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const { rerender } = renderHook(
      ({ route }: { route: Route }) =>
        useApnsTripRegistration({ route, destination: station, nextStationEtaSeconds: 120 }),
      { initialProps: { route: makeDirectRoute(5, '2') as Route } },
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    const first = mockRegister.mock.calls[0][0].createdAt as number;

    now = 1_700_000_500_000;
    rerender({ route: makeDirectRoute(6, '2') as Route });
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
    expect(mockRegister.mock.calls[1][0].createdAt).toBe(1_700_000_500_000);
    expect(mockRegister.mock.calls[1][0].createdAt).not.toBe(first);
    (Date.now as jest.Mock).mockRestore();
  });

  it('#589 — destination 변경 시 새 createdAt 발급', async () => {
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const altStation: Station = { ...station, id: '0229', name: '역삼' };
    const { rerender } = renderHook(
      ({ d }: { d: Station }) =>
        useApnsTripRegistration({ route: directRoute, destination: d, nextStationEtaSeconds: 120 }),
      { initialProps: { d: station } },
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    const first = mockRegister.mock.calls[0][0].createdAt as number;

    now = 1_700_000_777_777;
    rerender({ d: altStation });
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
    expect(mockRegister.mock.calls[1][0].createdAt).toBe(1_700_000_777_777);
    expect(mockRegister.mock.calls[1][0].createdAt).not.toBe(first);
    (Date.now as jest.Mock).mockRestore();
  });

  it('#589 — token refresh 시 새 createdAt 발급 (새 세션 키)', async () => {
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    renderHook(() =>
      useApnsTripRegistration({
        route: directRoute,
        destination: station,
        nextStationEtaSeconds: 120,
      }),
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    const first = mockRegister.mock.calls[0][0].createdAt as number;
    const listener = mockAddPushTokenListener.mock.calls[0][0];

    now = 1_700_000_333_333;
    await act(async () => {
      listener({ data: 'token-NEW' });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ token: 'token-NEW' })),
    );
    const refreshed = mockRegister.mock.calls.find(
      (c) => (c[0] as { token: string }).token === 'token-NEW',
    );
    expect(refreshed?.[0].createdAt).toBe(1_700_000_333_333);
    expect(refreshed?.[0].createdAt).not.toBe(first);
    (Date.now as jest.Mock).mockRestore();
  });

  it('route 내용이 바뀌면 register 재호출한다 (signature 변경)', async () => {
    const { rerender } = renderHook(
      ({ route }: { route: Route }) =>
        useApnsTripRegistration({ route, destination: station, nextStationEtaSeconds: 120 }),
      { initialProps: { route: makeDirectRoute(5, '2') as Route } },
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    rerender({ route: makeDirectRoute(6, '2') as Route });
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
  });

  describe('#622 boardingLock 송신', () => {
    // 강남(2-022)이 stations.json에 실제 존재해야 segmentStations 추론 성공.
    // buildBoardingLockMeta는 boardingStationId('2-022')로 lookup 후 segment를 만든다.
    const lockFor7 = {
      destinationId: station.id,
      trainCode: '7246',
      boardingStationId: station.id, // 강남 (2호선) — boardingLine=2와 일치
      boardingLine: '2' as const,
      boardedAt: 1_700_000_000_000,
      expectedDurationMs: 600_000,
    };

    it('boardingLock 전달 시 callRegister payload.boardingLock에 schema 변환된 객체 포함', async () => {
      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          currentStation: station,
          boardingLock: lockFor7,
        }),
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalled());
      const args = mockRegister.mock.calls[0][0];
      expect(args.boardingLock).toBeDefined();
      expect(args.boardingLock).toMatchObject({
        trainCode: '7246',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: lockFor7.boardedAt,
      });
      expect(args.boardingLock.segmentStations.length).toBeGreaterThan(0);
    });

    it('#1366 boardingLock line ↔ route line 불일치 시 metadata skip (transient transfer state)', async () => {
      const mismatchedLock = { ...lockFor7, boardingLine: '7' as const };
      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute, // line='2'
          destination: station,
          nextStationEtaSeconds: 120,
          currentStation: station,
          boardingLock: mismatchedLock,
        }),
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalled());
      const args = mockRegister.mock.calls[0][0];
      expect(args.boardingLock).toBeUndefined();
    });

    it('boardingLock null이면 payload.boardingLock 누락', async () => {
      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          currentStation: station,
          boardingLock: null,
        }),
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalled());
      const args = mockRegister.mock.calls[0][0];
      expect(args.boardingLock).toBeUndefined();
    });

    it('boardingLock 내용이 같으면 reference만 달라도 재등록 안 함 (sig 기반 deps)', async () => {
      const sameContent = { ...lockFor7 };
      const { rerender } = renderHook(
        ({ lock }: { lock: typeof lockFor7 }) =>
          useApnsTripRegistration({
            route: directRoute,
            destination: station,
            nextStationEtaSeconds: 120,
            currentStation: station,
            boardingLock: lock,
          }),
        { initialProps: { lock: lockFor7 } },
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      rerender({ lock: sameContent }); // 새 object reference, 같은 내용
      // 한 틱 대기해도 추가 호출 없어야 함
      await new Promise((r) => setTimeout(r, 50));
      expect(mockRegister).toHaveBeenCalledTimes(1);
    });

    it('boardingLock 변경 시 재등록 (deps 포함 확인)', async () => {
      const { rerender } = renderHook(
        ({ lock }: { lock: typeof lockFor7 | null }) =>
          useApnsTripRegistration({
            route: directRoute,
            destination: station,
            nextStationEtaSeconds: 120,
            currentStation: station,
            boardingLock: lock,
          }),
        { initialProps: { lock: null as typeof lockFor7 | null } },
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      rerender({ lock: lockFor7 });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
    });

    it('boardingLock 있지만 boardingStationId가 stations.json에 없으면 meta 없이 송신', async () => {
      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          currentStation: station,
          boardingLock: { ...lockFor7, boardingStationId: '__no_such_id__' },
        }),
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalled());
      const args = mockRegister.mock.calls[0][0];
      expect(args.boardingLock).toBeUndefined();
    });

    it('#865 — SCHED-* 시간표 fallback trainCode면 payload.boardingLock 누락 (backend 누설 차단)', async () => {
      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          currentStation: station,
          boardingLock: { ...lockFor7, trainCode: 'SCHED-UP-1' },
        }),
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalled());
      const args = mockRegister.mock.calls[0][0];
      expect(args.boardingLock).toBeUndefined();
    });
  });

  describe('#767 boardingLock 해제 race 차단 (debounce)', () => {
    // PR #765 evidence: lock A → null → 새 lock B로 빠르게 swap하면 25초 안에 3 POST 발사,
    // 첫 null POST가 backend KV의 옛 lock을 unset해 새 lock POST의 existingHasLock=false 회귀.
    // 본 그룹은 lock 해제 전환(non-null → null)만 debounce하고 다른 전환은 즉시 발사함을 검증.

    const lockA = {
      destinationId: station.id,
      trainCode: '7246',
      boardingStationId: station.id,
      boardingLine: '2' as const,
      boardedAt: 1_700_000_000_000,
      expectedDurationMs: 600_000,
    };
    const lockB = { ...lockA, trainCode: '7415', boardedAt: 1_700_000_500_000 };
    type Lock = typeof lockA;

    // CPD 해소: 8 케이스가 공유하는 (lock prop 기반 mount + microtask flush + 첫 register 발사)
    // 셋업을 helper로 묶어 한 줄로 표현. PR #760의 mountAtT0 정신.
    const mountWithLock = (initialLock: Lock | null) =>
      renderHook(
        ({ lock }: { lock: Lock | null }) =>
          useApnsTripRegistration({
            route: directRoute,
            destination: station,
            nextStationEtaSeconds: 120,
            currentStation: station,
            boardingLock: lock,
          }),
        { initialProps: { lock: initialLock } },
      );
    const flushMicrotasks = async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    const flushOnce = async () => {
      await act(async () => {
        await Promise.resolve();
      });
    };

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('lock → null 전환은 debounce window 안에 POST 발사 안 함', async () => {
      const { rerender } = mountWithLock(lockA);
      // 첫 register (lock A) 발사
      await flushMicrotasks();
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // lock 해제 — debounce window 안엔 POST 안 보내야 함
      rerender({ lock: null });
      await flushOnce();
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // window 미만 advance (안전 마진)
      act(() => { jest.advanceTimersByTime(BOARDING_LOCK_RELEASE_DEBOUNCE_MS - 100); });
      expect(mockRegister).toHaveBeenCalledTimes(1);
    });

    it('lock → null 후 debounce 안에 새 lock 들어오면 null POST는 cancel되고 새 lock POST만 발사', async () => {
      const { rerender } = mountWithLock(lockA);
      await flushMicrotasks();
      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockRegister.mock.calls[0][0].boardingLock.trainCode).toBe('7246');

      // 옛 lock release
      rerender({ lock: null });
      await flushOnce();
      // window 미만 진행
      act(() => { jest.advanceTimersByTime(500); });
      expect(mockRegister).toHaveBeenCalledTimes(1); // 아직 null POST 안 나감

      // 새 lock 잡힘 — 옛 null POST는 useEffect cleanup으로 cancel
      rerender({ lock: lockB });
      await flushMicrotasks();

      // 잔여 timer 모두 flush — 옛 null POST가 살아있다면 여기서 발사됨
      act(() => { jest.advanceTimersByTime(BOARDING_LOCK_RELEASE_DEBOUNCE_MS * 2); });
      await flushOnce();

      // 총 2회만 호출 (lock A + lock B). null POST는 발사 안 됨.
      expect(mockRegister).toHaveBeenCalledTimes(2);
      expect(mockRegister.mock.calls[1][0].boardingLock.trainCode).toBe('7415');
      // 어떤 호출도 boardingLock=undefined로 backend에 가지 않음
      mockRegister.mock.calls.forEach((c) => {
        expect(c[0].boardingLock).toBeDefined();
      });
    });

    it('lock → null 후 debounce window 경과하면 null POST 발사 (true release 의도)', async () => {
      const { rerender } = mountWithLock(lockA);
      await flushMicrotasks();
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // 옛 lock release — debounce window 경과 후 null POST 발사
      rerender({ lock: null });
      await flushOnce();
      act(() => { jest.advanceTimersByTime(BOARDING_LOCK_RELEASE_DEBOUNCE_MS + 100); });
      await flushMicrotasks();

      expect(mockRegister).toHaveBeenCalledTimes(2);
      expect(mockRegister.mock.calls[1][0].boardingLock).toBeUndefined();
    });

    it('null → lock 전환(초기 lock 부여)은 debounce 미적용 — 즉시 발사', async () => {
      const { rerender } = mountWithLock(null);
      // 첫 register (lock 없음) — 즉시 발사
      await flushMicrotasks();
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // lock 잡힘 — debounce 없이 즉시 발사
      rerender({ lock: lockA });
      await flushMicrotasks();
      expect(mockRegister).toHaveBeenCalledTimes(2);
      expect(mockRegister.mock.calls[1][0].boardingLock.trainCode).toBe('7246');
    });

    it('lock → 다른 lock 직접 교체(swap)는 debounce 미적용 — 즉시 발사', async () => {
      const { rerender } = mountWithLock(lockA);
      await flushMicrotasks();
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // 옛 lock → 새 lock 직접 교체 (null 거치지 않음) — 즉시 발사
      rerender({ lock: lockB });
      await flushMicrotasks();
      expect(mockRegister).toHaveBeenCalledTimes(2);
      expect(mockRegister.mock.calls[1][0].boardingLock.trainCode).toBe('7415');
    });

    it('lock 보유 중 트립 종료(route/destination 모두 null)는 debounce 미적용 — 즉시 clear', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === APNS_TOKEN_KEY) return 'token-abc';
        if (key === ACTIVE_TRIP_KEY) return 'token-abc';
        return null;
      });
      // 본 케이스만 route/destination도 같이 바꿔야 해서 mountWithLock 대신 인라인 유지.
      const { rerender } = renderHook(
        ({ r, d, lock }: { r: Route; d: Station | null; lock: Lock | null }) =>
          useApnsTripRegistration({
            route: r,
            destination: d,
            nextStationEtaSeconds: 120,
            currentStation: station,
            boardingLock: lock,
          }),
        {
          initialProps: {
            r: directRoute as Route,
            d: station as Station | null,
            lock: lockA as Lock | null,
          },
        },
      );
      await flushMicrotasks();
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // 트립 종료 — route/destination 모두 null + lock도 null
      mockClear.mockClear();
      rerender({ r: null, d: null, lock: null });
      await flushMicrotasks();

      // clear 즉시 호출 (debounce 안 걸림)
      expect(mockClear).toHaveBeenCalledWith('token-abc');
    });

    it('debounce window 안에 unmount되면 옛 null POST도 cancel — 누수 없음', async () => {
      const { rerender, unmount } = mountWithLock(lockA);
      await flushMicrotasks();
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // 옛 lock release → debounce 시작
      rerender({ lock: null });
      await flushOnce();
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // window 미만에서 unmount — cleanup이 clearTimeout으로 timer 제거 + run()의 cancelled 가드
      unmount();
      act(() => { jest.advanceTimersByTime(BOARDING_LOCK_RELEASE_DEBOUNCE_MS * 2); });
      await flushOnce();
      expect(mockRegister).toHaveBeenCalledTimes(1);
    });

    it('token refresh 경로도 lastSentLockSig 추적 — 다음 main effect cycle의 release 판정에 일관', async () => {
      // 초기엔 lock A 들고 시작 — 첫 register는 main effect 경로.
      // 본 케이스는 rerender 불필요 — props 고정 mount면 충분.
      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          currentStation: station,
          boardingLock: lockA,
        }),
      );
      await flushMicrotasks();
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // token refresh — listener가 자체적으로 register 발사 + lastSentLockSig 갱신
      const listener = mockAddPushTokenListener.mock.calls[0][0];
      await act(async () => {
        listener({ data: 'token-NEW' });
        await Promise.resolve();
        await Promise.resolve();
      });

      // 새 토큰으로 register 호출됨 (lockA 포함)
      const refreshed = mockRegister.mock.calls.find(
        (c) => (c[0] as { token: string }).token === 'token-NEW',
      );
      expect(refreshed?.[0].boardingLock).toBeDefined();
      expect(refreshed?.[0].boardingLock.trainCode).toBe('7246');
    });
  });

  describe('#1960 (2026-08-04 RCA 보강) — register 실패/token 미가용 재시도', () => {
    const lock = {
      destinationId: station.id,
      trainCode: '7246',
      boardingStationId: station.id,
      boardingLine: '2' as const,
      boardedAt: 1_700_000_000_000,
      expectedDurationMs: 600_000,
    };

    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('POST 실패({ok:false}) 시 backoff 후 재시도 — lock 활성 trip이 이후 lock 동봉으로 성공한다', async () => {
      // 2026-08-04 아침 evidence 재현: lock 활성 중 첫 POST 실패 → 이전에는 재시도가 없어
      // 다음 정상 register(주로 lock 해제 직후)에야 처음 backend에 도달했다.
      mockRegister.mockResolvedValueOnce({ ok: false, status: 500 });
      mockRegister.mockResolvedValueOnce({ ok: true });

      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          currentStation: station,
          boardingLock: lock,
        }),
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // 첫 backoff(15s) 전에는 재시도 없음.
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[0] - 100);
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // 15s 경과 → 재시도 발사, lock이 여전히 동봉된 채로 성공.
      await act(async () => {
        jest.advanceTimersByTime(200);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(2);
      expect(mockRegister.mock.calls[1][0].boardingLock.trainCode).toBe('7246');

      // 성공 후 재시도 상태가 초기화돼 추가 backoff가 지나도 3번째 호출 없음.
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[1] + 1000);
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(2);
    });

    it('APNs token 미가용 skip 시 재시도 — 토큰 발급 후 lock 동봉 register 성공', async () => {
      let tokenAvailable = false;
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === APNS_TOKEN_KEY) return tokenAvailable ? 'token-late' : null;
        return null;
      });

      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          currentStation: station,
          boardingLock: lock,
        }),
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).not.toHaveBeenCalled(); // 토큰 없음 — graceful skip

      tokenAvailable = true;
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[0]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockRegister.mock.calls[0][0].token).toBe('token-late');
      expect(mockRegister.mock.calls[0][0].boardingLock.trainCode).toBe('7246');
    });

    it('상한(sessionKey당 3회) 도달 후 추가 재시도 없음 — 다음 정상 effect cycle에 위임', async () => {
      mockRegister.mockResolvedValue({ ok: false, status: 500 });

      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          currentStation: station,
        }),
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1);

      for (const delay of REGISTER_RETRY_BACKOFF_MS) {
        await act(async () => {
          jest.advanceTimersByTime(delay);
          await Promise.resolve();
          await Promise.resolve();
        });
      }
      // 최초 1회 + backoff 배열 길이(3)만큼 재시도 = 4회.
      expect(mockRegister).toHaveBeenCalledTimes(1 + REGISTER_RETRY_BACKOFF_MS.length);

      // 상한 도달 후 추가 시간이 지나도 더 이상 호출 없음.
      await act(async () => {
        jest.advanceTimersByTime(120_000);
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1 + REGISTER_RETRY_BACKOFF_MS.length);
    });

    it('재시도 대기 중 trip 전환(destination 변경)되면 예약된 재시도는 self-cancel', async () => {
      mockRegister.mockResolvedValueOnce({ ok: false, status: 500 });
      mockRegister.mockResolvedValue({ ok: true });
      const otherDestination: Station = { ...station, id: '2-023', name: '역삼' };

      const { rerender } = renderHook(
        ({ d }: { d: Station }) =>
          useApnsTripRegistration({
            route: directRoute,
            destination: d,
            nextStationEtaSeconds: 120,
            currentStation: d,
          }),
        { initialProps: { d: station } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1); // 실패 — 재시도 예약됨

      // trip 전환 — 새 destination으로 즉시 register(성공).
      rerender({ d: otherDestination });
      await act(async () => {
        await Promise.resolve();
      });
      const callsAfterSwitch = mockRegister.mock.calls.length;
      expect(callsAfterSwitch).toBeGreaterThanOrEqual(2);

      // 옛 세션의 backoff가 지나도 추가 register 없음(self-cancel) — 구 trip으로의 stale register 차단.
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[0] + 1000);
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(callsAfterSwitch);
    });

    it('재시도 대기 중 다른 세션으로 실패 전환되면 옛 세션의 타이머를 clear하고 새 세션 attempt 0부터 시작', async () => {
      mockRegister.mockResolvedValue({ ok: false, status: 500 });
      const otherDestination: Station = { ...station, id: '2-023', name: '역삼' };
      // #2150 — currentStation을 destination과 분리해 고정 null로 둔다. 이전에는 currentStation
      // 이 destination(d)과 같은 값으로 묶여 있어, destination 전환이 곧 currentStation.id 전환도
      // 발생시켜 Tier 1 context-heal effect가 추가 register를 유발했다(재시도 카운트 assertion과
      // 무관한 관심사 충돌). 이 테스트의 목적은 순수 register-retry 세션 전환 검증이므로
      // currentStation을 고정(null)해 Tier 1 heal effect 자체가 재실행되지 않게 한다.
      const { rerender } = renderHook(
        ({ d }: { d: Station }) =>
          useApnsTripRegistration({
            route: directRoute,
            destination: d,
            nextStationEtaSeconds: 120,
            currentStation: null,
          }),
        { initialProps: { d: station } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1); // 세션 A 실패 — 15s 재시도 예약

      // 세션 A의 재시도가 발화하기 전에 세션 B로 전환 — B도 즉시 실패.
      rerender({ d: otherDestination });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(2); // 세션 B 실패 — 새 15s 재시도 예약(attempt 0부터)

      // 세션 A의 원래 15s 시점이 지나도 추가 호출 없음(A의 타이머는 세션 전환 시 clear됨) —
      // 세션 B의 15s 재시도만 발화 — 총 3회.
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[0]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(3);
    });

    it('token이 여러 backoff를 넘겨도 계속 미가용이면 재시도를 이어간다', async () => {
      let tokenAvailable = false;
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === APNS_TOKEN_KEY) return tokenAvailable ? 'token-late2' : null;
        return null;
      });

      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          currentStation: station,
        }),
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).not.toHaveBeenCalled();

      // 첫 backoff(15s) 시점에도 토큰 여전히 없음 — 두 번째 backoff(30s)를 예약.
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[0]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).not.toHaveBeenCalled();

      tokenAvailable = true;
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[1]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockRegister.mock.calls[0][0].token).toBe('token-late2');
    });

    it('대기 중인 재시도 타이머가 있는 상태에서 같은 세션이 다시 실패하면 타이머를 갈아치운다', async () => {
      mockRegister.mockResolvedValue({ ok: false, status: 500 });
      const { rerender } = renderHook(
        ({ sub }: { sub: boolean }) =>
          useApnsTripRegistration({
            route: directRoute,
            destination: station,
            nextStationEtaSeconds: 120,
            currentStation: station,
            subsurface: sub,
          }),
        { initialProps: { sub: false } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1); // 실패 — 15s 재시도 예약

      // 첫 backoff가 발화하기 전, 같은 세션에서 subsurface 토글로 즉시 재실행 → 다시 실패.
      rerender({ sub: true });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(2); // 실패 — 기존 15s 타이머를 clear하고 다음 backoff(30s)로 재schedule

      // 원래 예정이던 첫 backoff(15s) 시점엔 아직 발화 안 함 — 옛 타이머가 clear되고
      // attempt가 이미 1로 진행돼 있어 다음 예약은 backoff[1](30s) 기준.
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[0] + 100);
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(2);

      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[1]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(3);
    });

    it('register 성공(ok:true)은 재시도를 트리거하지 않음 — dedup 폭주 방지(#703) 보존', async () => {
      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          currentStation: station,
        }),
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(
          REGISTER_RETRY_BACKOFF_MS[REGISTER_RETRY_BACKOFF_MS.length - 1] * 5,
        );
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1);
    });
  });

  describe('#2167 — context-heal(Tier 1) ↔ register-retry(#1960) 상호 조율', () => {
    // 단조 3호선 대화(3-001) → 정발산(3-003): buildBoardingPromptContext non-null 반환 보장.
    const origin: Station = {
      id: '3-001',
      name: '대화',
      line: '3',
      lat: 37.676087,
      lng: 126.747569,
      lineColor: '#EF7C1C',
    };
    const dest: Station = {
      id: '3-003',
      name: '정발산',
      line: '3',
      lat: 37.659477,
      lng: 126.773359,
      lineColor: '#EF7C1C',
    };
    const route3 = makeDirectRoute(2, '3');

    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('register-retry 대기 중 currentStation이 null→non-null로 전환되면 Tier 1 heal이 별도 POST를 쏘지 않고 대기 중인 재시도에 위임한다', async () => {
      // 2167 회귀 재현: cold-start register 실패 → 15s 재시도 예약. 그 대기 창 안에서
      // GPS/fusion이 currentStation을 해소하면(#2130 Tier 1 heal 트리거 조건 충족) 이전에는
      // Tier 1이 재시도와 무관하게 즉시 독립 POST를 쏴 거의 동일 payload가 겹쳤다.
      mockRegister.mockResolvedValueOnce({ ok: false, status: 500 });
      mockRegister.mockResolvedValueOnce({ ok: true });

      const { rerender } = renderHook(
        ({ cs }: { cs: Station | null }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
          }),
        { initialProps: { cs: null as Station | null } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1); // 실패 — 15s 재시도 예약 + context 결손 기록

      // 재시도 backoff(15s) 전에 currentStation이 해소(null→origin, on-route) — Tier 1 heal
      // 트리거 조건(전환 + context 결손 + 세션 미heal)을 모두 충족하지만, 대기 중인 재시도가
      // 있으므로 heal은 자체 POST를 쏘지 않고 skip해야 한다.
      rerender({ cs: origin });
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[0] - 100);
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1); // heal이 독립 발사했다면 여기서 2가 됨(회귀)

      // 재시도가 예정대로 발화 — latestInputsRef가 이미 해소된 origin을 반영하므로 이 한 건의
      // POST가 재시도와 heal 목적을 동시에 달성한다(fresh context 포함, 이중 POST 없음).
      await act(async () => {
        jest.advanceTimersByTime(200);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(2);
      const healedViaRetry = mockRegister.mock.calls[1][0] as {
        promptGeoContext?: { origin: { lat: number; lng: number } };
        promptDisplay?: { originStation: string; line: string };
      };
      expect(healedViaRetry.promptGeoContext?.origin).toEqual({ lat: origin.lat, lng: origin.lng });
      expect(healedViaRetry.promptDisplay).toEqual({ originStation: '대화', line: '3' });

      // 이후 시간이 더 지나도(Tier 2 지연 포함) 추가 POST 없음 — 재시도 성공으로 양쪽 loop 모두 해소.
      await act(async () => {
        jest.advanceTimersByTime(CONTEXT_HEAL_TIER2_DELAY_MS + 1000);
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(2);
    });

    it('합산 POST 상한 회귀 가드 — 재시도 대기 중 currentStation이 여러 번 흔들려도 heal이 추가 POST를 쌓지 않는다', async () => {
      mockRegister.mockResolvedValueOnce({ ok: false, status: 500 });
      mockRegister.mockResolvedValue({ ok: true });
      const anotherOnRouteStation: Station = { ...origin, id: '3-002', name: '주엽' };

      const { rerender } = renderHook(
        ({ cs }: { cs: Station | null }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
          }),
        { initialProps: { cs: null as Station | null } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1); // 실패 — 재시도 예약

      // 재시도 대기 중 currentStation이 두 번 더 흔들림(GPS jitter) — 매번 Tier 1 heal 트리거
      // 조건은 충족되지만 재시도 in-flight/pending 상태라 추가 POST가 쌓이면 안 된다.
      rerender({ cs: origin });
      await act(async () => {
        jest.advanceTimersByTime(2000);
        await Promise.resolve();
      });
      rerender({ cs: anotherOnRouteStation });
      await act(async () => {
        jest.advanceTimersByTime(2000);
        await Promise.resolve();
      });
      // 15s 예약 시점 전 — 합산 POST는 여전히 1건.
      expect(mockRegister).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[0]);
        await Promise.resolve();
        await Promise.resolve();
      });
      // 재시도 1건만 추가 — 합산 2건 상한(초기 1 + 재시도 1) 준수. heal 폭주로 3건 이상 되지 않는다.
      expect(mockRegister).toHaveBeenCalledTimes(2);
    });

    it('반대 방향 — Tier 1 heal POST가 in-flight인 동안 register-retry 타이머가 발화하면 겹쳐 쏘지 않고 다음 backoff로 재예약한다', async () => {
      // 위 테스트가 "재시도 대기 중 heal 트리거"를 재현했다면, 이 테스트는 그 반대 순서를 재현한다:
      // Tier 1 heal이 먼저 시작(retry가 아직 없던 시점이라 heal이 정상 발사)해 네트워크 응답을
      // 기다리는 도중, 별개 dep(subsurface) 변경으로 main effect가 재실행되며 실패해 같은 세션에
      // 대해 새 재시도가 예약된다. 그 backoff가 heal이 아직 응답을 못 받은 채로 발화하면, 이전에는
      // attemptRegisterRetry가 heal과 무관하게 즉시 겹쳐 POST했다.
      mockRegister.mockResolvedValueOnce({ ok: true }); // cold-start(성공하지만 currentStation=null → context 결손)

      let resolveHealRegister!: (value: { ok: boolean }) => void;
      const healDeferred = new Promise<{ ok: boolean }>((resolve) => {
        resolveHealRegister = resolve;
      });

      const { rerender } = renderHook(
        ({ cs, sub }: { cs: Station | null; sub: boolean }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
            subsurface: sub,
          }),
        { initialProps: { cs: null as Station | null, sub: false } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1); // cold-start 성공, context 결손 기록

      // Tier 1 heal 트리거 — 이 시점엔 대기 중인 재시도가 없으므로 heal이 정상 발사되고,
      // registerActiveTrip 응답을 기다리며 pending 상태에 머문다(healInFlightSessionKeyRef 세팅).
      mockRegister.mockImplementationOnce(() => healDeferred);
      rerender({ cs: origin, sub: false });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));

      // 별개 dep(subsurface) 변경으로 main effect 재실행 — 이번엔 실패해 같은 세션에 재시도 예약(15s).
      mockRegister.mockResolvedValueOnce({ ok: false, status: 500 });
      rerender({ cs: origin, sub: true });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(3);

      // 15s 경과 — 재시도 타이머 발화 시점에도 heal(2번째 호출)은 여전히 응답 대기 중(in-flight).
      // 겹쳐 쏘지 않고 다음 backoff(30s)로 재예약해야 한다 — 아직 register 호출 없음.
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[0]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(3); // heal in-flight 동안 겹쳐 쏘지 않음(회귀라면 4)

      // heal이 완료(성공)되면 in-flight가 풀린다 — 재예약된 backoff(30s)가 도래하면 그때 재시도.
      mockRegister.mockResolvedValueOnce({ ok: true });
      resolveHealRegister({ ok: true });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[1]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(4); // heal 완료 후 재예약된 재시도가 정상 발화
    });

    it('P1 (PR #2169 리뷰) — cold-start register 실패 + 지하 dead-zone 조건에서 retry가 성공할 때 Tier 2 fallback context를 함께 실어 보낸다 (영구 결손 회귀 재현)', async () => {
      // 회귀 배경: Tier 2 fallback 타이머는 main effect의 register가 "직접" 성공했을 때만
      // arm된다. cold-start register가 실패해 재시도가 예약되면 Tier 2는 애초에 armed되지
      // 않고, 재시도가 나중에 성공해도(Tier 2 override 없이) currentStation이 계속 null인
      // 지하 dead-zone 세션은 promptGeoContext/promptDisplay가 영구히 비어 있게 된다. 이
      // 테스트는 그 결손을 재현하고, 수정 후에는 retry 자신이 Tier 2 override를 실어 보내야
      // 한다.
      const routeOrigin = st('3-002'); // 주엽 — origin/dest 사이 실제 3호선 역, build 항상 성공.
      mockRegister.mockResolvedValueOnce({ ok: false, status: 500 }); // cold-start 실패
      mockRegister.mockResolvedValueOnce({ ok: true }); // retry 성공

      renderHook(() =>
        useApnsTripRegistration({
          route: route3,
          destination: dest,
          nextStationEtaSeconds: 120,
          currentStation: null,
          subsurface: true,
          routeOriginStation: routeOrigin,
        }),
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1); // cold-start 실패 — 15s 재시도 예약

      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[0]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(2); // 재시도 성공

      const retrySuccessPayload = mockRegister.mock.calls[1][0] as {
        promptGeoContext?: { origin: { lat: number; lng: number } };
        promptDisplay?: { originStation: string; line: string };
      };
      // 수정 전에는 이 두 필드가 모두 undefined(영구 결손). 수정 후엔 Tier 2 override가 함께 실린다.
      expect(retrySuccessPayload.promptGeoContext?.origin).toEqual({
        lat: routeOrigin.lat,
        lng: routeOrigin.lng,
      });
      expect(retrySuccessPayload.promptDisplay).toEqual({
        originStation: routeOrigin.name,
        line: routeOrigin.line,
      });

      // 이미 이 재시도로 context를 확보했으므로(healedSessionKeyRef 잠금), Tier 2 지연 시점이
      // 지나도 추가 register가 없어야 한다 — 중복 없이 정확히 1회로 충분.
      await act(async () => {
        jest.advanceTimersByTime(CONTEXT_HEAL_TIER2_DELAY_MS + 1000);
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(2);
    });

    it('P1 (재검증 리뷰) — override 적용 + POST 실패 반복 → 세션 미잠금 → 이후 Tier 1 재발동 가능', async () => {
      // 회귀 배경: attemptRegisterRetry가 tier2Override를 적용할 때 await 이전(attempt 기준)에
      // healedSessionKeyRef를 잠그면, backend 장애(Seoul outage류)로 register-retry 예산
      // (3회)이 전부 network 실패로 소진될 때 "잠금은 걸려 있고 context는 한 번도 안 실린" 상태로
      // 고착된다 — 이후 지상 재진입으로 currentStation이 다시 잡혀도 Tier 1이 이 잠금에 막혀
      // 영구 결손이 재발한다(#2166이 Tier 1에서 이미 고친 것과 동일 클래스의 회귀).
      const routeOrigin = st('3-002'); // 주엽 — routeOriginStation(Tier 2 override 기준).
      const onRouteStation = origin; // 대화 — 이후 실제 GPS 해소로 Tier 1이 사용할 역(override와 다른 역).

      mockRegister.mockResolvedValue({ ok: false, status: 500 }); // cold-start + 모든 재시도 network 실패

      const { rerender } = renderHook(
        ({ cs }: { cs: Station | null }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
            subsurface: true,
            routeOriginStation: routeOrigin,
          }),
        { initialProps: { cs: null as Station | null } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1); // cold-start 실패 — 15s 재시도 예약

      // REGISTER_RETRY_BACKOFF_MS 전체(3회)를 모두 network 실패로 소진 — 매 시도마다
      // tier2Override 조건은 충족되지만(override != null) POST 자체가 실패한다.
      for (const delay of REGISTER_RETRY_BACKOFF_MS) {
        // eslint-disable-next-line no-loop-func -- delay는 매 반복 고정값 캡처, closure 문제 없음.
        await act(async () => {
          jest.advanceTimersByTime(delay);
          await Promise.resolve();
          await Promise.resolve();
        });
      }
      // 최초 1회 + backoff 배열 길이(3)만큼 재시도 = 4회, 전부 실패 — 재시도 예산 소진.
      expect(mockRegister).toHaveBeenCalledTimes(1 + REGISTER_RETRY_BACKOFF_MS.length);

      // 재시도 예산이 소진된 뒤, GPS가 실제로 해소돼(같은 hook 인스턴스에서) currentStation이
      // null→non-null로 전환. 버그(attempt 기준 잠금)가 있다면 healedSessionKeyRef가 이미
      // 잠겨 있어 Tier 1이 skip — 수정 후에는 한 번도 성공하지 못했으므로 잠금이 없어 Tier 1이
      // 정상 발동해야 한다.
      mockRegister.mockResolvedValueOnce({ ok: true });
      rerender({ cs: onRouteStation });
      await waitFor(() =>
        expect(mockRegister).toHaveBeenCalledTimes(1 + REGISTER_RETRY_BACKOFF_MS.length + 1),
      );
      const healedPayload = mockRegister.mock.calls[mockRegister.mock.calls.length - 1][0] as {
        promptGeoContext?: { origin: { lat: number; lng: number } };
      };
      expect(healedPayload.promptGeoContext?.origin).toEqual({
        lat: onRouteStation.lat,
        lng: onRouteStation.lng,
      });
    });

    it('P2-1 (PR #2169 리뷰) — heal-busy 재예약은 register-retry의 attempt 예산을 소모하지 않는다', async () => {
      // 회귀 배경: heal-busy로 인한 재예약이 실제 register 실패와 동일하게 attempt를 증가시키면
      // 실제 POST 시도가 0회인 채로 3회 상한(REGISTER_RETRY_BACKOFF_MS.length)을 태워버릴 수
      // 있다. 이 테스트는 heal-busy 재예약 2회를 거친 뒤에도 정상 backoff 예산(15/30/60s)이
      // 그대로 남아 있는지 검증한다.
      //
      // "반대 방향" 테스트와 동일한 순서로 heal을 in-flight 상태로 만든다 — retry가 pending인
      // 동안에는 Tier 1이 스스로 발사하지 않으므로(#2167 P1 이전 가드), Tier 1이 먼저 정상
      // 발사(retry 없는 상태)된 뒤 별개 dep(subsurface) 변경으로 main effect가 재실행돼 실패해야
      // 그 세션에 재시도가 예약된다.
      mockRegister.mockResolvedValueOnce({ ok: true }); // cold-start 성공(currentStation=null → context 결손)

      let resolveHealRegister!: (value: { ok: boolean }) => void;
      const healDeferred = new Promise<{ ok: boolean }>((resolve) => {
        resolveHealRegister = resolve;
      });

      const { rerender } = renderHook(
        ({ cs, sub }: { cs: Station | null; sub: boolean }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
            subsurface: sub,
          }),
        { initialProps: { cs: null as Station | null, sub: false } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1); // cold-start 성공, context 결손 기록

      // Tier 1 heal 트리거 — 응답을 오래 기다리도록 pending 상태로 둔다(healInFlightSessionKeyRef 세팅).
      mockRegister.mockImplementationOnce(() => healDeferred);
      rerender({ cs: origin, sub: false });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));

      // 별개 dep(subsurface) 변경으로 main effect 재실행 — 이번엔 실패해 같은 세션에 재시도
      // 예약(15s, attempt=1).
      mockRegister.mockResolvedValueOnce({ ok: false, status: 500 });
      rerender({ cs: origin, sub: true });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(3);

      // 15s 경과 — retry 타이머 발화하지만 heal이 여전히 in-flight라 heal-busy 재예약(recheck,
      // attempt 미소모) 1회차.
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[0]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(3); // 실제 POST 없음 — recheck만 예약됨

      // recheck 간격만큼 경과 — heal이 아직도 in-flight라 heal-busy 재예약 2회차.
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_HEAL_BUSY_RECHECK_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(3); // 여전히 실제 POST 없음

      // heal이 이제 완료(성공) — in-flight 해제.
      resolveHealRegister({ ok: true });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // recheck 간격 경과 — 이번엔 heal이 끝났으므로 retry가 실제로 발화한다. 실패시켜 다음
      // backoff가 REGISTER_RETRY_BACKOFF_MS[1](30s)인지 확인 — attempt가 이미 소모돼 있었다면
      // (P2-1 버그) 상한을 넘어 이 발화 자체가 없거나 다음 backoff가 훨씬 짧아진다.
      mockRegister.mockResolvedValueOnce({ ok: false, status: 500 });
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_HEAL_BUSY_RECHECK_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(4); // heal 종료 후 실제 재시도 발화(attempt=1 그대로 소모)

      // attempt가 heal-busy 재예약으로 소모되지 않았다면, 다음 backoff는 REGISTER_RETRY_BACKOFF_MS[1]
      // (30s) — 그 이전엔 발화하지 않고, 그 시점엔 발화해야 한다.
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[1] - 100);
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(4);

      mockRegister.mockResolvedValueOnce({ ok: true });
      await act(async () => {
        jest.advanceTimersByTime(200);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(5); // 정상적으로 backoff[1] 시점에 재시도 발화
    });

    it(`P2-1 (PR #2169 리뷰) — heal-busy 재예약 상한(${REGISTER_RETRY_HEAL_BUSY_MAX_RESCHEDULES}회) 도달 시 일반 backoff로 전환한다`, async () => {
      // 회귀 방지: heal이 비정상적으로 오래(recheck 상한을 넘길 만큼) in-flight 상태에 머물면
      // recheck 루프가 무한히 반복될 수 있다 — 상한 도달 시 attempt 예산을 소모하는 일반
      // backoff로 전환해 무한 대기를 막아야 한다.
      mockRegister.mockResolvedValueOnce({ ok: true }); // cold-start 성공(context 결손)

      // 이 heal은 상한 도달 전까지는 resolve하지 않는다(heal이 "비정상적으로 오래" 걸리는
      // 상황 재현) — 상한 전환이 실제로 적용됐는지 검증하기 위해 나중에 명시적으로 resolve한다.
      let resolveHealForever!: (value: { ok: boolean }) => void;
      const healForeverPending = new Promise<{ ok: boolean }>((resolve) => {
        resolveHealForever = resolve;
      });

      const { rerender } = renderHook(
        ({ cs, sub }: { cs: Station | null; sub: boolean }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
            subsurface: sub,
          }),
        { initialProps: { cs: null as Station | null, sub: false } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // Tier 1 heal 트리거 — 영영 응답하지 않는 상태로 in-flight 유지.
      mockRegister.mockImplementationOnce(() => healForeverPending);
      rerender({ cs: origin, sub: false });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));

      // 별개 dep(subsurface) 변경으로 main effect 재실행 — 실패해 재시도 예약(15s, attempt=1).
      mockRegister.mockResolvedValueOnce({ ok: false, status: 500 });
      rerender({ cs: origin, sub: true });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(3);

      // 15s 경과 — 1번째 heal-busy 재예약(recheck).
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[0]);
        await Promise.resolve();
        await Promise.resolve();
      });

      // heal이 계속 in-flight인 채로 recheck 간격만큼씩 진행 — 상한(MAX_RESCHEDULES)에 도달할
      // 때까지 반복(이미 1회 소모했으므로 나머지 상한만큼 더 진행).
      for (let i = 1; i < REGISTER_RETRY_HEAL_BUSY_MAX_RESCHEDULES; i++) {
        // eslint-disable-next-line no-loop-func -- REGISTER_RETRY_HEAL_BUSY_RECHECK_MS는 상수, closure 문제 없음.
        await act(async () => {
          jest.advanceTimersByTime(REGISTER_RETRY_HEAL_BUSY_RECHECK_MS);
          await Promise.resolve();
          await Promise.resolve();
        });
      }
      expect(mockRegister).toHaveBeenCalledTimes(3); // 여전히 실제 POST 없음(모두 recheck로 skip)

      // 상한 도달 트리거 — 이번엔 일반 backoff(REGISTER_RETRY_BACKOFF_MS[1]=30s)로 전환된다.
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_HEAL_BUSY_RECHECK_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(3);

      // heal을 여기서 성공시켜 in-flight를 해제 — 이제 다음 실제 시도는 recheck(2s)가 아니라
      // 일반 backoff(30s) 시점에만 발화해야 한다(상한 전환이 실제로 적용됐는지 검증).
      mockRegister.mockResolvedValueOnce({ ok: true });
      resolveHealForever({ ok: true });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_HEAL_BUSY_RECHECK_MS);
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(3); // recheck 간격만으로는 아직 발화 안 함(일반 backoff 대기 중)

      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[1]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(4); // 일반 backoff(30s) 시점에 실제 재시도 발화
    });

    it('P2-2 (PR #2169 리뷰) — trip 종료 시 register-retry의 in-flight 추적이 초기화돼 동일 세션의 새 trip을 막지 않는다', async () => {
      // 회귀 배경: 이전 trip의 retry가 in-flight인 채로 trip이 종료돼도
      // registerRetryInFlightSessionKeyRef가 reset되지 않으면, 곧바로 같은 sessionKey(같은
      // route+destination)로 시작된 새 trip의 context-heal(Tier 1)이 stale in-flight 플래그
      // 때문에 영구히 차단된다.
      // 이 deferred는 trip B의 heal이 성공할 때까지 resolve하지 않는다 — 만약 trip 종료 직후
      // 바로 resolve하면 attemptRegisterRetry의 finally 블록이 sessionKey 일치를 보고
      // registerRetryInFlightSessionKeyRef를 우연히 지워버려, "trip 종료 후에도 in-flight
      // 플래그가 stale로 남는" 회귀 시나리오 자체가 재현되지 않는다(테스트가 우연히 통과하는
      // false-negative). 응답이 늦게 도착하는 네트워크 상황을 시뮬레이션해 trip-end 시점의
      // 명시적 reset(P2-2)만이 유일한 해제 경로가 되도록 한 뒤, 마지막에 resolve해 그 뒤늦은
      // 응답이 trip B의 상태를 오염시키지 않는지(mismatch 가드)도 함께 검증한다.
      let resolveTripARetry!: (value: { ok: boolean }) => void;
      const retryDeferred = new Promise<{ ok: boolean }>((resolve) => {
        resolveTripARetry = resolve;
      });
      mockRegister.mockResolvedValueOnce({ ok: false, status: 500 }); // trip A cold-start 실패

      const { rerender } = renderHook(
        ({ route, destination, cs }: { route: Route; destination: Station | null; cs: Station | null }) =>
          useApnsTripRegistration({
            route,
            destination,
            nextStationEtaSeconds: 120,
            currentStation: cs,
          }),
        { initialProps: { route: route3 as Route, destination: dest as Station | null, cs: null as Station | null } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1); // trip A: cold-start 실패 — 15s 재시도 예약

      // 15s 경과 — trip A의 retry가 발화해 in-flight 상태로 pending.
      mockRegister.mockImplementationOnce(() => retryDeferred);
      await act(async () => {
        jest.advanceTimersByTime(REGISTER_RETRY_BACKOFF_MS[0]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(2); // trip A retry in-flight(pending, 응답 대기)

      // retry가 응답을 받기 전에 trip A 종료(route/destination → null) — retryDeferred는 아직
      // resolve되지 않는다(위 주석, 마지막에 resolve).
      rerender({ route: null, destination: null, cs: null });
      await act(async () => {
        await Promise.resolve();
      });

      // 동일 route+destination(같은 sessionKey)으로 새 trip B 시작 — currentStation=null로
      // cold-start.
      mockRegister.mockResolvedValueOnce({ ok: true }); // trip B cold-start 성공(context 결손)
      rerender({ route: route3, destination: dest, cs: null });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(3));
      expect(mockRegister.mock.calls[2][0].promptGeoContext).toBeUndefined();

      // GPS 해소 — currentStation null→non-null 전환. trip A의 stale in-flight 플래그가 남아
      // 있었다면(P2-2 버그) isRegisterRetryBusy가 true로 평가돼 이 heal이 영구히 skip된다.
      rerender({ route: route3, destination: dest, cs: origin });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(4));
      const healed = mockRegister.mock.calls[3][0] as {
        promptGeoContext?: { origin: { lat: number; lng: number } };
      };
      expect(healed.promptGeoContext?.origin).toEqual({ lat: origin.lat, lng: origin.lng });

      // trip A의 뒤늦은 retry 응답이 지금 도착해도(trip B가 이미 진행 중) 별다른 부작용 없이
      // 조용히 무시돼야 한다(finally의 mismatch 가드 — trip B 시작 이후 이 ref는 이미 trip A의
      // sessionKey와 무관한 상태다).
      resolveTripARetry({ ok: true });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(4); // 추가 register 없음 — 뒤늦은 응답은 무해
    });
  });

  // #903 (Seam G) — 기압계 subsurface 전달
  describe('subsurface (#903)', () => {
    const baseInputs = (subsurface?: boolean) => ({
      route: directRoute,
      destination: station,
      nextStationEtaSeconds: 120,
      ...(subsurface === undefined ? {} : { subsurface }),
    });
    const renderSub = (sub?: boolean) =>
      renderHook(({ s }: { s?: boolean }) => useApnsTripRegistration(baseInputs(s)), {
        initialProps: { s: sub },
      });

    it.each([
      { label: 'subsurface=true → payload에 포함', sub: true, expected: true },
      { label: 'subsurface 미지정 → payload에 미포함 (graceful)', sub: undefined, expected: undefined },
    ])('$label', async ({ sub, expected }) => {
      renderSub(sub);
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockRegister.mock.calls[0][0].subsurface).toBe(expected);
    });

    it('OFF→ON 전환 시 즉시 재등록 (deps 반영 — backend threshold 빠른 갱신)', async () => {
      const { rerender } = renderSub(false);
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockRegister.mock.calls[0][0].subsurface).toBeUndefined();
      rerender({ s: true });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      expect(mockRegister.mock.calls[1][0].subsurface).toBe(true);
    });

    it('token refresh 경로도 최신 subsurface 값을 송신', async () => {
      const { rerender } = renderSub(false);
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      rerender({ s: true });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      const listener = mockAddPushTokenListener.mock.calls[0][0];
      await act(async () => {
        listener({ data: 'token-NEW2' });
        await Promise.resolve();
        await Promise.resolve();
      });
      const refreshed = mockRegister.mock.calls.find(
        (c) => (c[0] as { token: string }).token === 'token-NEW2',
      );
      expect(refreshed?.[0].subsurface).toBe(true);
    });
  });

  // #1923 — 사용자 명시 의향 토글 (infoModeEnabled) backend forward 검증.
  describe('infoModeEnabled (#1923)', () => {
    const baseInputs = (infoModeEnabled?: boolean) => ({
      route: directRoute,
      destination: station,
      nextStationEtaSeconds: 120,
      ...(infoModeEnabled === undefined ? {} : { infoModeEnabled }),
    });
    const renderInfo = (initial?: boolean) =>
      renderHook(
        ({ ime }: { ime?: boolean }) => useApnsTripRegistration(baseInputs(ime)),
        { initialProps: { ime: initial } },
      );

    it.each([
      { label: 'infoModeEnabled=true → payload에 포함', ime: true, expected: true },
      { label: 'infoModeEnabled 미지정 → payload에 미포함 (graceful)', ime: undefined, expected: undefined },
      { label: 'infoModeEnabled=false → payload에 미포함 (graceful)', ime: false, expected: undefined },
    ])('$label', async ({ ime, expected }) => {
      renderInfo(ime);
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockRegister.mock.calls[0][0].infoModeEnabled).toBe(expected);
    });

    it('OFF→ON 전환 시 즉시 재등록 (deps 반영 — backend lockless intermediate gate 즉시 활성화)', async () => {
      const { rerender } = renderInfo(false);
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockRegister.mock.calls[0][0].infoModeEnabled).toBeUndefined();
      rerender({ ime: true });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      expect(mockRegister.mock.calls[1][0].infoModeEnabled).toBe(true);
    });

    it('token refresh 경로도 최신 infoModeEnabled 값을 송신', async () => {
      const { rerender } = renderInfo(false);
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      rerender({ ime: true });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      const listener = mockAddPushTokenListener.mock.calls[0][0];
      await act(async () => {
        listener({ data: 'token-INFO-NEW' });
        await Promise.resolve();
        await Promise.resolve();
      });
      const refreshed = mockRegister.mock.calls.find(
        (c) => (c[0] as { token: string }).token === 'token-INFO-NEW',
      );
      expect(refreshed?.[0].infoModeEnabled).toBe(true);
    });
  });

  // #2032 (Issue D) — device 취침모드 상태 backend forward (monitoring 전용, ADR-023 결정 gate 미사용).
  describe('sleepMode (#2032)', () => {
    const baseInputs = (sleepMode?: boolean) => ({
      route: directRoute,
      destination: station,
      nextStationEtaSeconds: 120,
      ...(sleepMode === undefined ? {} : { sleepMode }),
    });
    const renderSleep = (initial?: boolean) =>
      renderHook(
        ({ sm }: { sm?: boolean }) => useApnsTripRegistration(baseInputs(sm)),
        { initialProps: { sm: initial } },
      );

    it.each([
      { label: 'sleepMode=true → payload sleepModeEnabled=true 포함', sm: true, expected: true },
      { label: 'sleepMode 미지정 → payload 미포함 (graceful)', sm: undefined, expected: undefined },
      { label: 'sleepMode=false → payload 미포함 (graceful, backend legacy graceful 처리)', sm: false, expected: undefined },
    ])('$label', async ({ sm, expected }) => {
      renderSleep(sm);
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockRegister.mock.calls[0][0].sleepModeEnabled).toBe(expected);
    });

    it('OFF→ON 전환 시 즉시 재등록 (deps 반영 — backend monitoring 값 즉시 동기화)', async () => {
      const { rerender } = renderSleep(false);
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockRegister.mock.calls[0][0].sleepModeEnabled).toBeUndefined();
      rerender({ sm: true });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      expect(mockRegister.mock.calls[1][0].sleepModeEnabled).toBe(true);
    });

    it('token refresh 경로도 최신 sleepMode 값을 송신', async () => {
      const { rerender } = renderSleep(false);
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      rerender({ sm: true });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      const listener = mockAddPushTokenListener.mock.calls[0][0];
      await act(async () => {
        listener({ data: 'token-SLEEP-NEW' });
        await Promise.resolve();
        await Promise.resolve();
      });
      const refreshed = mockRegister.mock.calls.find(
        (c) => (c[0] as { token: string }).token === 'token-SLEEP-NEW',
      );
      expect(refreshed?.[0].sleepModeEnabled).toBe(true);
    });
  });

  describe('#1895 i18n locale 송신 (4언어 boarding-prompt)', () => {
    const baseInputs = {
      route: directRoute,
      destination: station,
      nextStationEtaSeconds: 120,
    };

    afterEach(async () => {
      // i18next 전역 상태 복원 — 다른 describe 블록과 격리.
      await i18next.changeLanguage('ko');
    });

    it.each(['ko', 'en', 'ja', 'zh'] as const)(
      'i18next.language=%s → registerActiveTrip payload.locale에 동일 값 송신',
      async (lang) => {
        await i18next.changeLanguage(lang);
        renderHook(() => useApnsTripRegistration(baseInputs));
        await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
        expect(mockRegister.mock.calls[0][0].locale).toBe(lang);
      },
    );

    it('i18next.language=비지원 string (fallbackLng 미작동 강제) → payload.locale 미포함', async () => {
      // 실제 production에서 i18next는 fallbackLng='en'으로 비지원 locale을 'en'으로 떨어뜨린다.
      // 본 테스트는 resolveLocaleForBackend()의 strict guard만 검증 — i18next 내부 fallback 동작과
      // 무관하게 비지원 코드 그 자체가 들어왔을 때 undefined 반환하는지 본다. 직접 language 필드를
      // override해 i18next의 fallback 동작을 우회한다.
      const original = i18next.language;
      Object.defineProperty(i18next, 'language', {
        value: 'fr',
        writable: true,
        configurable: true,
      });
      try {
        renderHook(() => useApnsTripRegistration(baseInputs));
        await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
        expect(mockRegister.mock.calls[0][0].locale).toBeUndefined();
      } finally {
        Object.defineProperty(i18next, 'language', {
          value: original,
          writable: true,
          configurable: true,
        });
      }
    });
  });

  describe('boarding-prompt 컨텍스트 (#1028)', () => {
    it('currentStation이 destination과 다르면 promptGeoContext/promptDisplay 송신', async () => {
      // 단조 line(3호선) 대화(3-001) → 정발산(3-003) — buildBoardingPromptContext가 non-null 반환.
      const origin: Station = {
        id: '3-001',
        name: '대화',
        line: '3',
        lat: 37.676087,
        lng: 126.747569,
        lineColor: '#EF7C1C',
      };
      const dest: Station = {
        id: '3-003',
        name: '정발산',
        line: '3',
        lat: 37.659477,
        lng: 126.773359,
        lineColor: '#EF7C1C',
      };
      renderHook(() =>
        useApnsTripRegistration({
          route: makeDirectRoute(2, '3'),
          destination: dest,
          nextStationEtaSeconds: 120,
          currentStation: origin,
        }),
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalled());
      const args = mockRegister.mock.calls[0][0] as {
        promptGeoContext?: { origin: { lat: number; lng: number }; direction: string | null };
        promptDisplay?: { originStation: string; line: string };
      };
      expect(args.promptGeoContext?.origin).toEqual({ lat: origin.lat, lng: origin.lng });
      expect(args.promptGeoContext?.direction).toBe('down');
      expect(args.promptDisplay).toEqual({ originStation: '대화', line: '3' });
    });

    it('currentStation === destination이면 컨텍스트 누락 (backend 자동 skip)', async () => {
      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          currentStation: station,
        }),
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalled());
      const args = mockRegister.mock.calls[0][0] as {
        promptGeoContext?: unknown;
        promptDisplay?: unknown;
      };
      expect(args.promptGeoContext).toBeUndefined();
      expect(args.promptDisplay).toBeUndefined();
    });

    // #1284 — boarding-prompt 컨텍스트 캐싱 (currentStation 일시 null 회귀 방지)
    describe('#1284 — prompt context 캐싱', () => {
      // 단조 3호선 대화(3-001) → 정발산(3-003): buildBoardingPromptContext non-null 반환 보장.
      const origin: Station = {
        id: '3-001',
        name: '대화',
        line: '3',
        lat: 37.676087,
        lng: 126.747569,
        lineColor: '#EF7C1C',
      };
      const dest: Station = {
        id: '3-003',
        name: '정발산',
        line: '3',
        lat: 37.659477,
        lng: 126.773359,
        lineColor: '#EF7C1C',
      };
      const route3 = makeDirectRoute(2, '3');

      it('currentStation이 일시 null → 직전 캐시된 컨텍스트를 payload에 포함', async () => {
        // 1st render: currentStation=origin → 컨텍스트 빌드 + 캐시
        const { rerender } = renderHook(
          ({ cs }: { cs: Station | null }) =>
            useApnsTripRegistration({
              route: route3,
              destination: dest,
              nextStationEtaSeconds: 120,
              currentStation: cs,
            }),
          { initialProps: { cs: origin as Station | null } },
        );
        await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
        // 첫 register: 컨텍스트 있음
        expect(mockRegister.mock.calls[0][0].promptGeoContext).toBeDefined();
        expect(mockRegister.mock.calls[0][0].promptDisplay).toBeDefined();

        // currentStation → null (BG GPS 누락 시뮬레이션). deps에 포함 안 됐으므로
        // register 재호출 안 됨 (#703). token-refresh나 다음 subsurface 변경 등으로
        // re-register 시 캐시 활용 여부를 아래 token-refresh 경로로 검증.
        rerender({ cs: null });
        // 재등록 미발생 (currentStation은 deps 아님) — 캐시 검증은 token-refresh로 진행
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(1);

        // token-refresh 경로: currentStation=null 상태에서도 캐시된 컨텍스트를 사용해야 함
        const listener = mockAddPushTokenListener.mock.calls[0][0];
        await act(async () => {
          listener({ data: 'token-REFRESH' });
          await Promise.resolve();
          await Promise.resolve();
        });
        await waitFor(() =>
          expect(mockRegister).toHaveBeenCalledWith(
            expect.objectContaining({ token: 'token-REFRESH' }),
          ),
        );
        const refreshed = mockRegister.mock.calls.find(
          (c) => (c[0] as { token: string }).token === 'token-REFRESH',
        );
        // 캐시에서 복원된 컨텍스트가 payload에 포함되어야 한다.
        expect(refreshed?.[0].promptGeoContext).toBeDefined();
        expect(refreshed?.[0].promptDisplay).toEqual({ originStation: '대화', line: '3' });
      });

      it('route + destination 모두 없는 경우(trip 없음) → null 반환 (false stamp 없음)', async () => {
        renderHook(() =>
          useApnsTripRegistration({
            route: null,
            destination: null,
            nextStationEtaSeconds: null,
          }),
        );
        await act(async () => {
          await Promise.resolve();
        });
        // register 호출 없음 — false stamp 없음
        expect(mockRegister).not.toHaveBeenCalled();
      });

      it('trip 종료 후 새 trip 시작 시 캐시 reset — 이전 origin이 새 trip에 누출 안 됨', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === APNS_TOKEN_KEY) return 'token-abc';
          if (key === ACTIVE_TRIP_KEY) return 'token-abc';
          return null;
        });

        // 1st trip: 대화→정발산, origin 컨텍스트 캐시
        const { rerender } = renderHook(
          ({ r, d, cs }: { r: Route | null; d: Station | null; cs: Station | null }) =>
            useApnsTripRegistration({
              route: r,
              destination: d,
              nextStationEtaSeconds: 120,
              currentStation: cs,
            }),
          { initialProps: { r: route3 as Route | null, d: dest as Station | null, cs: origin as Station | null } },
        );
        await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
        expect(mockRegister.mock.calls[0][0].promptDisplay).toEqual({ originStation: '대화', line: '3' });

        // trip 종료: 캐시 reset 트리거
        rerender({ r: null, d: null, cs: null });
        await waitFor(() => expect(mockClear).toHaveBeenCalled());

        // 2nd trip: 새 노선 + currentStation=null (GPS 아직 없음)
        rerender({ r: directRoute as Route | null, d: station as Station | null, cs: null });
        await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
        const secondArgs = mockRegister.mock.calls[1][0] as {
          promptGeoContext?: unknown;
          promptDisplay?: unknown;
        };
        // 캐시가 reset됐으므로 이전 origin 컨텍스트가 누출 안 됨
        expect(secondArgs.promptGeoContext).toBeUndefined();
        expect(secondArgs.promptDisplay).toBeUndefined();
      });
    });
  });

  // #2130 — context-heal (B-1 Tier 1/2) + GPS 근접 스탬프 (B-2)
  describe('#2130 — context-heal 조건부 재등록 + GPS 근접 스탬프', () => {
    // 단조 3호선 대화(3-001) → 정발산(3-003): buildBoardingPromptContext non-null 반환 보장.
    const origin: Station = {
      id: '3-001',
      name: '대화',
      line: '3',
      lat: 37.676087,
      lng: 126.747569,
      lineColor: '#EF7C1C',
    };
    const dest: Station = {
      id: '3-003',
      name: '정발산',
      line: '3',
      lat: 37.659477,
      lng: 126.773359,
      lineColor: '#EF7C1C',
    };
    const route3 = makeDirectRoute(2, '3');

    it('Tier 1 — cold-start(캐시 empty + currentStation=null)로 등록 후 station 해소 시 context를 포함해 재등록', async () => {
      const { rerender } = renderHook(
        ({ cs }: { cs: Station | null }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
          }),
        { initialProps: { cs: null as Station | null } },
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      // cold-start 첫 register: 캐시도 없고 currentStation도 null → context 결손
      expect(mockRegister.mock.calls[0][0].promptGeoContext).toBeUndefined();
      expect(mockRegister.mock.calls[0][0].promptDisplay).toBeUndefined();

      // GPS/fusion이 station을 해소 — null → non-null 전환
      rerender({ cs: origin });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      const healed = mockRegister.mock.calls[1][0] as {
        promptGeoContext?: { origin: { lat: number; lng: number } };
        promptDisplay?: { originStation: string; line: string };
      };
      expect(healed.promptGeoContext?.origin).toEqual({ lat: origin.lat, lng: origin.lng });
      expect(healed.promptDisplay).toEqual({ originStation: '대화', line: '3' });
    });

    it('Tier 1 (#2164) — register 발사는 context build 성공 시에만: build 실패(off-route) 전환은 POST 없이 skip, 세션도 잠기지 않는다', async () => {
      // currentStation === destination이면 buildBoardingPromptContext가 null 반환(기존 동작) —
      // "off-route" 전환의 fixture로 재사용.
      const { rerender } = renderHook(
        ({ cs }: { cs: Station | null }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
          }),
        { initialProps: { cs: null as Station | null } },
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));

      // null → dest(=destination, context 빌드 실패) 전환 — build 실패로 POST 자체가 나가지
      // 않아야 한다(#2164 이전에는 build 실패에도 무조건 register를 쐈다).
      rerender({ cs: dest });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // dest → 강남(2호선, route 밖 — build 실패) 전환도 마찬가지로 POST 없이 skip.
      rerender({ cs: station });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1);
    });

    it('Tier 1 (#2164) — off-route→off-route→on-route 전환에도 heal이 발동한다 (실패 시 세션 미잠금, 회귀 재현)', async () => {
      // #2164 배경 재현: cold-start 이후 첫 실질 전환이 다시 off-route 역이면(GPS 흔들림 등)
      // 구 코드는 그 1회 실패 "시도"만으로 세션을 영구 잠가, 이후 진짜 탑승역(on-route) 전환에
      // heal이 재발동하지 않았다. 새 코드는 실패 시 세션을 잠그지 않아 이후 on-route 전환에서
      // 정상적으로 heal이 성공해야 한다.
      const { rerender } = renderHook(
        ({ cs }: { cs: Station | null }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
          }),
        { initialProps: { cs: null as Station | null } },
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockRegister.mock.calls[0][0].promptGeoContext).toBeUndefined();

      // off-route 전환 1: null → dest(=destination, build 실패) — POST 없이 skip.
      rerender({ cs: dest });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // off-route 전환 2: dest → 강남(2호선, route 밖, build 실패) — 여전히 POST 없이 skip.
      rerender({ cs: station });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // on-route 전환: 강남 → origin(route 위, build 성공) — heal이 정상 발동해 context를 포함한
      // register가 발사돼야 한다. #2164 이전에는 위 두 실패 시도 중 첫 번째에서 이미 세션이
      // 영구 잠겨 이 register가 발생하지 않았다.
      rerender({ cs: origin });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      const healed = mockRegister.mock.calls[1][0] as {
        promptGeoContext?: { origin: { lat: number; lng: number } };
        promptDisplay?: { originStation: string; line: string };
      };
      expect(healed.promptGeoContext?.origin).toEqual({ lat: origin.lat, lng: origin.lng });
      expect(healed.promptDisplay).toEqual({ originStation: '대화', line: '3' });

      // 성공 후 세션이 잠겨 추가 전환에도 재heal 없음(기존 보장 보존).
      rerender({ cs: dest });
      await act(async () => {
        await Promise.resolve();
      });
      rerender({ cs: origin });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(2);
    });

    it(`Tier 1 (#2164) — 세션당 POST 상한(${CONTEXT_HEAL_MAX_ATTEMPTS_PER_SESSION}회) 도달 시 추가 heal 중단 (POST 네트워크 실패 반복)`, async () => {
      // build는 매번 성공하지만 backend POST가 계속 실패({ok:false})하는 상황 — 폭주 방지
      // 백스톱(CONTEXT_HEAL_MAX_ATTEMPTS_PER_SESSION)이 station 전환이 반복돼도 세션당
      // heal POST 횟수를 제한해야 한다.
      // #2167 — cold-start의 main effect register 자체는 성공(ok:true)시켜 register-retry(#1960)가
      // 예약되지 않게 한다. retry가 pending 상태면 Tier 1 heal이 그쪽에 위임하며 skip하므로
      // (본 이슈의 상호 조율 가드), 이 테스트가 검증하려는 "heal 자체의 세션당 POST 상한"과는
      // 별개 관심사 — 순수하게 heal POST만 반복 실패하는 상황으로 격리한다.
      mockRegister.mockResolvedValueOnce({ ok: true });
      mockRegister.mockResolvedValue({ ok: false, status: 500 });
      const mid = st('3-002'); // 주엽 — origin/dest 사이 실제 3호선 역, build 항상 성공.
      const alternating = [origin, mid];

      const { rerender } = renderHook(
        ({ cs }: { cs: Station | null }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
          }),
        { initialProps: { cs: null as Station | null } },
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1)); // cold-start, context 결손

      // 상한만큼 heal POST 시도 — build는 매번 성공하지만 POST 네트워크는 계속 실패.
      for (let i = 0; i < CONTEXT_HEAL_MAX_ATTEMPTS_PER_SESSION; i++) {
        const nextCallCount = i + 2; // cold-start(1) + 이번까지의 heal 시도 수
        rerender({ cs: alternating[i % alternating.length] });
        // eslint-disable-next-line no-loop-func -- nextCallCount는 매 반복 고정값 캡처, closure 문제 없음.
        await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(nextCallCount));
      }
      const cappedCallCount = CONTEXT_HEAL_MAX_ATTEMPTS_PER_SESSION + 1;

      // 상한 도달 — 이후 전환은 build가 성공해도 추가 POST 없음.
      rerender({ cs: alternating[CONTEXT_HEAL_MAX_ATTEMPTS_PER_SESSION % alternating.length] });
      await act(async () => {
        await Promise.resolve();
      });
      rerender({ cs: alternating[(CONTEXT_HEAL_MAX_ATTEMPTS_PER_SESSION + 1) % alternating.length] });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(cappedCallCount);
    });

    it('Tier 1 — heal 성공 후 station이 다시 흔들려도(null→non-null 재전환) 추가 heal 없음 (context 이미 보유)', async () => {
      const { rerender } = renderHook(
        ({ cs }: { cs: Station | null }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
          }),
        { initialProps: { cs: null as Station | null } },
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockRegister.mock.calls[0][0].promptGeoContext).toBeUndefined();

      // 첫 heal 성공 — context 확보.
      rerender({ cs: origin });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      expect(mockRegister.mock.calls[1][0].promptGeoContext).toBeDefined();

      // GPS가 다시 흔들려 null이 됐다가 다른 유효 station으로 재전환돼도, 직전 register가
      // 이미 context를 포함했으므로(lastRegisterMissingContextRef=false) heal을 재시도하지 않는다.
      rerender({ cs: null });
      await act(async () => {
        await Promise.resolve();
      });
      rerender({ cs: dest });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(2);
    });

    it('Tier 1 — #2150 off-route(non-null, context 결손) → on-route(non-null) 전환에도 heal 발동', async () => {
      // 최초 등록 시 currentStation이 route 밖(=destination과 동일, getNextStationName이 null을
      // 반환하는 기존 fixture 패턴 재사용)이라 context 결손 → 이후 실제 탑승역(origin, route 위)으로
      // non-null→non-null 전환. #2150 이전에는 prevWasNull 게이트가 이 전환을 무시해 heal이
      // 영구히 발동하지 않았다(promptContext 결손 영속).
      const { rerender } = renderHook(
        ({ cs }: { cs: Station | null }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
          }),
        { initialProps: { cs: dest as Station | null } },
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      // cold-start 첫 register: currentStation === destination → context 결손(기존 동작)
      expect(mockRegister.mock.calls[0][0].promptGeoContext).toBeUndefined();

      // 실제 탑승역(route 위 유효 station)으로 non-null → non-null 전환
      rerender({ cs: origin });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      const healed = mockRegister.mock.calls[1][0] as {
        promptGeoContext?: { origin: { lat: number; lng: number } };
        promptDisplay?: { originStation: string; line: string };
      };
      expect(healed.promptGeoContext?.origin).toEqual({ lat: origin.lat, lng: origin.lng });
      expect(healed.promptDisplay).toEqual({ originStation: '대화', line: '3' });
    });

    it('Tier 1 — currentStation이 이미 non-null로 시작한 trip은 heal 대상 아님(정상 등록 경로)', async () => {
      renderHook(() =>
        useApnsTripRegistration({
          route: route3,
          destination: dest,
          nextStationEtaSeconds: 120,
          currentStation: origin,
        }),
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockRegister.mock.calls[0][0].promptGeoContext).toBeDefined();
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1);
    });

    it('Tier 1 — heal in-flight 중 unmount되면 후속 register 미발사 (cancelled 가드)', async () => {
      const { rerender, unmount } = renderHook(
        ({ cs }: { cs: Station | null }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
          }),
        { initialProps: { cs: null as Station | null } },
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));

      // 첫 register(cold-start) 이후부터 APNS_TOKEN_KEY 조회를 의도적으로 지연시켜, heal의
      // async IIFE가 `await AsyncStorage.getItem` 시점에 멈춰 있는 동안 unmount(cleanup)가
      // 먼저 발생하도록 만든다.
      let resolveToken!: (value: string) => void;
      const deferredToken = new Promise<string>((resolve) => {
        resolveToken = resolve;
      });
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === APNS_TOKEN_KEY) return deferredToken;
        return null;
      });

      // null → origin(context 빌드 가능) 전환 — heal의 async IIFE가 시작돼 token 조회 시점에서
      // 대기(deferredToken 미resolve)한다.
      rerender({ cs: origin });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1); // 아직 heal register는 발사 안 됨(token 대기 중)

      // heal의 token 조회가 완료되기 전에 unmount — effect cleanup이 cancelled=true를 세팅.
      unmount();
      resolveToken('token-abc');
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // cancelled 가드로 unmount 후 register가 추가로 발사되지 않는다.
      expect(mockRegister).toHaveBeenCalledTimes(1);
    });

    it('Tier 1 (#2164) — heal 시도 시 APNs token 미가용이면 in-flight만 해제하고 조용히 skip', async () => {
      let tokenAvailable = true;
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === APNS_TOKEN_KEY) return tokenAvailable ? 'token-abc' : null;
        return null;
      });

      const { rerender } = renderHook(
        ({ cs }: { cs: Station | null }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
          }),
        { initialProps: { cs: null as Station | null } },
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1)); // cold-start, context 결손

      // heal 시도 시점에 token이 미가용해지면(예: 토큰 만료/재발급 지연) build는 성공해도
      // register 자체가 나가지 않고 in-flight 표시만 해제돼야 한다(세션 미잠금 유지).
      tokenAvailable = false;
      rerender({ cs: origin });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1); // token 없음 — heal register 미발사

      // token이 다시 가용해지고 새 전환이 오면 heal이 정상 재시도된다(세션이 잠기지 않았으므로).
      tokenAvailable = true;
      rerender({ cs: dest });
      await act(async () => {
        await Promise.resolve();
      });
      rerender({ cs: origin });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      expect(mockRegister.mock.calls[1][0].promptGeoContext).toBeDefined();
    });

    it('Tier 1 (#2164) — heal register 완료 직전 unmount되면 세션 잠금 등 부작용 없이 조용히 종료 (cancelled 가드)', async () => {
      let resolveRegister!: (value: { ok: boolean }) => void;
      const deferred = new Promise<{ ok: boolean }>((resolve) => {
        resolveRegister = resolve;
      });
      mockRegister.mockResolvedValueOnce({ ok: true }); // cold-start
      mockRegister.mockImplementationOnce(() => deferred); // heal 시도 — pending 상태로 멈춤.

      const { rerender, unmount } = renderHook(
        ({ cs }: { cs: Station | null }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
          }),
        { initialProps: { cs: null as Station | null } },
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));

      rerender({ cs: origin }); // heal 시도 시작 — registerActiveTrip이 deferred라 결과 대기.
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));

      // register 완료(resolve) 이전에 unmount — effect cleanup이 cancelled=true를 세팅.
      unmount();
      resolveRegister({ ok: true });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // cancelled 가드로 unmount 이후 추가 register/크래시 없이 조용히 종료.
      expect(mockRegister).toHaveBeenCalledTimes(2);
    });

    it('Tier 1 (#2164) — 이미 heal 성공한 세션은 이후 register가 다시 실패해도 재heal하지 않는다 (성공 잠금 영속)', async () => {
      const { rerender } = renderHook(
        ({ cs }: { cs: Station | null }) =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: cs,
          }),
        { initialProps: { cs: null as Station | null } },
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1)); // cold-start, context 결손

      // heal 성공 — 세션 잠금.
      rerender({ cs: origin });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      expect(mockRegister.mock.calls[1][0].promptGeoContext).toBeDefined();

      // 이후 push token 갱신 경로(#2129)로 같은 입력이 재register되는데, 이번엔 backend가
      // 일시 실패({ok:false})한다 — lastRegisterMissingContextRef가 다시 "결손"으로 flip된다.
      mockRegister.mockResolvedValueOnce({ ok: false, status: 500 });
      const pushTokenHandler = mockAddPushTokenListener.mock.calls[0][0] as (event: {
        data: string;
      }) => void;
      await act(async () => {
        pushTokenHandler({ data: 'token-refreshed' });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(3);

      // 다른 station으로 전환해도 이미 이 세션은 heal에 성공한 적이 있으므로(healedSessionKeyRef
      // 잠금 영속) 추가 heal register가 발사되지 않는다.
      rerender({ cs: dest });
      await act(async () => {
        await Promise.resolve();
      });
      rerender({ cs: origin });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(3);
    });

    describe('Tier 2 — 지하 fallback (route 출발역, 스탬프 없이)', () => {
      beforeEach(() => {
        jest.useFakeTimers();
      });
      afterEach(() => {
        jest.useRealTimers();
      });

      it('60초 내 currentStation 미해소 + subsurface=true → route 출발역 기준 heal', async () => {
        renderHook(() =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: null,
            subsurface: true,
            routeOriginStation: origin,
          }),
        );
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(1);
        expect(mockRegister.mock.calls[0][0].promptGeoContext).toBeUndefined();

        await act(async () => {
          jest.advanceTimersByTime(CONTEXT_HEAL_TIER2_DELAY_MS);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(2);
        const healed = mockRegister.mock.calls[1][0] as {
          promptGeoContext?: { origin: { lat: number; lng: number }; originDistanceM?: number };
          promptDisplay?: { originStation: string; line: string };
        };
        expect(healed.promptGeoContext?.origin).toEqual({ lat: origin.lat, lng: origin.lng });
        // Tier 2는 스탬프 없이 송신 — GPS fix 여부와 무관하게 항상 생략.
        expect(healed.promptGeoContext?.originDistanceM).toBeUndefined();
        expect(healed.promptDisplay).toEqual({ originStation: '대화', line: '3' });
      });

      it('60초 후 currentStation이 이미 해소돼 있으면 Tier 2 heal 미발동', async () => {
        const { rerender } = renderHook(
          ({ cs }: { cs: Station | null }) =>
            useApnsTripRegistration({
              route: route3,
              destination: dest,
              nextStationEtaSeconds: 120,
              currentStation: cs,
              subsurface: true,
              routeOriginStation: origin,
            }),
          { initialProps: { cs: null as Station | null } },
        );
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(1);

        // Tier 1이 먼저 정상 해소 (currentStation resolve) — Tier 2는 그 뒤로 발동할 필요 없음.
        rerender({ cs: origin });
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(2);

        await act(async () => {
          jest.advanceTimersByTime(CONTEXT_HEAL_TIER2_DELAY_MS);
          await Promise.resolve();
          await Promise.resolve();
        });
        // currentStation이 non-null이므로 Tier 2 조건(cs 미해소) 불충족 — 추가 register 없음.
        expect(mockRegister).toHaveBeenCalledTimes(2);
      });

      it('subsurface=false면 60초가 지나도 Tier 2 heal 미발동', async () => {
        renderHook(() =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: null,
            subsurface: false,
            routeOriginStation: origin,
          }),
        );
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(1);

        await act(async () => {
          jest.advanceTimersByTime(CONTEXT_HEAL_TIER2_DELAY_MS);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(1);
      });

      it('트립 종료가 60초 전에 일어나면 대기 중인 Tier 2 타이머를 cancel', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === APNS_TOKEN_KEY) return 'token-abc';
          if (key === ACTIVE_TRIP_KEY) return 'token-abc';
          return null;
        });
        const { rerender } = renderHook(
          ({ r, d }: { r: Route | null; d: Station | null }) =>
            useApnsTripRegistration({
              route: r,
              destination: d,
              nextStationEtaSeconds: 120,
              currentStation: null,
              subsurface: true,
              routeOriginStation: origin,
            }),
          { initialProps: { r: route3 as Route | null, d: dest as Station | null } },
        );
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(1);

        // 타이머가 발화하기 전에 trip 종료
        rerender({ r: null, d: null });
        await waitFor(() => expect(mockClear).toHaveBeenCalled());

        await act(async () => {
          jest.advanceTimersByTime(CONTEXT_HEAL_TIER2_DELAY_MS);
          await Promise.resolve();
          await Promise.resolve();
        });
        // trip이 이미 종료돼 register가 추가로 호출되지 않는다 (타이머 cancel 확인).
        expect(mockRegister).toHaveBeenCalledTimes(1);
      });

      it('60초 전에 같은 trip이 재등록되면 직전 Tier 2 타이머를 clear하고 재arm', async () => {
        const { rerender } = renderHook(
          ({ sub }: { sub: boolean }) =>
            useApnsTripRegistration({
              route: route3,
              destination: dest,
              nextStationEtaSeconds: 120,
              currentStation: null,
              subsurface: sub,
              routeOriginStation: origin,
            }),
          { initialProps: { sub: true } },
        );
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(1);

        // subsurface deps 변경 → run() 재실행 → 이미 armed된 타이머를 clear 후 재arm.
        act(() => {
          jest.advanceTimersByTime(1000);
        });
        rerender({ sub: false });
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(2);

        // 재arm된 타이머 기준으로 CONTEXT_HEAL_TIER2_DELAY_MS 경과해야 발동 — subsurface가
        // 이제 false이므로 Tier 2 조건 자체는 불충족(추가 register 없음)이지만, 옛 타이머가
        // clear됐다면 이 시점(원래 예정보다 1000ms 늦게 도착)에 register가 정확히 몇 번인지로
        // "clear+재arm"이 실제로 일어났음을 간접 확인한다.
        await act(async () => {
          jest.advanceTimersByTime(CONTEXT_HEAL_TIER2_DELAY_MS);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(2);
      });

      it('이미 heal된 세션에서 타이머가 다시 도착해도 재heal하지 않는다 (세션 공유 가드)', async () => {
        const { rerender } = renderHook(
          ({ ime }: { ime: boolean }) =>
            useApnsTripRegistration({
              route: route3,
              destination: dest,
              nextStationEtaSeconds: 120,
              currentStation: null,
              subsurface: true,
              infoModeEnabled: ime,
              routeOriginStation: origin,
            }),
          { initialProps: { ime: false } },
        );
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(1);

        // 첫 Tier 2 heal 발동
        await act(async () => {
          jest.advanceTimersByTime(CONTEXT_HEAL_TIER2_DELAY_MS);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(2);

        // infoModeEnabled 토글로 register가 다시 발생(deps 변경) — currentStation은 여전히
        // null, subsurface도 여전히 true이므로 새 Tier 2 타이머가 재arm된다.
        rerender({ ime: true });
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(3);

        // 재arm된 타이머가 도착해도 이미 healedSessionKeyRef가 이 세션으로 세팅돼 있어 skip.
        await act(async () => {
          jest.advanceTimersByTime(CONTEXT_HEAL_TIER2_DELAY_MS);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(3);
      });

      it('route 출발역 기준 context 빌드가 실패하면(예: origin===destination) heal을 조용히 skip', async () => {
        renderHook(() =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: null,
            subsurface: true,
            // buildBoardingPromptContext는 currentStation===destination이면 null을 반환한다
            // (기존 동작) — Tier 2가 이 케이스를 override context 빌드 실패로 만나는 fixture.
            routeOriginStation: dest,
          }),
        );
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(1);

        await act(async () => {
          jest.advanceTimersByTime(CONTEXT_HEAL_TIER2_DELAY_MS);
          await Promise.resolve();
          await Promise.resolve();
        });
        // context 빌드 실패 — heal POST 없이 조용히 skip.
        expect(mockRegister).toHaveBeenCalledTimes(1);
      });

      it('routeOriginStation이 없으면 60초가 지나도 Tier 2 heal 미발동 (fallback 대상 없음)', async () => {
        renderHook(() =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: null,
            subsurface: true,
            routeOriginStation: null,
          }),
        );
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(1);

        await act(async () => {
          jest.advanceTimersByTime(CONTEXT_HEAL_TIER2_DELAY_MS);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(1);
      });

      it('(#2167 재적용, 원래 c18bbac6/#2164 리뷰 P1) Tier 2 register 실패({ok:false}) 시 세션을 잠그지 않아 이후 Tier 1 heal이 재발동할 수 있다', async () => {
        // 회귀 배경: c18bbac6(#2164 리뷰 P1)가 이 증상을 이미 고쳤으나, #2166 머지(21:48Z) 이후
        // push돼 dev에 유실됐다 — #2167 작업 중 runTier2Heal을 재구성하며 "await 이전 무조건
        // 잠금"으로 되돌아갔다. Tier 2 POST가 네트워크 레벨에서 실패하면(build/override context는
        // 성공했지만 backend 전달에 실패) 세션이 잠기면 안 된다 — 잠기면 이후 Tier 1이 진짜
        // currentStation을 해소해도 다시 시도할 수 없어 영구 결손으로 고착된다.
        const { rerender } = renderHook(
          ({ cs }: { cs: Station | null }) =>
            useApnsTripRegistration({
              route: route3,
              destination: dest,
              nextStationEtaSeconds: 120,
              currentStation: cs,
              subsurface: true,
              routeOriginStation: origin,
            }),
          { initialProps: { cs: null as Station | null } },
        );
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(1); // cold-start 성공, context 결손

        // Tier 2 POST가 네트워크 레벨에서 실패.
        mockRegister.mockResolvedValueOnce({ ok: false, status: 500 });
        await act(async () => {
          jest.advanceTimersByTime(CONTEXT_HEAL_TIER2_DELAY_MS);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(mockRegister).toHaveBeenCalledTimes(2); // Tier 2 시도했지만 실패

        // 세션이 잠기지 않았어야 하므로, currentStation이 실제로 해소되면(Tier 1) heal이
        // 재시도돼 정상적으로 성공해야 한다. 버그(await 이전 무조건 잠금)가 있으면 이 register가
        // 발사되지 않아 call count가 2에서 멈춘다.
        mockRegister.mockResolvedValue({ ok: true });
        rerender({ cs: origin });
        await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(3));
        const healed = mockRegister.mock.calls[2][0] as {
          promptGeoContext?: { origin: { lat: number; lng: number } };
          promptDisplay?: { originStation: string; line: string };
        };
        expect(healed.promptGeoContext?.origin).toEqual({ lat: origin.lat, lng: origin.lng });
        expect(healed.promptDisplay).toEqual({ originStation: '대화', line: '3' });
      });
    });

    describe('B-2 — GPS 근접 스탬프 (originDistanceM / originAccuracyM)', () => {
      it('gpsFix 제공 시 promptGeoContext에 originDistanceM/originAccuracyM 동봉', async () => {
        renderHook(() =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: origin,
            gpsFix: { lat: origin.lat, lng: origin.lng, accuracyM: 12 },
          }),
        );
        await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
        const args = mockRegister.mock.calls[0][0] as {
          promptGeoContext?: { originDistanceM?: number; originAccuracyM?: number };
        };
        // gpsFix가 origin과 동일 좌표이므로 거리는 0에 수렴.
        expect(args.promptGeoContext?.originDistanceM).toBe(0);
        expect(args.promptGeoContext?.originAccuracyM).toBe(12);
      });

      it('gpsFix가 아예 없으면(null) originDistanceM/originAccuracyM 필드 자체를 생략', async () => {
        renderHook(() =>
          useApnsTripRegistration({
            route: route3,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: origin,
            gpsFix: null,
          }),
        );
        await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
        const args = mockRegister.mock.calls[0][0] as {
          promptGeoContext?: { originDistanceM?: number; originAccuracyM?: number };
        };
        expect(args.promptGeoContext).toBeDefined();
        expect(args.promptGeoContext?.originDistanceM).toBeUndefined();
        expect(args.promptGeoContext?.originAccuracyM).toBeUndefined();
      });
    });
  });

  // #1264 (N3) — routeSig 전환 시 사전 예약된 tba: 알람 cancel.
  // 2026-06-12 user trip의 50분 영구 `revalidate-route-sig-mismatch` 회귀 차단.
  describe('#1264 (N3) routeSig 전환 시 cancelTripBoundAlarms', () => {
    type TripProps = { route: Route | null; destination: Station | null };
    const renderTrip = (initialProps: TripProps) =>
      renderHook(
        ({ route, destination }: TripProps) =>
          useApnsTripRegistration({ route, destination, nextStationEtaSeconds: 120 }),
        { initialProps },
      );

    it('첫 register(이전 sig 없음)에는 cancelTripBoundAlarms 호출 안 함', async () => {
      renderTrip({ route: directRoute, destination: station });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockCancelTripBoundAlarms).not.toHaveBeenCalled();
    });

    it('routeSig 전환 시 register 전에 cancelTripBoundAlarms 호출', async () => {
      // #2089 — cancelAllSafetyNetAlarms(tripToken)은 ACTIVE_TRIP_KEY가 있어야 실제로 호출된다.
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === APNS_TOKEN_KEY) return 'token-abc';
        if (key === ACTIVE_TRIP_KEY) return 'token-abc';
        return null;
      });
      const { rerender } = renderTrip({ route: makeDirectRoute(5, '2'), destination: station });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockCancelTripBoundAlarms).not.toHaveBeenCalled();

      // route 내용 변경 — routeSig 전환
      rerender({ route: makeDirectRoute(6, '2'), destination: station });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      expect(mockCancelTripBoundAlarms).toHaveBeenCalledTimes(1);
    });

    it('동일 routeSig 재진입(reference만 변경)에는 cancelTripBoundAlarms 호출 안 함', async () => {
      const { rerender } = renderTrip({ route: makeDirectRoute(5, '2'), destination: station });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));

      // 같은 내용 new reference — routeSig 동일
      rerender({ route: makeDirectRoute(5, '2'), destination: station });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockCancelTripBoundAlarms).not.toHaveBeenCalled();
    });

    it('cancelTripBoundAlarms 실패해도 register는 graceful 진행', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === APNS_TOKEN_KEY) return 'token-abc';
        if (key === ACTIVE_TRIP_KEY) return 'token-abc';
        return null;
      });
      mockCancelTripBoundAlarms.mockRejectedValueOnce(new Error('cancel failed'));
      const { rerender } = renderTrip({ route: makeDirectRoute(5, '2'), destination: station });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));

      rerender({ route: makeDirectRoute(6, '2'), destination: station });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      expect(mockCancelTripBoundAlarms).toHaveBeenCalledTimes(1);
      // register는 그대로 발사됨
      expect(mockRegister.mock.calls[1][0]).toMatchObject({ destination: station.id });
    });

    it('trip 종료(route/destination → null) 후 새 trip 시작 시 첫 register는 cancel 호출 안 함', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === APNS_TOKEN_KEY) return 'token-abc';
        if (key === ACTIVE_TRIP_KEY) return 'token-abc';
        return null;
      });
      const { rerender } = renderTrip({ route: directRoute, destination: station });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));

      // trip 종료
      rerender({ route: null, destination: null });
      await waitFor(() => expect(mockClear).toHaveBeenCalled());
      expect(mockCancelTripBoundAlarms).not.toHaveBeenCalled();

      // 새 trip 시작 (다른 route) — lastRouteSigRef가 reset되었으므로 cancel 호출 안 함
      rerender({ route: makeDirectRoute(7, '2'), destination: station });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      expect(mockCancelTripBoundAlarms).not.toHaveBeenCalled();
    });

    it('destination 변경 시(routeSig 동일 가정 X — 다른 route 보낼 때) cancel 호출', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === APNS_TOKEN_KEY) return 'token-abc';
        if (key === ACTIVE_TRIP_KEY) return 'token-abc';
        return null;
      });
      const altStation: Station = { ...station, id: '2-023', name: '역삼' };
      const { rerender } = renderTrip({ route: makeDirectRoute(5, '2'), destination: station });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));

      rerender({ route: makeDirectRoute(6, '2'), destination: altStation });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      expect(mockCancelTripBoundAlarms).toHaveBeenCalledTimes(1);
    });

    it('cancelTripBoundAlarms in-flight 중 unmount되면 후속 register 미발사 (cancelled 가드)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === APNS_TOKEN_KEY) return 'token-abc';
        if (key === ACTIVE_TRIP_KEY) return 'token-abc';
        return null;
      });
      let resolveCancel!: () => void;
      mockCancelTripBoundAlarms.mockImplementation(
        () => new Promise<void>((res) => { resolveCancel = res; }),
      );
      const { rerender, unmount } = renderTrip({
        route: makeDirectRoute(5, '2'),
        destination: station,
      });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));

      rerender({ route: makeDirectRoute(6, '2'), destination: station });
      await waitFor(() => expect(mockCancelTripBoundAlarms).toHaveBeenCalledTimes(1));
      // unmount 직후 cancel resolve — cancelled 가드로 후속 register 진행 안 함
      unmount();
      mockRegister.mockClear();
      await act(async () => {
        resolveCancel();
        await Promise.resolve();
      });
      expect(mockRegister).not.toHaveBeenCalled();
    });
  });

  // #1704 (d) — destination.id / boardingLockSig 전환 시 cross-trip cleanup 강화.
  // 2026-06-23 사용자 trip evidence: 14:18 2차 trip 등록 직후 1차 trip의 공덕/군자 stale fire.
  // routeSig는 같지만(예: 같은 line · 같은 hop 수의 다른 destination) destination/lock 변경만으로도 cancel 트리거.
  describe('#1704 (d) destination.id / boardingLockSig 전환 시 cross-trip cancel', () => {
    type TripProps = {
      route: Route | null;
      destination: Station | null;
      boardingLock?: {
        destinationId: string;
        trainCode: string;
        boardingStationId: string;
        boardingLine: '2';
        boardedAt: number;
        expectedDurationMs: number;
      } | null;
    };
    const renderTrip = (initialProps: TripProps) =>
      renderHook(
        ({ route, destination, boardingLock }: TripProps) =>
          useApnsTripRegistration({
            route,
            destination,
            nextStationEtaSeconds: 120,
            boardingLock: boardingLock ?? null,
          }),
        { initialProps },
      );

    // it.each + factory로 trip-switch trigger 3종(route/destination/lock) 케이스 공통 패턴 dedup.
    // 같은 patterns(첫 register → trigger change → cancel + 재register 검증).
    const lockA = {
      destinationId: station.id,
      trainCode: '7246',
      boardingStationId: station.id,
      boardingLine: '2' as const,
      boardedAt: 1_700_000_000_000,
      expectedDurationMs: 600_000,
    };
    const lockB = { ...lockA, trainCode: '7415', boardedAt: 1_700_000_500_000 };
    const altStation: Station = { ...station, id: '2-023', name: '역삼' };

    it('routeSig 동일 + destination.id 변경 시 cancelTripBoundAlarms 호출', async () => {
      // #2089 — cancelAllSafetyNetAlarms(tripToken)은 ACTIVE_TRIP_KEY가 있어야 실제로 호출된다.
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === APNS_TOKEN_KEY) return 'token-abc';
        if (key === ACTIVE_TRIP_KEY) return 'token-abc';
        return null;
      });
      const { rerender } = renderTrip({
        route: makeDirectRoute(5, '2'),
        destination: station,
      });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockCancelTripBoundAlarms).not.toHaveBeenCalled();

      // routeSig 동일 (같은 line·stops) + destination만 다른 역으로 변경.
      // 기존 #1264 게이트는 routeSig만 검사라 trigger 안 됐지만 #1704 (d)는 destination 변경도 잡는다.
      rerender({ route: makeDirectRoute(5, '2'), destination: altStation });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      expect(mockCancelTripBoundAlarms).toHaveBeenCalledTimes(1);
    });

    it('routeSig 동일 + boardingLockSig 변경 시 cancelTripBoundAlarms 호출', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === APNS_TOKEN_KEY) return 'token-abc';
        if (key === ACTIVE_TRIP_KEY) return 'token-abc';
        return null;
      });
      const { rerender } = renderTrip({
        route: makeDirectRoute(5, '2'),
        destination: station,
        boardingLock: lockA,
      });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockCancelTripBoundAlarms).not.toHaveBeenCalled();

      // routeSig 동일 + destination 동일 + lock만 다른 trainCode로 변경.
      rerender({ route: makeDirectRoute(5, '2'), destination: station, boardingLock: lockB });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      expect(mockCancelTripBoundAlarms).toHaveBeenCalledTimes(1);
    });

    it('routeSig + destination + lock 모두 동일하면 cancel 호출 안 함 (false positive 차단)', async () => {
      const { rerender } = renderTrip({
        route: makeDirectRoute(5, '2'),
        destination: station,
        boardingLock: lockA,
      });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));

      // 모든 trigger 동일 — reference만 신규.
      rerender({
        route: makeDirectRoute(5, '2'),
        destination: { ...station },
        boardingLock: { ...lockA },
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockCancelTripBoundAlarms).not.toHaveBeenCalled();
    });

    it('trip 종료(route/destination → null) 후 새 trip 시작 시 첫 register는 cancel 호출 안 함 (모든 ref reset)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === APNS_TOKEN_KEY) return 'token-abc';
        if (key === ACTIVE_TRIP_KEY) return 'token-abc';
        return null;
      });
      const { rerender } = renderTrip({
        route: makeDirectRoute(5, '2'),
        destination: station,
        boardingLock: lockA,
      });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));

      // trip 종료 — 모든 ref(routeSig/destinationId/lockSig) reset.
      rerender({ route: null, destination: null, boardingLock: null });
      await waitFor(() => expect(mockClear).toHaveBeenCalled());

      // 새 trip 시작 — 모든 ref가 null로 reset되었으므로 cancel skip.
      rerender({
        route: makeDirectRoute(7, '2'),
        destination: altStation,
        boardingLock: lockB,
      });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      expect(mockCancelTripBoundAlarms).not.toHaveBeenCalled();
    });

    it('routeSig + destination + lock이 모두 동시에 바뀌어도 cancel 1회만 호출', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === APNS_TOKEN_KEY) return 'token-abc';
        if (key === ACTIVE_TRIP_KEY) return 'token-abc';
        return null;
      });
      const { rerender } = renderTrip({
        route: makeDirectRoute(5, '2'),
        destination: station,
        boardingLock: lockA,
      });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));

      // 모든 trigger 동시 변경 (실제 trip switch 패턴).
      rerender({
        route: makeDirectRoute(7, '2'),
        destination: altStation,
        boardingLock: lockB,
      });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      // cancel은 한 effect cycle 안에 1회만.
      expect(mockCancelTripBoundAlarms).toHaveBeenCalledTimes(1);
    });
  });

  describe('#1960 Acceptance 4 — token refresh 경로도 lock 갱신 직후 cross-trip stamp 반영', () => {
    // boardingPromptContext.test.ts #1921 cross-trip 시나리오와 동일 fixture: route 원본
    // line=3 multi-transfer(3호선 → 2호선), lock.boardingLine=2로 갱신되면 promptDisplay가
    // route 원본(line=3)이 아닌 lock line(2)을 stamp해야 한다(#1921 회귀 차단).
    // 본 테스트는 그 갱신이 main effect뿐 아니라 token-refresh listener 경로에도 동일하게
    // 반영되는지 검증 — #2129 payload 단일화(registerFromLatestInputs)로 두 경로가 같은
    // buildBoardingPromptContext 재빌드를 타므로, token rotation이 lock 갱신 직후 발생해도
    // stale route-line(3) stamp가 새지 않는다(#1960 원 스펙 Acceptance 1~2).
    it('lock 갱신 직후 token refresh가 발생해도 lock line 기준 fresh context를 재빌드해 송신', async () => {
      const current = st('2-024'); // 서초 (line 2)
      const dest = st('2-022'); // 강남 (line 2)
      const crossTripRoute = makeMultiTransferRoute({
        transfers: [
          { transferName: canonicalStationName('교대', '3'), fromLine: '3', toLine: '2', stopsToTransfer: 31 },
          { transferName: '강남', fromLine: '2', toLine: 'sinbundang', stopsToTransfer: 1 },
        ],
        stopsAfterLastTransfer: 0,
      });
      const lockLine2 = {
        destinationId: dest.id,
        trainCode: '7246',
        boardingStationId: current.id,
        boardingLine: '2' as const,
        boardedAt: 1_700_000_000_000,
        expectedDurationMs: 600_000,
      };

      const { rerender } = renderHook(
        ({ lock }: { lock: typeof lockLine2 | null }) =>
          useApnsTripRegistration({
            route: crossTripRoute,
            destination: dest,
            nextStationEtaSeconds: 120,
            currentStation: current,
            boardingLock: lock,
          }),
        { initialProps: { lock: null as typeof lockLine2 | null } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(1);

      // cross-trip 자동 전환 — lock=line2 부여. main effect가 lock line 기준으로 재stamp.
      rerender({ lock: lockLine2 });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockRegister).toHaveBeenCalledTimes(2);
      const mainEffectArgs = mockRegister.mock.calls[1][0] as {
        promptDisplay?: { originStation: string; line: string };
      };
      expect(mainEffectArgs.promptDisplay).toEqual({ originStation: '서초', line: '2' });

      // lock 갱신 직후 token rotation 발생 — token-refresh listener가 stale(route 원본 line=3)
      // context를 forward하지 않고, 동일한 lock-aware fresh context를 재빌드해야 한다.
      const listener = mockAddPushTokenListener.mock.calls[0][0];
      await act(async () => {
        listener({ data: 'token-ROTATED' });
        await Promise.resolve();
        await Promise.resolve();
      });
      const refreshed = mockRegister.mock.calls.find(
        (c) => (c[0] as { token: string }).token === 'token-ROTATED',
      );
      expect(refreshed).toBeDefined();
      const refreshedArgs = refreshed?.[0] as {
        promptDisplay?: { originStation: string; line: string };
      };
      expect(refreshedArgs.promptDisplay).toEqual({ originStation: '서초', line: '2' });
    });
  });
});

// #1366 Layer 2 — route ↔ lock line 일치 검증 헬퍼.
describe('isLockConsistentWithRoute (#1366 Layer 2)', () => {
  const { isLockConsistentWithRoute } = jest.requireActual<{
    isLockConsistentWithRoute: (lock: unknown, route: unknown) => boolean;
  }>('../useApnsTripRegistration');

  function makeLock(boardingLine: string): unknown {
    return {
      trainCode: 'TC',
      boardingLine,
      boardingStationId: 'S1',
      boardedAt: 0,
    };
  }

  it('lock null이면 항상 통과', () => {
    expect(isLockConsistentWithRoute(null, { type: 'direct', line: '2', stops: 3, travelSeconds: 0 })).toBe(true);
  });

  it('route null이면 항상 통과', () => {
    expect(isLockConsistentWithRoute(makeLock('2'), null)).toBe(true);
  });

  it('direct route line == lock.boardingLine → 통과', () => {
    expect(
      isLockConsistentWithRoute(makeLock('2'), { type: 'direct', line: '2', stops: 3, travelSeconds: 0 }),
    ).toBe(true);
  });

  it('direct route line != lock.boardingLine → 불일치 (stale state)', () => {
    expect(
      isLockConsistentWithRoute(makeLock('2'), { type: 'direct', line: '7', stops: 3, travelSeconds: 0 }),
    ).toBe(false);
  });

  it('transfer route fromLine == lock.boardingLine → 통과', () => {
    expect(
      isLockConsistentWithRoute(makeLock('7'), {
        type: 'transfer',
        transferName: '건대입구',
        fromLine: '7',
        toLine: '2',
        stopsToTransfer: 2,
        stopsFromTransfer: 1,
        secondsToTransfer: 0,
        secondsFromTransfer: 0,
      }),
    ).toBe(true);
  });

  it('transfer route fromLine != lock.boardingLine → 불일치 (환승 후 stale)', () => {
    expect(
      isLockConsistentWithRoute(makeLock('2'), {
        type: 'transfer',
        transferName: '건대입구',
        fromLine: '7',
        toLine: '2',
        stopsToTransfer: 2,
        stopsFromTransfer: 1,
        secondsToTransfer: 0,
        secondsFromTransfer: 0,
      }),
    ).toBe(false);
  });

  it('multi-transfer route — transfers[0].fromLine == lock.boardingLine → 통과', () => {
    expect(
      isLockConsistentWithRoute(makeLock('7'), {
        type: 'multi-transfer',
        transfers: [
          {
            transferName: '건대입구',
            fromLine: '7',
            toLine: '2',
            stopsToTransfer: 2,
            secondsToTransfer: 0,
          },
          {
            transferName: '왕십리',
            fromLine: '2',
            toLine: '5',
            stopsToTransfer: 3,
            secondsToTransfer: 0,
          },
        ],
        stopsAfterLastTransfer: 1,
        secondsAfterLastTransfer: 0,
      }),
    ).toBe(true);
  });

  it('multi-transfer route — transfers[0].fromLine != lock.boardingLine → 불일치', () => {
    expect(
      isLockConsistentWithRoute(makeLock('2'), {
        type: 'multi-transfer',
        transfers: [
          {
            transferName: '건대입구',
            fromLine: '7',
            toLine: '2',
            stopsToTransfer: 2,
            secondsToTransfer: 0,
          },
        ],
        stopsAfterLastTransfer: 1,
        secondsAfterLastTransfer: 0,
      }),
    ).toBe(false);
  });

  it('multi-transfer route — transfers 배열이 비어 있으면 검증 대상 없음 → 통과', () => {
    expect(
      isLockConsistentWithRoute(makeLock('7'), {
        type: 'multi-transfer',
        transfers: [],
        stopsAfterLastTransfer: 1,
        secondsAfterLastTransfer: 0,
      }),
    ).toBe(true);
  });
});
