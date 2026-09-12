import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafetyNetScheduler } from '../useSafetyNetScheduler';
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
}));

const mockRegisterSafetyNetAlarms = jest.fn();
const mockCancelAllSafetyNetAlarms = jest.fn();
jest.mock('../../utils/safetyNetScheduler', () => ({
  registerSafetyNetAlarms: (...args: unknown[]) => mockRegisterSafetyNetAlarms(...args),
  cancelAllSafetyNetAlarms: (...args: unknown[]) => mockCancelAllSafetyNetAlarms(...args),
}));

const mockGetTripStartedAt = jest.fn();
jest.mock('../../utils/tripStartStorage', () => ({
  getTripStartedAt: (...args: unknown[]) => mockGetTripStartedAt(...args),
}));

const mockUseSilentPushHealthCheck = jest.fn();
jest.mock('../useSilentPushHealthCheck', () => ({
  useSilentPushHealthCheck: (...args: unknown[]) => mockUseSilentPushHealthCheck(...args),
}));

const mockErrorSpy = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => mockErrorSpy(...args),
  }),
}));

const mockAsyncGetItem = AsyncStorage.getItem as jest.Mock;
const GANGNAM = canonicalStationName('강남', '2');
const TRIP_TOKEN = 'TOKEN-A';
const ROUTE = makeDirectRoute(5, '2');

