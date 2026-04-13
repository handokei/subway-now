import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useArrivalInfo } from '../useArrivalInfo';
import * as arrivalApiModule from '../../api/arrivalApi';

jest.mock('../../api/arrivalApi');

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
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledWith('강남')
    );

    rerender({ name: '역삼' });

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledWith('역삼')
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
