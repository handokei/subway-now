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

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useApnsTripRegistration } from '../useApnsTripRegistration';
import type { Station } from '../../../../shared/types/station';
import type { Route } from '../../../../shared/utils/stationRoute';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';
import { BOARDING_LOCK_RELEASE_DEBOUNCE_MS } from '../../../../shared/constants/boardingLock';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';

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
        destination: '2-022',
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
    const altStation: Station = { ...station, id: '2-023', name: '역삼' };
    const { rerender } = renderHook(
      ({ cs }: { cs: Station | null }) =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          currentStation: cs,
        }),
      { initialProps: { cs: null as Station | null } },
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
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

  // #816 C — lockless station-passed opt-in
  describe('lockless station-passed (#816)', () => {
    it('locklessStationPassed=true 입력 시 register payload에 포함', async () => {
      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
          locklessStationPassed: true,
        }),
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockRegister.mock.calls[0][0].locklessStationPassed).toBe(true);
    });

    it('locklessStationPassed 미지정/false면 register payload에 미포함', async () => {
      renderHook(() =>
        useApnsTripRegistration({
          route: directRoute,
          destination: station,
          nextStationEtaSeconds: 120,
        }),
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockRegister.mock.calls[0][0].locklessStationPassed).toBeUndefined();
    });

    it('토글 OFF→ON 전환 시 즉시 재등록 (deps 반영)', async () => {
      const { rerender } = renderHook(
        ({ lsp }: { lsp: boolean }) =>
          useApnsTripRegistration({
            route: directRoute,
            destination: station,
            nextStationEtaSeconds: 120,
            locklessStationPassed: lsp,
          }),
        { initialProps: { lsp: false } },
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      expect(mockRegister.mock.calls[0][0].locklessStationPassed).toBeUndefined();

      rerender({ lsp: true });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));
      expect(mockRegister.mock.calls[1][0].locklessStationPassed).toBe(true);
    });

    it('token refresh 경로도 최신 토글값을 송신 (latestInputsRef)', async () => {
      const { rerender } = renderHook(
        ({ lsp }: { lsp: boolean }) =>
          useApnsTripRegistration({
            route: directRoute,
            destination: station,
            nextStationEtaSeconds: 120,
            locklessStationPassed: lsp,
          }),
        { initialProps: { lsp: false } },
      );
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
      // 토글 ON으로 변경
      rerender({ lsp: true });
      await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2));

      const listener = mockAddPushTokenListener.mock.calls[0][0];
      await act(async () => {
        listener({ data: 'token-NEW' });
        await Promise.resolve();
        await Promise.resolve();
      });

      const refreshed = mockRegister.mock.calls.find(
        (c) => (c[0] as { token: string }).token === 'token-NEW',
      );
      expect(refreshed?.[0].locklessStationPassed).toBe(true);
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
  });
});
