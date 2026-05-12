import { renderHook, act } from '@testing-library/react-native';
import { useRouteProgress, type UseRouteProgressInputs } from '../useRouteProgress';
import { findStationByNameAndLine } from '../../utils/stationRoute';
import type { DirectRoute, Route } from '../../utils/stationRoute';
import type { Station } from '../../types/station';

const sagajeong = findStationByNameAndLine('사가정', '7')!;
const childrenPark = findStationByNameAndLine('어린이대공원', '7')!;
const gunja = findStationByNameAndLine('군자', '7')!;
const directRoute: DirectRoute = { type: 'direct', stops: 4, line: '7' };

function makeProps(overrides: Partial<UseRouteProgressInputs> = {}): UseRouteProgressInputs {
  return {
    route: directRoute,
    origin: sagajeong,
    destination: childrenPark,
    userLocation: null,
    speedMps: null,
    accuracyMeters: null,
    ...overrides,
  };
}

describe('useRouteProgress', () => {
  it('returns null arc when route is null', () => {
    const { result } = renderHook(() => useRouteProgress(makeProps({ route: null })));
    expect(result.current.arc).toBeNull();
    expect(result.current.progressM).toBeNull();
    expect(result.current.position).toBeNull();
  });

  it('returns null arc when origin is null', () => {
    const { result } = renderHook(() => useRouteProgress(makeProps({ origin: null })));
    expect(result.current.arc).toBeNull();
  });

  it('returns null arc when destination is null', () => {
    const { result } = renderHook(() => useRouteProgress(makeProps({ destination: null })));
    expect(result.current.arc).toBeNull();
  });

  it('returns null progressM/position before first GPS observation', () => {
    const { result } = renderHook(() => useRouteProgress(makeProps()));
    expect(result.current.arc).not.toBeNull();
    expect(result.current.progressM).toBeNull();
    expect(result.current.position).toBeNull();
  });

  it('initializes progressM to projection arc on first GPS observation', () => {
    const { result, rerender } = renderHook(
      (p: UseRouteProgressInputs) => useRouteProgress(p),
      { initialProps: makeProps() },
    );
    expect(result.current.progressM).toBeNull();

    act(() => {
      rerender(
        makeProps({
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          speedMps: 0,
          accuracyMeters: 30,
        }),
      );
    });

    expect(result.current.progressM).not.toBeNull();
    expect(result.current.progressM!).toBeLessThan(10);
    expect(result.current.position?.current.id).toBe(sagajeong.id);
  });

  it('blends new GPS observation with dead-reckoning prediction', () => {
    jest.useFakeTimers();
    const startTime = 1_000_000_000;
    jest.setSystemTime(startTime);

    const { result, rerender } = renderHook(
      (p: UseRouteProgressInputs) => useRouteProgress(p),
      {
        initialProps: makeProps({
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          speedMps: 10,
          accuracyMeters: 30,
        }),
      },
    );
    const firstProgress = result.current.progressM;
    expect(firstProgress).not.toBeNull();

    // 200초 뒤(implied speed 검사 통과 충분) — 군자 좌표(앞으로 진행)
    jest.setSystemTime(startTime + 200_000);
    act(() => {
      rerender(
        makeProps({
          userLocation: { lat: gunja.lat, lng: gunja.lng },
          speedMps: 10,
          accuracyMeters: 30,
        }),
      );
    });

    expect(result.current.progressM!).toBeGreaterThan(firstProgress!);
    expect(result.current.position?.current.id).toBe(gunja.id);
    jest.useRealTimers();
  });

  it('rejects GPS observation when off-route by more than 1.5km', () => {
    const { result, rerender } = renderHook(
      (p: UseRouteProgressInputs) => useRouteProgress(p),
      {
        initialProps: makeProps({
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          speedMps: 0,
          accuracyMeters: 30,
        }),
      },
    );
    const baseline = result.current.progressM!;

    // 명백히 경로 밖(여의도 근처) 좌표 — perp > 1.5km
    act(() => {
      rerender(
        makeProps({
          userLocation: { lat: 37.5219, lng: 126.9244 },
          speedMps: 0,
          accuracyMeters: 30,
        }),
      );
    });

    // 관측은 무시 — dead reckoning만 적용되므로 큰 변화 없음(속도 0).
    expect(Math.abs(result.current.progressM! - baseline)).toBeLessThan(100);
  });

  it('rejects GPS observation when implied speed exceeds 200 km/h', () => {
    jest.useFakeTimers();
    const startTime = 1_000_000_000;
    jest.setSystemTime(startTime);

    const { result, rerender } = renderHook(
      (p: UseRouteProgressInputs) => useRouteProgress(p),
      {
        initialProps: makeProps({
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          speedMps: 0,
          accuracyMeters: 30,
        }),
      },
    );
    const baseline = result.current.progressM!;

    // 1초 뒤 어린이대공원 좌표(약 4km 떨어짐) — implied speed 4000m/s ≫ 55m/s, 점프로 판정
    jest.setSystemTime(startTime + 1000);
    act(() => {
      rerender(
        makeProps({
          userLocation: { lat: childrenPark.lat, lng: childrenPark.lng },
          speedMps: 0,
          accuracyMeters: 30,
        }),
      );
    });

    // 관측 거부 — dead reckoning만(속도 0) → progress 거의 그대로
    expect(Math.abs(result.current.progressM! - baseline)).toBeLessThan(100);
    jest.useRealTimers();
  });

  it('uses last known speed when speedMps is null', () => {
    jest.useFakeTimers();
    const startTime = 1_000_000_000;
    jest.setSystemTime(startTime);

    const { result, rerender } = renderHook(
      (p: UseRouteProgressInputs) => useRouteProgress(p),
      {
        initialProps: makeProps({
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          speedMps: 15,
          accuracyMeters: 30,
        }),
      },
    );

    // 같은 좌표로 5초 뒤 speed null — dead reckoning 시 직전 속도 15 m/s 사용
    jest.setSystemTime(startTime + 5000);
    act(() => {
      rerender(
        makeProps({
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          speedMps: null,
          accuracyMeters: 30,
        }),
      );
    });

    // dead reckoning은 5초 × 15 m/s = 75m 진행 예측
    expect(result.current.progressM!).toBeGreaterThan(0);
    jest.useRealTimers();
  });

  it('treats negative speedMps as missing and keeps last known speed', () => {
    jest.useFakeTimers();
    const startTime = 1_000_000_000;
    jest.setSystemTime(startTime);

    const { result, rerender } = renderHook(
      (p: UseRouteProgressInputs) => useRouteProgress(p),
      {
        initialProps: makeProps({
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          speedMps: 10,
          accuracyMeters: 30,
        }),
      },
    );
    expect(result.current.progressM).not.toBeNull();

    jest.setSystemTime(startTime + 200_000);
    act(() => {
      rerender(
        makeProps({
          userLocation: { lat: gunja.lat, lng: gunja.lng },
          speedMps: -1,
          accuracyMeters: 30,
        }),
      );
    });
    expect(result.current.position?.current.id).toBe(gunja.id);
    jest.useRealTimers();
  });

  it('uses fallback weight when accuracyMeters is null', () => {
    jest.useFakeTimers();
    const startTime = 1_000_000_000;
    jest.setSystemTime(startTime);

    const { result, rerender } = renderHook(
      (p: UseRouteProgressInputs) => useRouteProgress(p),
      {
        initialProps: makeProps({
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          speedMps: 0,
          accuracyMeters: null,
        }),
      },
    );
    const firstProgress = result.current.progressM;

    // 200초 뒤(implied speed 검사 통과) — null accuracy로 blend 경로 도달.
    jest.setSystemTime(startTime + 200_000);
    act(() => {
      rerender(
        makeProps({
          userLocation: { lat: gunja.lat, lng: gunja.lng },
          speedMps: 0,
          accuracyMeters: null,
        }),
      );
    });

    expect(result.current.progressM).not.toBeNull();
    expect(result.current.progressM!).not.toBe(firstProgress);
    jest.useRealTimers();
  });

  it('resets state when route changes', () => {
    const { result, rerender } = renderHook(
      (p: UseRouteProgressInputs) => useRouteProgress(p),
      {
        initialProps: makeProps({
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          speedMps: 0,
          accuracyMeters: 30,
        }),
      },
    );
    expect(result.current.progressM).not.toBeNull();

    const otherRoute: Route = { type: 'direct', stops: 1, line: '7' };
    act(() => {
      rerender(
        makeProps({
          route: otherRoute,
          origin: gunja,
          destination: childrenPark,
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          speedMps: 0,
          accuracyMeters: 30,
        }),
      );
    });

    // 새 경로(gunja→childrenPark)에서 sagajeong 사영 → off-route(perp 큼)지만
    // 초기화 직후엔 off-route 게이트 우회로 사영점에 snap.
    expect(result.current.progressM).not.toBeNull();
  });

  it('handles arc but missing userLocation gracefully on re-render', () => {
    const { result, rerender } = renderHook(
      (p: UseRouteProgressInputs) => useRouteProgress(p),
      {
        initialProps: makeProps({
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          speedMps: 0,
          accuracyMeters: 30,
        }),
      },
    );
    expect(result.current.progressM).not.toBeNull();
    const before = result.current.progressM;

    act(() => {
      rerender(
        makeProps({
          userLocation: null,
          speedMps: 0,
          accuracyMeters: 30,
        }),
      );
    });

    // userLocation null이면 effect early return — 상태 변경 없음.
    expect(result.current.progressM).toBe(before);
  });

  it('snaps to origin (arc=0) when first observation is off-route', () => {
    const { result, rerender } = renderHook(
      (p: UseRouteProgressInputs) => useRouteProgress(p),
      { initialProps: makeProps() },
    );

    // 첫 관측이 여의도 — 경로(어린이대공원→사가정)에서 매우 멀다(perp ≫ 1.5km)
    act(() => {
      rerender(
        makeProps({
          userLocation: { lat: 37.5219, lng: 126.9244 },
          speedMps: 0,
          accuracyMeters: 30,
        }),
      );
    });

    expect(result.current.progressM).toBe(0);
    expect(result.current.position?.current.id).toBe(sagajeong.id);
  });

  it('continues to reject consecutive GPS jumps (trusted baseline preserved)', () => {
    jest.useFakeTimers();
    const startTime = 1_000_000_000;
    jest.setSystemTime(startTime);

    const { result, rerender } = renderHook(
      (p: UseRouteProgressInputs) => useRouteProgress(p),
      {
        initialProps: makeProps({
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          speedMps: 0,
          accuracyMeters: 30,
        }),
      },
    );
    const baseline = result.current.progressM!;

    // 5번 연속 점프 관측 — 모두 거부되어 progress 안정 유지
    for (let i = 1; i <= 5; i++) {
      jest.setSystemTime(startTime + i * 2000);
      act(() => {
        rerender(
          makeProps({
            userLocation: { lat: childrenPark.lat, lng: childrenPark.lng },
            speedMps: 0,
            accuracyMeters: 30,
          }),
        );
      });
    }

    // dead reckoning만 누적 — 속도 0이므로 progress 거의 그대로
    expect(Math.abs(result.current.progressM! - baseline)).toBeLessThan(100);
    expect(result.current.position?.current.id).toBe(sagajeong.id);
    jest.useRealTimers();
  });

  it('falls back to dead-reckoning when dt is 0 (same-tick observation)', () => {
    jest.useFakeTimers();
    const startTime = 1_000_000_000;
    jest.setSystemTime(startTime);

    const { result, rerender } = renderHook(
      (p: UseRouteProgressInputs) => useRouteProgress(p),
      {
        initialProps: makeProps({
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          speedMps: 0,
          accuracyMeters: 30,
        }),
      },
    );

    // 시간 정지한 채로 새 관측 → dt=0이면 점프 거부 분기를 우회하고 바로 blend.
    act(() => {
      rerender(
        makeProps({
          userLocation: { lat: gunja.lat, lng: gunja.lng },
          speedMps: 0,
          accuracyMeters: 30,
        }),
      );
    });

    expect(result.current.position?.current.id).toBe(gunja.id);
    jest.useRealTimers();
  });
});
