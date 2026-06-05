/* eslint-disable import/no-restricted-paths --
 * Cross-feature test mirroring source's disable. ADR Phase 5 (#890).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';
import { useBoardingLockSync, GOOD_FIX_ACCURACY_MAX_M, SYNC_DEBOUNCE_MS } from '../useBoardingLockSync';
import { syncBoardingLock } from '../../../nearest-station/api/boardingLockSync';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('../../../nearest-station/api/boardingLockSync', () => ({
  syncBoardingLock: jest.fn(),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockedSync = syncBoardingLock as jest.MockedFunction<typeof syncBoardingLock>;

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  await AsyncStorage.setItem(APNS_TOKEN_KEY, 'apns-tok');
  await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'trip-tok');
  mockedSync.mockResolvedValue({ ok: true, advanced: true, currentWaypoint: '역삼', nextStation: '역삼' });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

async function flushAsyncStorage(): Promise<void> {
  // AsyncStorage getItem은 microtask 큐로 처리 — fake timers 사용 중에도 promise를 흘려보낸다.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useBoardingLockSync (#901)', () => {
  it('tripActive=false → 발사 안 함', async () => {
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: false,
      }),
    );
    act(() => {
      jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100);
    });
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('currentStationName=null → 발사 안 함', async () => {
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: null,
        accuracyMeters: 10,
        tripActive: true,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('accuracy=null → 발사 안 함', async () => {
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: null,
        tripActive: true,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('accuracy > 50m → 발사 안 함', async () => {
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: GOOD_FIX_ACCURACY_MAX_M + 1,
        tripActive: true,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('좋은 fix + 새 station → debounce 후 1회 발사', async () => {
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
      }),
    );
    // debounce 도달 전엔 미발사
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS - 100));
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
    // debounce 경과 후 발사
    act(() => jest.advanceTimersByTime(200));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedSync.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        token: 'apns-tok',
        observedStationName: '강남',
        accuracy: 10,
      }),
    );
  });

  it('debounce 안에서 station 다시 바뀌면 timer reset → 1회만 발사', async () => {
    const { rerender } = renderHook(
      ({ station }: { station: string }) =>
        useBoardingLockSync({
          currentStationName: station,
          accuracyMeters: 10,
          tripActive: true,
        }),
      { initialProps: { station: '강남' } },
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS - 1000));
    rerender({ station: '역삼' });
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS - 100));
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(200));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedSync.mock.calls[0][0].observedStationName).toBe('역삼');
  });

  it('같은 station 재발사 안 함 (lastSentStation 기억)', async () => {
    const { rerender } = renderHook(
      ({ station }: { station: string }) =>
        useBoardingLockSync({
          currentStationName: station,
          accuracyMeters: 10,
          tripActive: true,
        }),
      { initialProps: { station: '강남' } },
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    rerender({ station: '강남' });
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it('forceTriggerKey 변경 → debounce 우회 즉시 발사', async () => {
    const { rerender } = renderHook(
      ({ key }: { key: string | null }) =>
        useBoardingLockSync({
          currentStationName: '강남',
          accuracyMeters: 10,
          tripActive: true,
          forceTriggerKey: key,
        }),
      { initialProps: { key: null as string | null } },
    );
    expect(mockedSync).not.toHaveBeenCalled();
    rerender({ key: 'trip-created' });
    await flushAsyncStorage();
    // debounce 경과 없이도 발사됐어야 함
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it('같은 forceTriggerKey 재전달 → 재발사 안 함', async () => {
    const { rerender } = renderHook(
      ({ key }: { key: string }) =>
        useBoardingLockSync({
          currentStationName: '강남',
          accuracyMeters: 10,
          tripActive: true,
          forceTriggerKey: key,
        }),
      { initialProps: { key: 'k1' } },
    );
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    rerender({ key: 'k1' });
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it('forceTriggerKey 다른 값 → 재발사', async () => {
    const { rerender } = renderHook(
      ({ key }: { key: string }) =>
        useBoardingLockSync({
          currentStationName: '강남',
          accuracyMeters: 10,
          tripActive: true,
          forceTriggerKey: key,
        }),
      { initialProps: { key: 'k1' } },
    );
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    rerender({ key: 'k2' });
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(2);
  });

  it('force 트리거지만 currentStation null → 발사 안 함', async () => {
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: null,
        accuracyMeters: 10,
        tripActive: true,
        forceTriggerKey: 'k',
      }),
    );
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('force 트리거지만 accuracy null → 발사 안 함', async () => {
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: null,
        tripActive: true,
        forceTriggerKey: 'k',
      }),
    );
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('force 트리거지만 accuracy > 50m → 발사 안 함', async () => {
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: GOOD_FIX_ACCURACY_MAX_M + 1,
        tripActive: true,
        forceTriggerKey: 'k',
      }),
    );
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('force 트리거지만 tripActive=false → 발사 안 함', async () => {
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: false,
        forceTriggerKey: 'k',
      }),
    );
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('APNs 토큰 없으면 graceful skip', async () => {
    await AsyncStorage.removeItem(APNS_TOKEN_KEY);
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('ACTIVE_TRIP_KEY 없으면 graceful skip', async () => {
    await AsyncStorage.removeItem(ACTIVE_TRIP_KEY);
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('subsurface 옵션 전달', async () => {
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
        subsurface: false,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedSync.mock.calls[0][0].subsurface).toBe(false);
  });

  it('같은 station이지만 다른 dep(accuracy) 변경 시 — 재발사 안 함 (lastSentStation 게이트)', async () => {
    const { rerender } = renderHook(
      ({ acc }: { acc: number }) =>
        useBoardingLockSync({
          currentStationName: '강남',
          accuracyMeters: acc,
          tripActive: true,
        }),
      { initialProps: { acc: 10 } },
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    // accuracy만 바뀌어 effect 재실행되지만 같은 station → lastSentStation 게이트로 발사 안 함
    rerender({ acc: 20 });
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it('forceTriggerKey 발사 후 다른 dep만 변경 → lastForceKey 게이트로 재발사 안 함', async () => {
    const { rerender } = renderHook(
      ({ acc }: { acc: number }) =>
        useBoardingLockSync({
          currentStationName: '강남',
          accuracyMeters: acc,
          tripActive: true,
          forceTriggerKey: 'k1',
        }),
      { initialProps: { acc: 10 } },
    );
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    // accuracy만 바뀌어 force effect 재실행. forceTriggerKey 동일 → 발사 안 함.
    rerender({ acc: 20 });
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it('backend 응답에 advanced/currentWaypoint 누락 → log fallback (?? 분기 커버)', async () => {
    mockedSync.mockResolvedValueOnce({ ok: true });
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it('force 트리거 + station 동시 변경 — 중복 발사 차단 (race 가드)', async () => {
    // 같은 mount에서 forceTriggerKey와 station이 동시에 활성 — effect 2가 즉시 발사하고,
    // effect 1의 5s timer는 lastSentStation 동기 set 덕에 fireSync 호출 skip해야 함.
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
        forceTriggerKey: 'k1',
      }),
    );
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    // debounce 만료 — 이미 lastSentStation이 set돼 있어 추가 발사 없어야 함.
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it('debounce timer cleanup — unmount 시 미발사', async () => {
    const { unmount } = renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS - 1000));
    unmount();
    act(() => jest.advanceTimersByTime(2000));
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });
});
