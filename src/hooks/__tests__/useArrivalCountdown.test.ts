import { renderHook, act } from '@testing-library/react-native';
import { useArrivalCountdown } from '../useArrivalCountdown';
import type { StationArrival } from '../../api/arrivalApi';

const mockArrival: StationArrival = {
  up: [{ destination: '소요산행', arrivalMinutes: 2, arrivalSeconds: 120, statusMessage: '전역 출발', trainCode: 'T001', receivedAtMs: 0 }],
  down: [{ destination: '인천행', arrivalMinutes: 1, arrivalSeconds: 90, statusMessage: '', trainCode: 'T002', receivedAtMs: 0 }],
};

const mockArrivalMock: StationArrival = {
  ...mockArrival,
  isMock: true,
};

describe('useArrivalCountdown', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('arrival이 null이면 null을 반환한다', () => {
    const { result } = renderHook(() => useArrivalCountdown(null));
    expect(result.current).toBeNull();
  });

  it('초기값으로 arrival을 그대로 반환한다', () => {
    const { result } = renderHook(() => useArrivalCountdown(mockArrival));
    expect(result.current).toEqual(mockArrival);
  });

  it('1초마다 arrivalSeconds가 1씩 감소한다', () => {
    const { result } = renderHook(() => useArrivalCountdown(mockArrival));

    act(() => { jest.advanceTimersByTime(1_000); });

    expect(result.current!.up[0].arrivalSeconds).toBe(119);
    expect(result.current!.down[0].arrivalSeconds).toBe(89);
  });

  it('3초 후 arrivalSeconds가 3 감소하고 arrivalMinutes가 업데이트된다', () => {
    const { result } = renderHook(() => useArrivalCountdown(mockArrival));

    act(() => { jest.advanceTimersByTime(3_000); });

    expect(result.current!.up[0].arrivalSeconds).toBe(117);
    expect(result.current!.up[0].arrivalMinutes).toBe(1); // 117/60 = 1
    expect(result.current!.down[0].arrivalSeconds).toBe(87);
    expect(result.current!.down[0].arrivalMinutes).toBe(1); // 87/60 = 1
  });

  it('arrivalSeconds가 0 이하로 내려가지 않는다', () => {
    const nearArrival: StationArrival = {
      up: [{ destination: '소요산행', arrivalMinutes: 0, arrivalSeconds: 2, statusMessage: '곧 도착', trainCode: 'T001', receivedAtMs: 0 }],
      down: [],
    };

    const { result } = renderHook(() => useArrivalCountdown(nearArrival));

    act(() => { jest.advanceTimersByTime(5_000); });

    expect(result.current!.up[0].arrivalSeconds).toBe(0);
    expect(result.current!.up[0].arrivalMinutes).toBe(0);
  });

  it('isMock인 데이터는 카운트다운하지 않는다', () => {
    const { result } = renderHook(() => useArrivalCountdown(mockArrivalMock));

    act(() => { jest.advanceTimersByTime(3_000); });

    expect(result.current).toEqual(mockArrivalMock);
  });

  it('새 arrival 데이터가 들어오면 값이 리셋된다', () => {
    const { result, rerender } = renderHook(
      ({ arrival }: { arrival: StationArrival | null }) => useArrivalCountdown(arrival),
      { initialProps: { arrival: mockArrival as StationArrival | null } },
    );

    act(() => { jest.advanceTimersByTime(3_000); });
    expect(result.current!.up[0].arrivalSeconds).toBe(117);

    // 새 API 데이터 도착
    const newArrival: StationArrival = {
      up: [{ destination: '소요산행', arrivalMinutes: 3, arrivalSeconds: 200, statusMessage: '', trainCode: 'T001', receivedAtMs: 0 }],
      down: [{ destination: '인천행', arrivalMinutes: 2, arrivalSeconds: 150, statusMessage: '', trainCode: 'T002', receivedAtMs: 0 }],
    };

    rerender({ arrival: newArrival });
    expect(result.current!.up[0].arrivalSeconds).toBe(200);
  });

  it('arrival이 null에서 값으로 변경되면 카운트다운을 시작한다', () => {
    const { result, rerender } = renderHook(
      ({ arrival }: { arrival: StationArrival | null }) => useArrivalCountdown(arrival),
      { initialProps: { arrival: null as StationArrival | null } },
    );

    expect(result.current).toBeNull();

    rerender({ arrival: mockArrival });
    expect(result.current).toEqual(mockArrival);

    act(() => { jest.advanceTimersByTime(2_000); });
    expect(result.current!.up[0].arrivalSeconds).toBe(118);
  });

  it('arrival이 값에서 null로 변경되면 카운트다운을 중지한다', () => {
    const { result, rerender } = renderHook(
      ({ arrival }: { arrival: StationArrival | null }) => useArrivalCountdown(arrival),
      { initialProps: { arrival: mockArrival as StationArrival | null } },
    );

    act(() => { jest.advanceTimersByTime(1_000); });
    expect(result.current!.up[0].arrivalSeconds).toBe(119);

    rerender({ arrival: null });
    expect(result.current).toBeNull();
  });

  it('언마운트 시 카운트다운 인터벌이 정리된다', () => {
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

    const { unmount } = renderHook(() => useArrivalCountdown(mockArrival));

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('destination과 statusMessage 등 다른 필드는 유지된다', () => {
    const { result } = renderHook(() => useArrivalCountdown(mockArrival));

    act(() => { jest.advanceTimersByTime(1_000); });

    expect(result.current!.up[0].destination).toBe('소요산행');
    expect(result.current!.up[0].statusMessage).toBe('전역 출발');
    expect(result.current!.up[0].trainCode).toBe('T001');
  });
});