describe('useSafetyNetScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSettingsStore.setState({ sleepMode: false });
    mockAsyncGetItem.mockResolvedValue(TRIP_TOKEN);
    mockGetTripStartedAt.mockResolvedValue(1_000_000);
    mockRegisterSafetyNetAlarms.mockResolvedValue({ scheduled: 1 });
    mockCancelAllSafetyNetAlarms.mockResolvedValue(undefined);
    // #2203 — 기본값은 backend outage 확인(healthy=false)으로 둬서 기존 테스트들의
    // "등록된다" 기대를 그대로 보존. outage-only 게이트 자체 테스트는 healthy:true를 명시.
    mockUseSilentPushHealthCheck.mockReturnValue({ healthy: false, lastReceivedAt: null });
  });

  it('sleepMode=false면 등록하지 않는다', async () => {
    renderHook(() => useSafetyNetScheduler({ route: ROUTE, destinationName: GANGNAM }));
    await waitFor(() => {
      expect(mockRegisterSafetyNetAlarms).not.toHaveBeenCalled();
    });
    expect(mockCancelAllSafetyNetAlarms).not.toHaveBeenCalled();
  });

  it('sleepMode=false + 이전 등록 있으면 cancel-only 수행', async () => {
    useSettingsStore.setState({ sleepMode: true });
    const { rerender } = renderHook(
      ({ destinationName }: { destinationName: string | null }) =>
        useSafetyNetScheduler({ route: ROUTE, destinationName }),
      { initialProps: { destinationName: GANGNAM as string | null } },
    );
    await waitFor(() => expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(1));

    act(() => {
      useSettingsStore.setState({ sleepMode: false });
    });
    rerender({ destinationName: GANGNAM });

    await waitFor(() => expect(mockCancelAllSafetyNetAlarms).toHaveBeenCalledWith(TRIP_TOKEN));
  });

  it('route가 null이면 cancel-only(등록 없음)', async () => {
    useSettingsStore.setState({ sleepMode: true });
    renderHook(() => useSafetyNetScheduler({ route: null, destinationName: GANGNAM }));
    await waitFor(() => {
      expect(mockRegisterSafetyNetAlarms).not.toHaveBeenCalled();
    });
  });

  it('destinationName이 null이면 cancel-only(등록 없음)', async () => {
    useSettingsStore.setState({ sleepMode: true });
    renderHook(() => useSafetyNetScheduler({ route: ROUTE, destinationName: null }));
    await waitFor(() => {
      expect(mockRegisterSafetyNetAlarms).not.toHaveBeenCalled();
    });
  });

  it('sleepMode=true + route/destination 있으면 tripToken/tripStart 조회 후 등록', async () => {
    useSettingsStore.setState({ sleepMode: true });
    renderHook(() => useSafetyNetScheduler({ route: ROUTE, destinationName: GANGNAM }));

    await waitFor(() => {
      expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledWith({
        tripToken: TRIP_TOKEN,
        route: ROUTE,
        destinationName: GANGNAM,
        startTime: 1_000_000,
        outageConfirmed: true,
      });
    });
  });

  it('tripToken 없으면(ACTIVE_TRIP_KEY 미기록) 이번 cycle skip', async () => {
    mockAsyncGetItem.mockResolvedValueOnce(null);
    useSettingsStore.setState({ sleepMode: true });
    renderHook(() => useSafetyNetScheduler({ route: ROUTE, destinationName: GANGNAM }));

    await waitFor(() => expect(mockAsyncGetItem).toHaveBeenCalled());
    expect(mockRegisterSafetyNetAlarms).not.toHaveBeenCalled();
  });

  it('tripStart 없으면 이번 cycle skip', async () => {
    mockGetTripStartedAt.mockResolvedValueOnce(null);
    useSettingsStore.setState({ sleepMode: true });
    renderHook(() => useSafetyNetScheduler({ route: ROUTE, destinationName: GANGNAM }));

    await waitFor(() => expect(mockGetTripStartedAt).toHaveBeenCalled());
    expect(mockRegisterSafetyNetAlarms).not.toHaveBeenCalled();
  });

  it('동일 identity 재렌더는 no-op (register 1회만)', async () => {
    // route는 매 렌더 새 참조로 재계산되는 실제 caller(useFusedNearestStation 등)를 모사 —
    // routeSignature는 동일하므로 effect는 재실행되지만 internal identity dedup이 register를 막는다.
    useSettingsStore.setState({ sleepMode: true });
    const { rerender } = renderHook(
      ({ route, destinationName }: { route: typeof ROUTE; destinationName: string | null }) =>
        useSafetyNetScheduler({ route, destinationName }),
      { initialProps: { route: makeDirectRoute(5, '2'), destinationName: GANGNAM as string | null } },
    );
    await waitFor(() => expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(1));

    rerender({ route: makeDirectRoute(5, '2'), destinationName: GANGNAM });
    await waitFor(() => expect(mockAsyncGetItem).toHaveBeenCalledTimes(2));

    expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(1);
  });

  it('destination 변경 시 이전 등록 cancel 후 재등록', async () => {
    useSettingsStore.setState({ sleepMode: true });
    const OTHER = canonicalStationName('교대', '2');
    const { rerender } = renderHook(
      ({ destinationName }: { destinationName: string | null }) =>
        useSafetyNetScheduler({ route: ROUTE, destinationName }),
      { initialProps: { destinationName: GANGNAM as string | null } },
    );
    await waitFor(() => expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(1));

    rerender({ destinationName: OTHER });

    await waitFor(() => expect(mockCancelAllSafetyNetAlarms).toHaveBeenCalledWith(TRIP_TOKEN));
    await waitFor(() => expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(2));
  });

  it('언마운트 후 in-flight completion은 ref를 갱신하지 않는다(race guard)', async () => {
    let resolveRegister: (v: { scheduled: number }) => void;
    mockRegisterSafetyNetAlarms.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRegister = resolve;
      }),
    );
    useSettingsStore.setState({ sleepMode: true });
    const { unmount } = renderHook(() =>
      useSafetyNetScheduler({ route: ROUTE, destinationName: GANGNAM }),
    );
    await waitFor(() => expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(1));

    unmount();
    resolveRegister!({ scheduled: 1 });
    await Promise.resolve();
    await Promise.resolve();

    // 언마운트 후에도 예외 없이 완료 — race guard가 있어도 크래시하지 않음을 확인.
    expect(mockErrorSpy).not.toHaveBeenCalled();
  });

  it('registerSafetyNetAlarms 실패 시 에러 로그만 남기고 throw하지 않는다', async () => {
    mockRegisterSafetyNetAlarms.mockRejectedValueOnce(new Error('os fail'));
    useSettingsStore.setState({ sleepMode: true });
    renderHook(() => useSafetyNetScheduler({ route: ROUTE, destinationName: GANGNAM }));

    await waitFor(() => expect(mockErrorSpy).toHaveBeenCalled());
  });

  it('sleepMode 꺼짐 cancel-only 도중 새 effect가 시작되면 stale completion이 ref를 갱신하지 않는다(race guard)', async () => {
    useSettingsStore.setState({ sleepMode: true });
    renderHook(() => useSafetyNetScheduler({ route: ROUTE, destinationName: GANGNAM }));
    await waitFor(() => expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(1));

    let resolveCancel: () => void;
    mockCancelAllSafetyNetAlarms.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCancel = resolve;
      }),
    );

    act(() => {
      useSettingsStore.setState({ sleepMode: false });
    });
    await waitFor(() => expect(mockCancelAllSafetyNetAlarms).toHaveBeenCalledTimes(1));

    // 이전 cancel이 아직 pending인 동안 sleepMode를 다시 켜서 새 effect(신규 token)를 시작 —
    // registeredIdentityRef가 아직 남아있어(run2 미완료) 동일 identity로 판정, 재등록 없음.
    act(() => {
      useSettingsStore.setState({ sleepMode: true });
    });
    await Promise.resolve();

    resolveCancel!();
    await Promise.resolve();
    await Promise.resolve();

    // stale run(token=2)의 completion이 늦게 도착해도 race guard가 흡수 — 크래시/중복 등록 없음.
    expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(1);
    expect(mockErrorSpy).not.toHaveBeenCalled();
  });

  it('등록 대상 조회(AsyncStorage/tripStart) 도중 새 effect가 시작되면 stale completion은 등록하지 않는다(race guard)', async () => {
    useSettingsStore.setState({ sleepMode: true });
    let resolveGetItem: (v: string | null) => void;
    mockAsyncGetItem.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGetItem = resolve;
        }),
    );

    const OTHER = canonicalStationName('교대', '2');
    const { rerender } = renderHook(
      ({ destinationName }: { destinationName: string | null }) =>
        useSafetyNetScheduler({ route: ROUTE, destinationName }),
      { initialProps: { destinationName: GANGNAM as string | null } },
    );

    // 첫 effect가 AsyncStorage.getItem에서 pending인 동안 destination 변경으로 새 effect 시작.
    rerender({ destinationName: OTHER });
    await waitFor(() => expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(1));

    resolveGetItem!(TRIP_TOKEN);
    await Promise.resolve();
    await Promise.resolve();

    // 첫 effect(stale)가 이제 resolve돼도 등록이 중복되지 않는다 — race guard가 조기 반환.
    expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(1);
  });

  it('identity 변경 재등록의 cancel 도중 또 다른 identity 변경이 발생하면 stale completion은 재등록하지 않는다(race guard)', async () => {
    useSettingsStore.setState({ sleepMode: true });
    const OTHER1 = canonicalStationName('교대', '2');
    const OTHER2 = canonicalStationName('서초', '2');
    const { rerender } = renderHook(
      ({ destinationName }: { destinationName: string | null }) =>
        useSafetyNetScheduler({ route: ROUTE, destinationName }),
      { initialProps: { destinationName: GANGNAM as string | null } },
    );
    await waitFor(() => expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(1));

    let resolveFirstCancel: () => void;
    mockCancelAllSafetyNetAlarms.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveFirstCancel = resolve;
      }),
    );

    rerender({ destinationName: OTHER1 });
    await waitFor(() => expect(mockCancelAllSafetyNetAlarms).toHaveBeenCalledTimes(1));

    // OTHER1의 cancel이 아직 pending인 동안 다시 destination 변경 — 신규 token(run3)이
    // registeredIdentityRef가 여전히 GANGNAM 기준이라 cancel 후 정상 재등록까지 완료된다.
    rerender({ destinationName: OTHER2 });
    await waitFor(() => expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(2));

    resolveFirstCancel!();
    await Promise.resolve();
    await Promise.resolve();

    // stale run(OTHER1)의 cancel completion이 늦게 도착해도 재등록을 트리거하지 않는다.
    expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(2);
    expect(mockErrorSpy).not.toHaveBeenCalled();
  });

  it('register 완료 도중 또 다른 identity 변경이 발생하면 stale completion은 ref를 갱신하지 않는다(race guard)', async () => {
    useSettingsStore.setState({ sleepMode: true });
    const OTHER1 = canonicalStationName('교대', '2');
    const OTHER2 = canonicalStationName('서초', '2');
    const { rerender } = renderHook(
      ({ destinationName }: { destinationName: string | null }) =>
        useSafetyNetScheduler({ route: ROUTE, destinationName }),
      { initialProps: { destinationName: GANGNAM as string | null } },
    );
    await waitFor(() => expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(1));

    let resolveStaleRegister: (v: { scheduled: number }) => void;
    mockRegisterSafetyNetAlarms.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStaleRegister = resolve;
      }),
    );

    rerender({ destinationName: OTHER1 });
    await waitFor(() => expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(2));

    // OTHER1의 register가 아직 pending인 동안 다시 destination 변경 — 신규 token(run3)이
    // registeredIdentityRef가 여전히 GANGNAM 기준이라 cancel 후 정상 재등록까지 완료된다.
    rerender({ destinationName: OTHER2 });
    await waitFor(() => expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(3));

    resolveStaleRegister!({ scheduled: 1 });
    await Promise.resolve();
    await Promise.resolve();

    // stale run(OTHER1)의 register completion이 늦게 도착해도 register 호출 수는 늘지 않는다.
    expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(3);
    expect(mockErrorSpy).not.toHaveBeenCalled();
  });

  describe('#2203 — outage-only 무장 (ADR-026 Decision 3)', () => {
    it('backend 정상(healthy=true)이면 무장하지 않는다', async () => {
      mockUseSilentPushHealthCheck.mockReturnValue({ healthy: true, lastReceivedAt: Date.now() });
      useSettingsStore.setState({ sleepMode: true });
      renderHook(() => useSafetyNetScheduler({ route: ROUTE, destinationName: GANGNAM }));

      await waitFor(() => expect(mockGetTripStartedAt).toHaveBeenCalled());
      expect(mockRegisterSafetyNetAlarms).not.toHaveBeenCalled();
      expect(mockCancelAllSafetyNetAlarms).not.toHaveBeenCalled();
    });

    it('outage 확인(healthy=false)이면 무장한다', async () => {
      mockUseSilentPushHealthCheck.mockReturnValue({ healthy: false, lastReceivedAt: null });
      useSettingsStore.setState({ sleepMode: true });
      renderHook(() => useSafetyNetScheduler({ route: ROUTE, destinationName: GANGNAM }));

      await waitFor(() =>
        expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledWith({
          tripToken: TRIP_TOKEN,
          route: ROUTE,
          destinationName: GANGNAM,
          startTime: 1_000_000,
          outageConfirmed: true,
        }),
      );
    });

    it('outage로 armed된 상태에서 backend가 회복(healthy=true)되면 armed 예약을 cancel한다', async () => {
      mockUseSilentPushHealthCheck.mockReturnValue({ healthy: false, lastReceivedAt: null });
      useSettingsStore.setState({ sleepMode: true });
      const { rerender } = renderHook(
        ({ healthy }: { healthy: boolean }) => {
          mockUseSilentPushHealthCheck.mockReturnValue({ healthy, lastReceivedAt: null });
          return useSafetyNetScheduler({ route: ROUTE, destinationName: GANGNAM });
        },
        { initialProps: { healthy: false } },
      );
      await waitFor(() => expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(1));

      rerender({ healthy: true });

      await waitFor(() => expect(mockCancelAllSafetyNetAlarms).toHaveBeenCalledWith(TRIP_TOKEN));
      // backend가 정상으로 전환된 뒤에는 재등록하지 않는다.
      expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(1);
    });

    it('healthy=true(무장 없음) 상태에서 outage로 전환(healthy=false)되면 새로 무장한다', async () => {
      useSettingsStore.setState({ sleepMode: true });
      const { rerender } = renderHook(
        ({ healthy }: { healthy: boolean }) => {
          mockUseSilentPushHealthCheck.mockReturnValue({ healthy, lastReceivedAt: null });
          return useSafetyNetScheduler({ route: ROUTE, destinationName: GANGNAM });
        },
        { initialProps: { healthy: true } },
      );
      await waitFor(() => expect(mockGetTripStartedAt).toHaveBeenCalled());
      expect(mockRegisterSafetyNetAlarms).not.toHaveBeenCalled();

      rerender({ healthy: false });

      await waitFor(() => expect(mockRegisterSafetyNetAlarms).toHaveBeenCalledTimes(1));
      // 이전에 무장된 적이 없으므로 cancel은 호출되지 않는다.
      expect(mockCancelAllSafetyNetAlarms).not.toHaveBeenCalled();
    });
  });
});
