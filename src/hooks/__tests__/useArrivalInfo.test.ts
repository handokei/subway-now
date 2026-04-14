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

  it('AppState가 active로 변경되면 도착 정보를 다시 가져온다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    renderHook(() => useArrivalInfo('강남'));

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(1)
    );

    await act(async () => {
      appStateCallback?.('active');
    });

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(2)
    );
  });

  it('AppState가 background로 변경되면 interval을 정리한다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    renderHook(() => useArrivalInfo('강남'));

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(1)
    );

    act(() => {
      appStateCallback?.('background');
    });

    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
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
});
