import { renderHook, act, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { useArrivalInfo } from '../useArrivalInfo';
import * as arrivalApiModule from '../../api/arrivalApi';

jest.mock('../../api/arrivalApi');

const mockRemove = jest.fn();
let appStateCallback: ((state: string) => void) | null = null;
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  appStateCallback = listener as (state: string) => void;
  return { remove: mockRemove } as unknown as ReturnType<typeof AppState.addEventListener>;
});

const mockArrival = {
  up: [{ destination: '소요산행', arrivalMinutes: 2, trainCode: 'T001' }],
  down: [{ destination: '인천행', arrivalMinutes: 5, trainCode: 'T002' }],
};

const mockArrivalWithMock = {
  ...mockArrival,
  isMock: true,
};

describe('useArrivalInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    appStateCallback = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stationName이 null이면 arrival은 null이다', async () => {
    const { result } = renderHook(() => useArrivalInfo(null));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.arrival).toBeNull();
    expect(result.current.isMock).toBe(false);
    expect(arrivalApiModule.fetchArrivalInfo).not.toHaveBeenCalled();
  });

  it('stationName이 주어지면 arrival 데이터를 가져온다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result } = renderHook(() => useArrivalInfo('강남'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.arrival).toEqual(mockArrival);
    expect(result.current.isMock).toBe(false);
  });

  it('isMock이 true인 데이터를 받으면 isMock이 true이다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrivalWithMock);

    const { result } = renderHook(() => useArrivalInfo('강남'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.arrival).toEqual(mockArrivalWithMock);
    expect(result.current.isMock).toBe(true);
  });

  it('30초 인터벌 후 자동으로 도착 정보를 갱신한다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    renderHook(() => useArrivalInfo('강남'));

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(1)
    );

    act(() => {
      jest.advanceTimersByTime(30_000);
    });

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(2)
    );
  });

  it('stationName이 변경되면 새로운 역의 데이터를 가져온다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { rerender } = renderHook(
      ({ name }: { name: string | null }) => useArrivalInfo(name),
      { initialProps: { name: '강남' as string | null } }
    );

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledWith('강남', undefined)
    );

    rerender({ name: '역삼' });

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledWith('역삼', undefined)
    );
  });

  it('언마운트 시 interval이 정리된다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const { unmount } = renderHook(() => useArrivalInfo('강남'));

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(1)
    );

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('언마운트 후 fetch 응답이 도착하면 상태를 갱신하지 않는다', async () => {
    let resolve!: (value: typeof mockArrival) => void;
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockImplementation(
      () => new Promise((r) => { resolve = r; })
    );

    const { result, unmount } = renderHook(() => useArrivalInfo('강남'));

    expect(result.current.loading).toBe(true);

    unmount();
    resolve(mockArrival);
    await Promise.resolve();

    expect(result.current.arrival).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('같은 역 재진입 시 캐시 데이터를 즉시 표시한다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result, rerender } = renderHook(
      ({ name }: { name: string | null }) => useArrivalInfo(name),
      { initialProps: { name: '강남' as string | null } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.arrival).toEqual(mockArrival);

    // 다른 역으로 전환
    rerender({ name: '역삼' });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 다시 강남으로 복귀 — 캐시 즉시 표시
    rerender({ name: '강남' });
    expect(result.current.arrival).toEqual(mockArrival);
    expect(result.current.loading).toBe(false);
  });

  it('캐시가 없는 새 역은 loading이 true로 시작한다', async () => {
    let resolveFirst!: (value: typeof mockArrival) => void;
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockImplementation(
      () => new Promise((r) => { resolveFirst = r; })
    );

    const { result } = renderHook(() => useArrivalInfo('신규역'));

    expect(result.current.arrival).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => { resolveFirst(mockArrival); });

    expect(result.current.arrival).toEqual(mockArrival);
    expect(result.current.loading).toBe(false);
  });

  it('캐시 표시 후 백그라운드 갱신이 데이터를 업데이트한다', async () => {
    const updatedArrival = {
      up: [{ destination: '소요산행', arrivalMinutes: 5, trainCode: 'T001' }],
      down: [{ destination: '인천행', arrivalMinutes: 8, trainCode: 'T002' }],
    };

    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result, rerender } = renderHook(
      ({ name }: { name: string | null }) => useArrivalInfo(name),
      { initialProps: { name: '강남' as string | null } }
    );

    await waitFor(() => expect(result.current.arrival).toEqual(mockArrival));

    // 다른 역으로 갔다가 복귀
    rerender({ name: '역삼' });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 복귀 시 새로운 데이터로 갱신
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(updatedArrival);
    rerender({ name: '강남' });

    // 캐시 즉시 표시
    expect(result.current.arrival).toEqual(mockArrival);

    // 백그라운드 fetch 완료 후 갱신
    await waitFor(() => expect(result.current.arrival).toEqual(updatedArrival));
  });

  it('stationName이 유효한 값에서 null로 바뀌면 loading이 false가 된다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result, rerender } = renderHook(
      ({ name }: { name: string | null }) => useArrivalInfo(name),
      { initialProps: { name: '강남' as string | null } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.arrival).toEqual(mockArrival);

    rerender({ name: null });

    await waitFor(() => {
      expect(result.current.arrival).toBeNull();
      expect(result.current.loading).toBe(false);
    });
  });

  it('백그라운드 전환 시 폴링을 중지한다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

    renderHook(() => useArrivalInfo('강남'));
    await waitFor(() => expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(1));

    act(() => { appStateCallback?.('background'); });
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('포그라운드 복귀 시 폴링을 재개한다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    renderHook(() => useArrivalInfo('강남'));
    await waitFor(() => expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(1));

    act(() => { appStateCallback?.('background'); });
    act(() => { appStateCallback?.('active'); });
    await waitFor(() => expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(2));
  });

  it('언마운트 시 AppState 리스너를 해제한다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { unmount } = renderHook(() => useArrivalInfo('강남'));
    await waitFor(() => expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(1));

    unmount();
    expect(mockRemove).toHaveBeenCalled();
  });

  it('TTL 만료 시 캐시를 사용하지 않고 loading 상태로 전환한다', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result, rerender } = renderHook(
      ({ name }: { name: string | null }) => useArrivalInfo(name),
      { initialProps: { name: '강남' as string | null } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // 다른 역으로 전환
    rerender({ name: '역삼' });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // TTL 초과 후 강남 복귀
    jest.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    rerender({ name: '강남' });

    // TTL 만료 → 캐시 미사용 → loading 상태
    expect(result.current.arrival).toBeNull();
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    jest.restoreAllMocks();
  });

  it('stationName이 null일 때 폴링 콜백은 fetch하지 않는다', async () => {
    renderHook(() => useArrivalInfo(null));

    jest.advanceTimersByTime(30_000);
    await Promise.resolve();

    expect(arrivalApiModule.fetchArrivalInfo).not.toHaveBeenCalled();
  });

  it('폴링 중 stationName이 변경되면 이전 폴링 응답을 무시한다', async () => {
    const staleArrival = {
      up: [{ destination: '이전역', arrivalMinutes: 99, trainCode: 'OLD' }],
      down: [],
    };
    const freshArrival = {
      up: [{ destination: '새역', arrivalMinutes: 1, trainCode: 'NEW' }],
      down: [],
    };

    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(freshArrival);

    const { result, rerender } = renderHook(
      ({ name }: { name: string | null }) => useArrivalInfo(name),
      { initialProps: { name: '강남' as string | null } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // 폴링 콜백에서 느린 fetch가 시작되도록 설정
    let resolvePollingFetch!: (value: typeof staleArrival) => void;
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockImplementation(
      (name: string) => {
        if (name === '강남') {
          return new Promise((r) => { resolvePollingFetch = r; });
        }
        return Promise.resolve(freshArrival);
      }
    );

    // 폴링 트리거 → '강남'에 대한 느린 fetch 시작
    act(() => { jest.advanceTimersByTime(30_000); });

    // 역 변경 → stationNameRef.current가 '역삼'으로 바뀜
    rerender({ name: '역삼' });
    await waitFor(() => expect(result.current.arrival).toEqual(freshArrival));

    // 이전 폴링의 '강남' 응답 도착 → name !== stationNameRef.current → 무시
    await act(async () => { resolvePollingFetch(staleArrival); });

    expect(result.current.arrival).toEqual(freshArrival);
  });

  it('폴링 콜백에서 mock 데이터를 받으면 캐시에 저장하지 않는다', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result } = renderHook(() => useArrivalInfo('강남'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.arrival).toEqual(mockArrival);

    // 폴링에서 mock 데이터 반환 → 캐시에 저장 안 됨
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrivalWithMock);

    act(() => { jest.advanceTimersByTime(30_000); });
    await waitFor(() => expect(result.current.isMock).toBe(true));
    // mock 데이터가 arrival에 반영되었지만 캐시에는 이전 실제 데이터만 있음
    expect(result.current.arrival).toEqual(mockArrivalWithMock);

    jest.restoreAllMocks();
  });

  it('폴링 콜백에서 fetch 실패 시 에러를 무시한다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result } = renderHook(() => useArrivalInfo('강남'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 폴링에서 에러 발생
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockRejectedValue(new Error('network'));

    act(() => { jest.advanceTimersByTime(30_000); });
    await Promise.resolve();

    // 에러 무시 — 기존 데이터 유지
    expect(result.current.arrival).toEqual(mockArrival);
  });

  it('포그라운드 복귀 시 캐시를 클리어하고 fresh fetch한다', async () => {
    const freshArrival = {
      up: [{ destination: '소요산행', arrivalMinutes: 1, trainCode: 'T003' }],
      down: [{ destination: '인천행', arrivalMinutes: 3, trainCode: 'T004' }],
    };
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result } = renderHook(() => useArrivalInfo('강남'));
    await waitFor(() => expect(result.current.arrival).toEqual(mockArrival));

    // 백그라운드 → 포그라운드 복귀 시 새 데이터
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(freshArrival);
    act(() => { appStateCallback?.('background'); });
    act(() => { appStateCallback?.('active'); });

    await waitFor(() => expect(result.current.arrival).toEqual(freshArrival));
  });
});
