import { renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { usePolling } from '../usePolling';

const mockRemove = jest.fn();
let appStateCallback: ((state: string) => void) | null = null;
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  appStateCallback = listener as (state: string) => void;
  return { remove: mockRemove } as unknown as ReturnType<typeof AppState.addEventListener>;
});

describe('usePolling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    appStateCallback = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('intervalMs 간격으로 callback을 반복 호출한다', () => {
    const cb = jest.fn();
    renderHook(() => usePolling(cb, 30_000));

    expect(cb).not.toHaveBeenCalled();

    jest.advanceTimersByTime(30_000);
    expect(cb).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(30_000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('백그라운드 전환 시 인터벌을 중지한다', () => {
    const cb = jest.fn();
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    renderHook(() => usePolling(cb, 30_000));

    appStateCallback?.('background');
    expect(clearIntervalSpy).toHaveBeenCalled();

    // 백그라운드에서는 호출되지 않음
    jest.advanceTimersByTime(60_000);
    expect(cb).not.toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
  });

  it('포그라운드 복귀 시 즉시 호출 + 인터벌 재시작', () => {
    const cb = jest.fn();
    renderHook(() => usePolling(cb, 30_000));

    appStateCallback?.('background');
    appStateCallback?.('active');

    // 즉시 호출
    expect(cb).toHaveBeenCalledTimes(1);

    // 인터벌 재시작
    jest.advanceTimersByTime(30_000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('포그라운드 복귀 시 onResume을 callback 전에 호출한다', () => {
    const order: string[] = [];
    const cb = jest.fn(() => order.push('callback'));
    const onResume = jest.fn(() => order.push('onResume'));

    renderHook(() => usePolling(cb, 30_000, { onResume }));

    appStateCallback?.('background');
    appStateCallback?.('active');

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['onResume', 'callback']);
  });

  it('onResume 없이도 정상 동작한다', () => {
    const cb = jest.fn();
    renderHook(() => usePolling(cb, 30_000));

    appStateCallback?.('background');
    appStateCallback?.('active');

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('언마운트 시 인터벌과 AppState 리스너를 정리한다', () => {
    const cb = jest.fn();
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

    const { unmount } = renderHook(() => usePolling(cb, 30_000));

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(mockRemove).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
  });

  it('callback이 변경되면 최신 callback을 호출한다', () => {
    const cb1 = jest.fn();
    const cb2 = jest.fn();

    const { rerender } = renderHook(
      (props: { cb: () => void }) => usePolling(props.cb, 30_000),
      { initialProps: { cb: cb1 } },
    );

    rerender({ cb: cb2 });

    jest.advanceTimersByTime(30_000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
