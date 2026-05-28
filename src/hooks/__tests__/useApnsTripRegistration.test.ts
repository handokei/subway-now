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

jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useApnsTripRegistration } from '../useApnsTripRegistration';
import type { Station } from '../../types/station';
import type { Route } from '../../utils/stationRoute';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../../constants/storageKeys';

const station: Station = {
  id: '0228',
  name: '강남',
  line: '2',
  lat: 37.5,
  lng: 127.0,
  lineColor: '#00A84D',
};

const directRoute: Route = { type: 'direct', stops: 5, line: '2' };

describe('useApnsTripRegistration', () => {
  let listenerRemove: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    listenerRemove = jest.fn();
    mockAddPushTokenListener.mockReturnValue({ remove: listenerRemove });
    mockGetDevicePushTokenAsync.mockResolvedValue({ data: 'token-abc' });
    mockRegister.mockResolvedValue({ ok: true });
    mockClear.mockResolvedValue({ ok: true });
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
        destination: '0228',
        waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
        apnsEnv: expect.stringMatching(/^(sandbox|production)$/) as unknown as 'sandbox' | 'production',
      }),
    );
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(ACTIVE_TRIP_KEY, 'token-abc'),
    );
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

  it('unmount 직후 register resolve해도 ACTIVE_TRIP_KEY 저장 안 함', async () => {
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
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(ACTIVE_TRIP_KEY, 'token-abc');
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
      { initialProps: { route: { type: 'direct', stops: 5, line: '2' } as Route } },
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    // 내용 동일, reference만 신규
    rerender({ route: { type: 'direct', stops: 5, line: '2' } as Route });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('#589 — 같은 (token, route, destination)으로 재호출 시 동일 createdAt 전달', async () => {
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
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
    const firstCreatedAt = mockRegister.mock.calls[0][0].createdAt as number;
    expect(firstCreatedAt).toBe(1_700_000_000_000);

    // eta만 바뀌어 register effect 재실행 (같은 세션)
    now = 1_700_000_999_999;
    rerender({ eta: 60 });
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
    expect(mockRegister.mock.calls[1][0].createdAt).toBe(firstCreatedAt);
    (Date.now as jest.Mock).mockRestore();
  });

  it('#589 — route 내용 변경 시 새 createdAt 발급', async () => {
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const { rerender } = renderHook(
      ({ route }: { route: Route }) =>
        useApnsTripRegistration({ route, destination: station, nextStationEtaSeconds: 120 }),
      { initialProps: { route: { type: 'direct', stops: 5, line: '2' } as Route } },
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    const first = mockRegister.mock.calls[0][0].createdAt as number;

    now = 1_700_000_500_000;
    rerender({ route: { type: 'direct', stops: 6, line: '2' } as Route });
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
      { initialProps: { route: { type: 'direct', stops: 5, line: '2' } as Route } },
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    rerender({ route: { type: 'direct', stops: 6, line: '2' } as Route });
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
  });
});
