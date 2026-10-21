import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAnchorDepartures } from '../useAnchorDepartures';
import { ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';
import { fetchAnchorDepartures } from '../../api/anchorDepartures';

jest.mock('../../api/anchorDepartures', () => ({
  fetchAnchorDepartures: jest.fn(),
}));

const mockedFetch = fetchAnchorDepartures as jest.MockedFunction<typeof fetchAnchorDepartures>;
const VIEW = {
  station: '건대입구',
  line: '2',
  departed: [{ trainCode: '2011', departedAt: 1000, currentStation: '성수' }],
};

describe('useAnchorDepartures (#3155)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  });

  it('enabled + 활성 trip token → 마운트 즉시 조회해 view를 노출한다', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockedFetch.mockResolvedValue(VIEW);
    const { result } = renderHook(() => useAnchorDepartures({ enabled: true }));
    await waitFor(() => expect(result.current).toEqual(VIEW));
    expect(mockedFetch).toHaveBeenCalledWith('tk', 'https://api.test.dev');
  });

  it('30초마다 다시 조회하고, enabled=false인 동안의 tick은 조회하지 않는다', async () => {
    jest.useFakeTimers();
    try {
      await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
      mockedFetch.mockResolvedValue(VIEW);
      const { rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) => useAnchorDepartures({ enabled }),
        { initialProps: { enabled: true } },
      );
      await act(async () => {});
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(mockedFetch).toHaveBeenCalledTimes(2);
      rerender({ enabled: false });
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('enabled=false면 조회하지 않는다', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    renderHook(() => useAnchorDepartures({ enabled: false }));
    await act(async () => {});
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('활성 trip token이 없으면 조회하지 않고 null', async () => {
    const { result } = renderHook(() => useAnchorDepartures({ enabled: true }));
    await act(async () => {});
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('backend URL 미설정이면 조회하지 않는다', async () => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    renderHook(() => useAnchorDepartures({ enabled: true }));
    await act(async () => {});
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('조회 실패(null)는 view를 null로 — 섹션 없음', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockedFetch.mockResolvedValue(null);
    const { result } = renderHook(() => useAnchorDepartures({ enabled: true }));
    await act(async () => {});
    expect(result.current).toBeNull();
  });

  it('enabled가 꺼지면 이전 view를 비운다 (다음 trip에 이전 출발 열차 잔존 금지)', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockedFetch.mockResolvedValue(VIEW);
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAnchorDepartures({ enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current).toEqual(VIEW));
    rerender({ enabled: false });
    await waitFor(() => expect(result.current).toBeNull());
  });
});
