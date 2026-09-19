import { renderHook, act } from '@testing-library/react-native';
import { useArrivalAutoClear, type UseArrivalAutoClearParams } from '../useArrivalAutoClear';

type Params = UseArrivalAutoClearParams;

const baseProps = (overrides: Partial<Params> = {}): Params => ({
  currentStationName: undefined,
  distanceKm: undefined,
  destinationName: undefined,
  onClear: jest.fn(),
  ...overrides,
});

describe('useArrivalAutoClear', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('초기 상태에서는 arrivedBanner가 false다', () => {
    const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps(),
    });
    expect(result.current.arrivedBanner).toBe(false);
  });

  it('도착 조건 충족 시 arrivedBanner=true가 되고 2초 뒤 onClear가 호출되며 banner가 false로 돌아온다', () => {
    const onClear = jest.fn();
    const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
        distanceKm: 0.3,
        onClear,
      }),
    });

    expect(result.current.arrivedBanner).toBe(true);
    expect(onClear).not.toHaveBeenCalled();

    act(() => { jest.advanceTimersByTime(2_000); });

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(result.current.arrivedBanner).toBe(false);
  });

  it('도착 후 2초 안에 distanceKm이 여러 번 바뀌어도 타이머가 살아남아 onClear가 호출된다 (#551 회귀)', () => {
    const onClear = jest.fn();
    const { result, rerender } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
        distanceKm: 0.3,
        onClear,
      }),
    });

    expect(result.current.arrivedBanner).toBe(true);

    act(() => { jest.advanceTimersByTime(500); });
    rerender(baseProps({ currentStationName: '용마산', destinationName: '용마산', distanceKm: 0.2, onClear }));
    act(() => { jest.advanceTimersByTime(500); });
    rerender(baseProps({ currentStationName: '용마산', destinationName: '용마산', distanceKm: 0.1, onClear }));
    act(() => { jest.advanceTimersByTime(500); });
    rerender(baseProps({ currentStationName: '용마산', destinationName: '용마산', distanceKm: 0.05, onClear }));

    expect(onClear).not.toHaveBeenCalled();

    act(() => { jest.advanceTimersByTime(500); });

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(result.current.arrivedBanner).toBe(false);
  });

  it('현재역이 목적지와 다르면 trigger하지 않는다', () => {
    const onClear = jest.fn();
    const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '강남',
        destinationName: '용마산',
        distanceKm: 0.1,
        onClear,
      }),
    });

    act(() => { jest.advanceTimersByTime(3_000); });

    expect(result.current.arrivedBanner).toBe(false);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('거리가 0.5km를 초과하면 trigger하지 않는다', () => {
    const onClear = jest.fn();
    const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
        distanceKm: 0.6,
        onClear,
      }),
    });

    expect(result.current.arrivedBanner).toBe(false);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('destinationName이 없으면 trigger하지 않는다', () => {
    const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        distanceKm: 0.1,
      }),
    });

    expect(result.current.arrivedBanner).toBe(false);
  });

  it('currentStationName이 없으면 trigger하지 않는다', () => {
    const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        destinationName: '용마산',
        distanceKm: 0.1,
      }),
    });

    expect(result.current.arrivedBanner).toBe(false);
  });

  it('distanceKm이 없으면 trigger하지 않는다', () => {
    const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
      }),
    });

    expect(result.current.arrivedBanner).toBe(false);
  });

  it('도착 트리거 이후 props가 같은 채로 rerender 되어도 새 타이머가 생기지 않는다', () => {
    const onClear = jest.fn();
    const props = baseProps({
      currentStationName: '용마산',
      destinationName: '용마산',
      distanceKm: 0.3,
      onClear,
    });
    const { rerender } = renderHook((p: Params) => useArrivalAutoClear(p), { initialProps: props });

    rerender(props);
    rerender(props);

    act(() => { jest.advanceTimersByTime(2_000); });

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('타이머 발화 전 unmount 되면 pending timer가 정리된다 (onClear 미호출)', () => {
    const onClear = jest.fn();
    const { unmount } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
        distanceKm: 0.3,
        onClear,
      }),
    });

    act(() => { jest.advanceTimersByTime(500); });
    unmount();
    act(() => { jest.advanceTimersByTime(2_000); });

    expect(onClear).not.toHaveBeenCalled();
  });

  it('도착 트리거 없는 상태로 unmount 되어도 안전하다', () => {
    const { unmount } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps(),
    });
    expect(() => unmount()).not.toThrow();
  });

  it('도착 후 destination이 null로 리셋되었다가 다시 같은 목적지로 설정되면 재트리거된다', () => {
    const onClear = jest.fn();
    const { result, rerender } = renderHook((p: Params) => useArrivalAutoClear(p), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
        distanceKm: 0.3,
        onClear,
      }),
    });

    act(() => { jest.advanceTimersByTime(2_000); });
    expect(onClear).toHaveBeenCalledTimes(1);

    rerender(baseProps({ currentStationName: '용마산', destinationName: undefined, distanceKm: 0.3, onClear }));
    rerender(baseProps({ currentStationName: '용마산', destinationName: '용마산', distanceKm: 0.3, onClear }));

    expect(result.current.arrivedBanner).toBe(true);
    act(() => { jest.advanceTimersByTime(2_000); });
    expect(onClear).toHaveBeenCalledTimes(2);
  });

  it('onClear가 바뀌면 최신 콜백이 호출된다', () => {
    const onClear1 = jest.fn();
    const onClear2 = jest.fn();
    const { rerender } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
        distanceKm: 0.3,
        onClear: onClear1,
      }),
    });

    rerender(baseProps({
      currentStationName: '용마산',
      destinationName: '용마산',
      distanceKm: 0.3,
      onClear: onClear2,
    }));

    act(() => { jest.advanceTimersByTime(2_000); });

    expect(onClear1).not.toHaveBeenCalled();
    expect(onClear2).toHaveBeenCalledTimes(1);
  });
});
