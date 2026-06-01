import { renderHook, act } from '@testing-library/react-native';
import { usePositionStability } from '../usePositionStability';

describe('usePositionStability', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('초기에 userLocation 없으면 unknown', () => {
    const { result } = renderHook(() => usePositionStability(null));
    expect(result.current).toBe('unknown');
  });

  it('userLocation null이 유지되면 stability도 unknown 유지', () => {
    const { result, rerender } = renderHook(
      ({ loc }: { loc: { lat: number; lng: number } | null }) =>
        usePositionStability(loc),
      { initialProps: { loc: null } },
    );
    rerender({ loc: null });
    expect(result.current).toBe('unknown');
  });

  it('sample 1개만 들어오면 unknown (minSamples 미달)', () => {
    const { result, rerender } = renderHook(
      ({ loc }: { loc: { lat: number; lng: number } | null }) =>
        usePositionStability(loc),
      { initialProps: { loc: null } },
    );

    act(() => {
      (Date.now as jest.Mock).mockReturnValue(1_000_000);
      rerender({ loc: { lat: 37.5756, lng: 127.087 } });
    });
    expect(result.current).toBe('unknown');
  });

  it('60s 윈도우에 같은 좌표 3개 들어오면 static', () => {
    const { result, rerender } = renderHook(
      ({ loc }: { loc: { lat: number; lng: number } | null }) =>
        usePositionStability(loc),
      { initialProps: { loc: null } },
    );

    act(() => {
      (Date.now as jest.Mock).mockReturnValue(1_000_000);
      rerender({ loc: { lat: 37.5756, lng: 127.087 } });
    });
    act(() => {
      (Date.now as jest.Mock).mockReturnValue(1_030_000);
      rerender({ loc: { lat: 37.5756, lng: 127.0871 } });
    });
    act(() => {
      (Date.now as jest.Mock).mockReturnValue(1_060_000);
      rerender({ loc: { lat: 37.5756, lng: 127.087 } });
    });

    expect(result.current).toBe('static');
  });

  it('서로 떨어진 좌표 3개 들어오면 moving', () => {
    const { result, rerender } = renderHook(
      ({ loc }: { loc: { lat: number; lng: number } | null }) =>
        usePositionStability(loc),
      { initialProps: { loc: null } },
    );

    act(() => {
      (Date.now as jest.Mock).mockReturnValue(1_000_000);
      rerender({ loc: { lat: 37.5756, lng: 127.087 } });
    });
    act(() => {
      (Date.now as jest.Mock).mockReturnValue(1_030_000);
      rerender({ loc: { lat: 37.58, lng: 127.087 } });
    });
    act(() => {
      (Date.now as jest.Mock).mockReturnValue(1_060_000);
      rerender({ loc: { lat: 37.59, lng: 127.087 } });
    });

    expect(result.current).toBe('moving');
  });

  it('userLocation이 null 되면 sample 추가 안 되고 직전 stability 유지', () => {
    const { result, rerender } = renderHook(
      ({ loc }: { loc: { lat: number; lng: number } | null }) =>
        usePositionStability(loc),
      { initialProps: { loc: null } },
    );

    act(() => {
      (Date.now as jest.Mock).mockReturnValue(1_000_000);
      rerender({ loc: { lat: 37.5756, lng: 127.087 } });
    });
    act(() => {
      (Date.now as jest.Mock).mockReturnValue(1_030_000);
      rerender({ loc: { lat: 37.5756, lng: 127.0871 } });
    });
    act(() => {
      (Date.now as jest.Mock).mockReturnValue(1_060_000);
      rerender({ loc: { lat: 37.5756, lng: 127.087 } });
    });
    expect(result.current).toBe('static');

    act(() => {
      (Date.now as jest.Mock).mockReturnValue(1_090_000);
      rerender({ loc: null });
    });
    expect(result.current).toBe('static');
  });

  it('오래된 sample(prune window 초과)은 자동 제거 — buffer 누적 안 됨', () => {
    const { result, rerender } = renderHook(
      ({ loc }: { loc: { lat: number; lng: number } | null }) =>
        usePositionStability(loc),
      { initialProps: { loc: null } },
    );

    for (let i = 0; i < 3; i++) {
      act(() => {
        (Date.now as jest.Mock).mockReturnValue(1_000_000 + i * 30_000);
        rerender({ loc: { lat: 37.5756 + i * 0.0001, lng: 127.087 } });
      });
    }
    expect(result.current).toBe('static');

    // 5분 후 큰 점프 — 오래된 sample은 prune되어야 하므로 새로운 burst만 본다.
    act(() => {
      (Date.now as jest.Mock).mockReturnValue(1_400_000);
      rerender({ loc: { lat: 37.6, lng: 127.1 } });
    });
    expect(result.current).toBe('unknown');
  });
});
