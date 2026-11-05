import { renderHook, act } from '@testing-library/react-native';
import { useCountdown } from '../useCountdown';

describe('useCountdown', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('should return formatted mm:ss for a future timestamp', () => {
    const arrivalAtMs = 1_000_000 + 134 * 1000; // 134 seconds = 02:14
    const { result } = renderHook(() => useCountdown(arrivalAtMs));

    expect(result.current.mm).toBe('02');
    expect(result.current.ss).toBe('14');
    expect(result.current.totalSec).toBe(134);
    expect(result.current.done).toBe(false);
  });

  it('should count down every second', () => {
    const arrivalAtMs = 1_000_000 + 10 * 1000; // 10 seconds
    const { result } = renderHook(() => useCountdown(arrivalAtMs));

    expect(result.current.totalSec).toBe(10);

    // Advance 1 second
    (Date.now as jest.Mock).mockReturnValue(1_001_000);
    act(() => { jest.advanceTimersByTime(1000); });

    expect(result.current.totalSec).toBe(9);
    expect(result.current.ss).toBe('09');
  });

  it('should stop at 0 and set done to true', () => {
    const arrivalAtMs = 1_000_000 + 2 * 1000; // 2 seconds
    const { result } = renderHook(() => useCountdown(arrivalAtMs));

    expect(result.current.done).toBe(false);

    // Advance past the arrival time
    (Date.now as jest.Mock).mockReturnValue(1_000_000 + 3000);
    act(() => { jest.advanceTimersByTime(1000); });

    expect(result.current.totalSec).toBe(0);
    expect(result.current.mm).toBe('00');
    expect(result.current.ss).toBe('00');
    expect(result.current.done).toBe(true);
  });

  it('should handle already past timestamps', () => {
    const arrivalAtMs = 1_000_000 - 5000; // 5 seconds ago
    const { result } = renderHook(() => useCountdown(arrivalAtMs));

    expect(result.current.totalSec).toBe(0);
    expect(result.current.done).toBe(true);
    expect(result.current.mm).toBe('00');
    expect(result.current.ss).toBe('00');
  });

  it('should pad single digits with leading zeros', () => {
    const arrivalAtMs = 1_000_000 + 65 * 1000; // 1:05
    const { result } = renderHook(() => useCountdown(arrivalAtMs));

    expect(result.current.mm).toBe('01');
    expect(result.current.ss).toBe('05');
  });

  it('should reset timer when arrivalAtMs changes', () => {
    const arrivalAtMs1 = 1_000_000 + 60 * 1000;
    const { result, rerender } = renderHook(
      ({ ms }: { ms: number }) => useCountdown(ms),
      { initialProps: { ms: arrivalAtMs1 } },
    );

    expect(result.current.totalSec).toBe(60);

    // Change to a different arrival time
    const arrivalAtMs2 = 1_000_000 + 120 * 1000;
    rerender({ ms: arrivalAtMs2 });

    expect(result.current.totalSec).toBe(120);
    expect(result.current.mm).toBe('02');
    expect(result.current.ss).toBe('00');
  });

  it('should clean up interval on unmount', () => {
    const arrivalAtMs = 1_000_000 + 60 * 1000;
    const { unmount } = renderHook(() => useCountdown(arrivalAtMs));

    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('should handle large durations', () => {
    const arrivalAtMs = 1_000_000 + 3661 * 1000; // 61 minutes 1 second
    const { result } = renderHook(() => useCountdown(arrivalAtMs));

    expect(result.current.mm).toBe('61');
    expect(result.current.ss).toBe('01');
    expect(result.current.totalSec).toBe(3661);
  });
});
