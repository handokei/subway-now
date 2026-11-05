import { renderHook, act } from '@testing-library/react-native';
import { useRouteProgress, type UseRouteProgressInputs } from '../useRouteProgress';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import type { Route } from '../../../../shared/utils/stationRoute';
import type { Station } from '../../../../shared/types/station';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
import { computeRouteArc, currentHopDistanceM, nearestArcPoint } from '../../utils/routeProgress';

const sagajeong = findStationByNameAndLine('사가정', '7')!;
const childrenPark = findStationByNameAndLine('어린이대공원', '7')!;
const gunja = findStationByNameAndLine('군자', '7')!;
const directRoute = makeDirectRoute(4, '7');

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

    const otherRoute: Route = makeDirectRoute(1, '7');
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

  // #2093 (item C) — arc 시간적분 오버슛 gate 경계값 검증.
  describe('arc overshoot gate (item C)', () => {
    it('does not invalidate dead-reckoning when overshoot stays within hop x2', () => {
      jest.useFakeTimers();
      const startTime = 1_000_000_000;
      jest.setSystemTime(startTime);

      const arcForHop = computeRouteArc(directRoute, sagajeong, childrenPark)!;
      const hopM = currentHopDistanceM(arcForHop, 0);
      const speedJustUnder = (hopM * 2 - 20) / 10; // 10초 뒤 예측 이동 = hopM×2 - 20m (임계 직전)

      const { result, rerender } = renderHook(
        (p: UseRouteProgressInputs) => useRouteProgress(p),
        {
          initialProps: makeProps({
            userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
            speedMps: speedJustUnder,
            accuracyMeters: 30,
          }),
        },
      );
      const baseline = result.current.progressM!;

      jest.setSystemTime(startTime + 10_000);
      act(() => {
        rerender(
          makeProps({
            // 명백히 off-route(perp > 1.5km) — dead-reckoning 예측치가 그대로 progress에 반영된다.
            userLocation: { lat: 37.5219, lng: 126.9244 },
            speedMps: speedJustUnder,
            accuracyMeters: 30,
          }),
        );
      });

      expect(result.current.progressM!).toBeGreaterThan(baseline);
      expect(result.current.progressM!).toBeCloseTo(baseline + speedJustUnder * 10, 0);
      jest.useRealTimers();
    });

    it('invalidates dead-reckoning and freezes at trusted anchor when overshoot exceeds hop x2', () => {
      jest.useFakeTimers();
      const startTime = 1_000_000_000;
      jest.setSystemTime(startTime);

      const arcForHop = computeRouteArc(directRoute, sagajeong, childrenPark)!;
      const hopM = currentHopDistanceM(arcForHop, 0);
      const speedOver = (hopM * 2 + 100) / 10; // 10초 뒤 예측 이동 = hopM×2 + 100m (임계 초과)

      const { result, rerender } = renderHook(
        (p: UseRouteProgressInputs) => useRouteProgress(p),
        {
          initialProps: makeProps({
            userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
            speedMps: speedOver,
            accuracyMeters: 30,
          }),
        },
      );
      const baseline = result.current.progressM!;

      jest.setSystemTime(startTime + 10_000);
      act(() => {
        rerender(
          makeProps({
            userLocation: { lat: 37.5219, lng: 126.9244 },
            speedMps: speedOver,
            accuracyMeters: 30,
          }),
        );
      });

      // 오버슛 게이트 발동 — predicted가 lastTrustedProgressM(baseline)로 무효화되어 progress 변화 없음.
      expect(result.current.progressM).toBe(baseline);
      jest.useRealTimers();
    });

    // review P3-1 — 오버슛 게이트가 off-route 분기뿐 아니라 on-route(blend) 분기에도 적용되는지 검증.
    it('applies the overshoot gate on the on-route blend branch, not only off-route', () => {
      jest.useFakeTimers();
      const startTime = 1_000_000_000;
      jest.setSystemTime(startTime);

      const arcForHop = computeRouteArc(directRoute, sagajeong, childrenPark)!;
      const hopM = currentHopDistanceM(arcForHop, 0);
      // 5초 뒤 rawPredicted = speedOver × 5 가 hopM×2를 명백히 초과하도록 큰 speed 설정.
      const speedOver = (hopM * 2 + 1000) / 5;

      const { result, rerender } = renderHook(
        (p: UseRouteProgressInputs) => useRouteProgress(p),
        {
          initialProps: makeProps({
            userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
            speedMps: speedOver,
            accuracyMeters: 300,
          }),
        },
      );
      const baseline = result.current.progressM!;

      jest.setSystemTime(startTime + 5_000);
      act(() => {
        rerender(
          makeProps({
            // 같은 위치(perp≈0, on-route) — off-route 분기가 아닌 정상 blend 분기를 탄다.
            userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
            speedMps: speedOver,
            accuracyMeters: 300,
          }),
        );
      });

      // 게이트가 blend 분기에도 적용돼 predicted가 clamp됨 — 미적용 시 blended가
      // (speedOver × 5) × 0.5 ≈ 수천 m로 튀지만, 적용 시 baseline 근처(수십 m)로 유지된다.
      expect(Math.abs(result.current.progressM! - baseline)).toBeLessThan(100);
      jest.useRealTimers();
    });
  });

  // #2093 (item D) — route-progress 원점 stuck 해소용 GPS 합의 지점 re-seed 검증.
  describe('stale re-seed (item D)', () => {
    it('re-seeds to GPS consensus point after long stale period when fix is accurate and on-route', () => {
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

      // 130초(> ROUTE_PROGRESS_RESEED_STALE_MS) 무신호 후 정확도 좋은(< 100m) fix가 경로 위(어린이대공원)에서
      // 재포착. sagajeong→childrenPark 거리(~3,871m) ÷ 130s ≈ 29.8 m/s로 ROUTE_PROGRESS_RESEED_MAX_PLAUSIBLE_MPS
      // (35 m/s) 이내라 물리적으로 타당 — implied speed(55 m/s) 기준으로는 거부될 큰 점프지만 re-seed가 우회한다.
      jest.setSystemTime(startTime + 130_000);
      act(() => {
        rerender(
          makeProps({
            userLocation: { lat: childrenPark.lat, lng: childrenPark.lng },
            speedMps: 0,
            accuracyMeters: 30,
          }),
        );
      });

      expect(result.current.progressM!).toBeGreaterThan(baseline);
      expect(result.current.position?.current.id).toBe(childrenPark.id);
      jest.useRealTimers();
    });

    // review P2-1 — re-seed 물리적 타당성 가드 경계값 + 후진 multipath 시나리오.
    describe('physical plausibility guard (review P2-1)', () => {
      it('re-seeds when implied speed is just under the plausibility limit', () => {
        jest.useFakeTimers();
        const startTime = 1_000_000_000;
        jest.setSystemTime(startTime);

        const arcForHop = computeRouteArc(directRoute, sagajeong, childrenPark)!;
        const gunjaProj = nearestArcPoint(arcForHop, gunja.lat, gunja.lng);
        // 81초: maxPlausibleM = 35 × 81 = 2,835m > gunja 거리(~2,800.66m) — 임계 직전(허용).
        const staleSec = 81;

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

        jest.setSystemTime(startTime + staleSec * 1000);
        act(() => {
          rerender(
            makeProps({
              userLocation: { lat: gunja.lat, lng: gunja.lng },
              speedMps: 0,
              accuracyMeters: 30,
            }),
          );
        });

        // re-seed가 발동하면 progressM이 GPS 사영점(proj.arcM)에 정확히 snap된다(blend가 아님).
        expect(result.current.progressM!).toBeCloseTo(gunjaProj.arcM, 0);
        expect(result.current.position?.current.id).toBe(gunja.id);
        jest.useRealTimers();
      });

      it('does not re-seed when implied speed is just over the plausibility limit (falls back to normal blend)', () => {
        jest.useFakeTimers();
        const startTime = 1_000_000_000;
        jest.setSystemTime(startTime);

        const arcForHop = computeRouteArc(directRoute, sagajeong, childrenPark)!;
        const gunjaProj = nearestArcPoint(arcForHop, gunja.lat, gunja.lng);
        // 79초: maxPlausibleM = 35 × 79 = 2,765m < gunja 거리(~2,800.66m) — 임계 직후(거부).
        const staleSec = 79;

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

        jest.setSystemTime(startTime + staleSec * 1000);
        act(() => {
          rerender(
            makeProps({
              userLocation: { lat: gunja.lat, lng: gunja.lng },
              speedMps: 0,
              accuracyMeters: 30,
            }),
          );
        });

        // re-seed skip → 기존 dead-reckoning/blend 경로로 처리되어 proj.arcM에 정확히 snap되지 않는다
        // (predicted=0과 blend되어 gunjaProj.arcM보다 뚜렷이 작다 — implied speed 55m/s 미만이라
        // jump-reject에는 안 걸리고 blend는 진행된다).
        expect(result.current.progressM!).toBeLessThan(gunjaProj.arcM - 10);
        jest.useRealTimers();
      });

      it('does not re-seed for backward multipath projection onto an already-passed station', () => {
        jest.useFakeTimers();
        const startTime = 1_000_000_000;
        jest.setSystemTime(startTime);

        const { result, rerender } = renderHook(
          (p: UseRouteProgressInputs) => useRouteProgress(p),
          {
            initialProps: makeProps({
              userLocation: { lat: childrenPark.lat, lng: childrenPark.lng },
              speedMps: 0,
              accuracyMeters: 30,
            }),
          },
        );
        const baseline = result.current.progressM!;

        // 61초(> ROUTE_PROGRESS_RESEED_STALE_MS) 뒤 accuracy<100m·on-route인 multipath fix가
        // 이미 지나온 sagajeong(원점)에 사영 — 물리적 타당성 가드(35 m/s × 61s ≈ 2,135m)가
        // 실제 거리(~3,871m)를 초과 판정해 re-seed를 skip한다. 표시가 뒤로 튀는 사고 방지.
        jest.setSystemTime(startTime + 61_000);
        act(() => {
          rerender(
            makeProps({
              userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
              speedMps: 0,
              accuracyMeters: 30,
            }),
          );
        });

        // re-seed skip + implied speed(63.5 m/s)도 55 m/s 초과라 jump-reject까지 이중으로 막혀
        // dead-reckoning(predicted, speed 0)만 적용 — progress가 baseline 근처에 머문다.
        expect(Math.abs(result.current.progressM! - baseline)).toBeLessThan(100);
        jest.useRealTimers();
      });
    });

    it('does not re-seed when stale but accuracy fails the quality gate (underground low-quality fix)', () => {
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

      jest.setSystemTime(startTime + 70_000);
      act(() => {
        rerender(
          makeProps({
            userLocation: { lat: childrenPark.lat, lng: childrenPark.lng },
            speedMps: 0,
            // ROUTE_PROGRESS_RESEED_ACCURACY_M(100m) 미달 — 지하 저품질 좌표로는 re-seed 금지.
            accuracyMeters: 150,
          }),
        );
      });

      // reseed 게이트 실패 → implied speed 점프 거부 경로로 빠져 progress 거의 그대로(speed 0).
      expect(Math.abs(result.current.progressM! - baseline)).toBeLessThan(100);
      jest.useRealTimers();
    });

    it('does not re-seed when stale and accurate but off-route (perp > MAX_PERP_M)', () => {
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

      jest.setSystemTime(startTime + 70_000);
      act(() => {
        rerender(
          makeProps({
            // 명백히 off-route(perp > 1.5km) — 정확도가 좋아도 route 위 합의가 없어 re-seed 금지.
            userLocation: { lat: 37.5219, lng: 126.9244 },
            speedMps: 0,
            accuracyMeters: 30,
          }),
        );
      });

      expect(Math.abs(result.current.progressM! - baseline)).toBeLessThan(100);
      jest.useRealTimers();
    });
  });
});
