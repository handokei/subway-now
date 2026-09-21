import { renderHook, act } from '@testing-library/react-native';

const mockIsAvailable = jest.fn();
const mockRequestPermissions = jest.fn();
const mockSetUpdateInterval = jest.fn();
const mockAddListener = jest.fn();
const mockRemove = jest.fn();
const mockSetSubsurfaceState = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-sensors', () => ({
  Barometer: {
    isAvailableAsync: (...args: unknown[]) => mockIsAvailable(...args),
    requestPermissionsAsync: (...args: unknown[]) => mockRequestPermissions(...args),
    setUpdateInterval: (...args: unknown[]) => mockSetUpdateInterval(...args),
    addListener: (...args: unknown[]) => mockAddListener(...args),
  },
}));

jest.mock('../../utils/subsurfaceState', () => ({
  setSubsurfaceState: (...args: unknown[]) => mockSetSubsurfaceState(...args),
}));

import { useBarometer } from '../useBarometer';
import { SIMPLE_ARRIVAL_ARCH_ENV_KEY } from '../../config/archFlag';
import {
  BAROMETER_SAMPLE_INTERVAL_MS,
  BAROMETER_DPDT_WINDOW_MS,
  BAROMETER_MISMATCH_QUORUM_READINGS,
  BAROMETER_STOP_DP_THRESHOLD_HPA,
  BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA,
} from '../../constants/barometer';
import {
  getBarometerInstrumentation,
  getBarometerReadings,
  resetBarometerInstrumentationForTest,
  resetBarometerState,
} from '../../utils/barometerState';

type Listener = (m: { pressure: number; timestamp: number }) => void;

const ORIGINAL_ARCH_ENV = process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];

beforeEach(() => {
  jest.useFakeTimers();
  mockIsAvailable.mockReset();
  mockRequestPermissions.mockReset();
  mockSetUpdateInterval.mockReset();
  mockAddListener.mockReset();
  mockRemove.mockReset();
  mockSetSubsurfaceState.mockReset();
  mockSetSubsurfaceState.mockResolvedValue(undefined);
  mockAddListener.mockReturnValue({ remove: mockRemove });
  resetBarometerState();
  resetBarometerInstrumentationForTest();
  // #2006 — 각 테스트 전 flag 초기화 (기본 OFF).
  delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  if (ORIGINAL_ARCH_ENV === undefined) {
    delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
  } else {
    process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = ORIGINAL_ARCH_ENV;
  }
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * #2619 — evaluate/setState가 1Hz interval(evaluateAndFlush)로 이전됨에 따라, listener 발화
 * 후 다음 flush tick까지 fake timer를 advance해야 result.current가 갱신된다. native 콜백
 * 자체는 uncontrolled rate로 여러 번 발화할 수 있지만(#2619 RCA), 여기서는 매 샘플마다 1회
 * flush를 advance해 기존 "콜백 1회 = 평가 1회" 테스트 의도를 유지한다.
 */
function fireAndFlush(listener: Listener, sample: { pressure: number; timestamp: number }): void {
  act(() => {
    listener(sample);
    jest.advanceTimersByTime(BAROMETER_SAMPLE_INTERVAL_MS);
  });
}

/**
 * 6개의 hysteresis/verdict 테스트가 동일한 boilerplate(권한 mock + baseT + nowSpy + renderHook +
 * listener 획득)를 반복했다 → Sonar cpd. 헬퍼 1곳으로 모아 중복 제거.
 */
async function setupBarometerWithListener(): Promise<{
  result: ReturnType<typeof renderHook<ReturnType<typeof useBarometer>, unknown>>['result'];
  unmount: () => void;
  listener: Listener;
  nowSpy: jest.SpyInstance<number, []>;
  baseT: number;
}> {
  mockIsAvailable.mockResolvedValue(true);
  mockRequestPermissions.mockResolvedValue({ granted: true });
  const baseT = 1_700_000_000_000;
  const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseT);
  const { result, unmount } = renderHook(() => useBarometer());
  await flush();
  const listener = mockAddListener.mock.calls[0][0] as Listener;
  return { result, unmount, listener, nowSpy, baseT };
}

/**
 * confirm 카운터 누적용 listener 반복 fire 패턴 — 6개 테스트가 동일 for-loop 보일러플레이트를
 * 사용해 Sonar cpd. 단일 헬퍼로 모아 중복 제거.
 */
function fireListenerWindow(
  listener: Listener,
  nowSpy: jest.SpyInstance<number, []>,
  baseT: number,
  count: number,
  pressureAt: (i: number) => number,
): void {
  for (let i = 0; i < count; i++) {
    nowSpy.mockReturnValue(baseT + BAROMETER_DPDT_WINDOW_MS + i * 1_000);
    act(() => {
      listener({ pressure: pressureAt(i), timestamp: 30 + i });
      // #2619 — evaluate/setState가 1Hz interval로 이전됨에 따라 flush tick을 함께 advance.
      jest.advanceTimersByTime(BAROMETER_SAMPLE_INTERVAL_MS);
    });
  }
}

describe('useBarometer (#875)', () => {
  // permission / availability 게이트 실패는 모두 동일 결과(listener 미등록)로 수렴 — 입력만 달리해 테이블화.
  it.each<{ label: string; setup: () => void }>([
    {
      label: 'isAvailable=false',
      setup: () => mockIsAvailable.mockResolvedValue(false),
    },
    {
      label: 'isAvailable throw',
      setup: () => mockIsAvailable.mockRejectedValue(new Error('boom')),
    },
    {
      label: '권한 거절',
      setup: () => {
        mockIsAvailable.mockResolvedValue(true);
        mockRequestPermissions.mockResolvedValue({ granted: false });
      },
    },
    {
      label: 'requestPermissions throw',
      setup: () => {
        mockIsAvailable.mockResolvedValue(true);
        mockRequestPermissions.mockRejectedValue(new Error('denied'));
      },
    },
  ])('게이트 실패 ($label) → listener 등록 X', async ({ setup }) => {
    setup();
    renderHook(() => useBarometer());
    await flush();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('정상 케이스 → setUpdateInterval 호출, listener 등록, reading append', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockResolvedValue({ granted: true });

    const { unmount } = renderHook(() => useBarometer());
    await flush();
    expect(mockSetUpdateInterval).toHaveBeenCalledWith(BAROMETER_SAMPLE_INTERVAL_MS);
    expect(mockAddListener).toHaveBeenCalledTimes(1);

    const listener = mockAddListener.mock.calls[0][0] as Listener;
    const epochBefore = Date.now();
    listener({ pressure: 1013.25, timestamp: 12.34 });
    listener({ pressure: 1013.3, timestamp: 13.34 });
    const epochAfter = Date.now();

    const readings = getBarometerReadings();
    expect(readings).toHaveLength(2);
    expect(readings[0].pressureHpa).toBeCloseTo(1013.25);
    expect(readings[1].pressureHpa).toBeCloseTo(1013.3);
    // boot-second(12.34) 대신 epoch wall-clock으로 stamp되는지 검증.
    expect(readings[0].t).toBeGreaterThanOrEqual(epochBefore);
    expect(readings[1].t).toBeLessThanOrEqual(epochAfter);

    unmount();
    expect(mockRemove).toHaveBeenCalled();
    expect(getBarometerReadings()).toEqual([]);
  });

  it('unmount가 init 완료 전에 일어나도 listener 등록 X (cancelled 경로)', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderHook(() => useBarometer());
    unmount();
    await flush();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('unmount가 isAvailable 응답 전에 일어나도 permission 요청 X', async () => {
    mockIsAvailable.mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderHook(() => useBarometer());
    unmount();
    await flush();
    expect(mockRequestPermissions).not.toHaveBeenCalled();
  });

  it('#1398 — unmount가 권한 응답 직후·listener 등록 전에 일어나면 listener 등록 X (cancelled-after-permission)', async () => {
    // safeRequestPermission이 resolve하고 다음 라인에서 `if (cancelled) return;`을 타는 경로.
    // requestPermissions를 deferred로 잡아 두고 unmount(cancelled=true) 후에 resolve해서
    // line 131 guard branch를 커버한다.
    mockIsAvailable.mockResolvedValue(true);
    let resolvePermission: (value: { granted: boolean }) => void = () => {};
    mockRequestPermissions.mockImplementation(
      () =>
        new Promise<{ granted: boolean }>((resolve) => {
          resolvePermission = resolve;
        }),
    );

    const { unmount } = renderHook(() => useBarometer());
    // isAvailable resolve 진행 + requestPermissions가 deferred에서 멈춘 상태로 진입.
    await flush();
    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);

    // 권한 promise가 pending인 동안 unmount → cleanup이 cancelled=true 셋.
    unmount();

    // 이제 권한 promise resolve → init이 깨어나며 `if (cancelled) return;` 한 줄로 종료.
    resolvePermission({ granted: true });
    await flush();

    expect(mockSetUpdateInterval).not.toHaveBeenCalled();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('#903 — 초기 subsurface=false', async () => {
    mockIsAvailable.mockResolvedValue(false);
    const { result } = renderHook(() => useBarometer());
    await flush();
    expect(result.current.subsurface).toBe(false);
  });

  it('#903 — dP/dt가 임계 이상 N회 연속이면 subsurface=true (hysteresis)', async () => {
    const { result, listener, nowSpy, baseT } = await setupBarometerWithListener();

    // t=0 baseline.
    fireAndFlush(listener, { pressure: 1013, timestamp: 0 });
    expect(result.current.subsurface).toBe(false);

    // 30s 경과 + 임계 이상 dP — confirm 3회 누적.
    fireListenerWindow(
      listener,
      nowSpy,
      baseT,
      3,
      () => 1013 + BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA,
    );
    expect(result.current.subsurface).toBe(true);

    nowSpy.mockRestore();
  });

  it('#903 — hysteresis: 임계 근처 1Hz 토글은 setSubsurface 발사 안 함', async () => {
    // 임계 부근 진동 시 카운터는 누적 못 하고 같은 verdict 1회 도착마다 리셋 → state flip 발생 안 함.
    const { result, listener, nowSpy, baseT } = await setupBarometerWithListener();

    fireAndFlush(listener, { pressure: 1013, timestamp: 0 });

    // 임계+, 임계-, 임계+ 진동 — 같은 카운트(true)가 2회 누적되나 사이의 false가 reset.
    fireListenerWindow(listener, nowSpy, baseT, 6, (i) => {
      const overshoot = i % 2 === 0 ? BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA : 0;
      return 1013 + overshoot;
    });
    expect(result.current.subsurface).toBe(false);

    nowSpy.mockRestore();
  });

  it('#921 — 초기 stop=undefined (reading 부족, fusion에 unavailable)', async () => {
    mockIsAvailable.mockResolvedValue(false);
    const { result } = renderHook(() => useBarometer());
    await flush();
    expect(result.current.stop).toBeUndefined();
  });

  it('#921 — 정차 패턴(dP≈0)이 N회 연속이면 stop=true (hysteresis)', async () => {
    const { result, listener, nowSpy, baseT } = await setupBarometerWithListener();

    // t=0 baseline.
    fireAndFlush(listener, { pressure: 1013, timestamp: 0 });
    // 첫 sample은 readings 1개 + baseline 부재 — verdict null → undefined.
    expect(result.current.stop).toBeUndefined();

    // 30s 경과 + dP≈0 — confirm 3회 누적되면 stop=true.
    fireListenerWindow(listener, nowSpy, baseT, 3, () => 1013);
    expect(result.current.stop).toBe(true);

    nowSpy.mockRestore();
  });

  it('#921 — |dP|가 stop 임계 초과(이동 중)면 stop=false (hysteresis 후)', async () => {
    const { result, listener, nowSpy, baseT } = await setupBarometerWithListener();

    fireAndFlush(listener, { pressure: 1013, timestamp: 0 });
    // 정차 → 이동 전환: dP=0.1 hPa(임계 0.05 초과) 3회 연속.
    fireListenerWindow(
      listener,
      nowSpy,
      baseT,
      3,
      () => 1013 + BAROMETER_STOP_DP_THRESHOLD_HPA + 0.05,
    );
    expect(result.current.stop).toBe(false);

    nowSpy.mockRestore();
  });

  it('#921 — stop verdict가 가짜→진짜→불가(null)로 흐르면 undefined로 즉시 리셋', async () => {
    const { result, listener, nowSpy, baseT } = await setupBarometerWithListener();

    // 정차 신호 확립.
    fireAndFlush(listener, { pressure: 1013, timestamp: 0 });
    fireListenerWindow(listener, nowSpy, baseT, 3, () => 1013);
    expect(result.current.stop).toBe(true);

    // resetBarometerState로 readings를 비워 verdict null 유도 — 첫 새 reading은 baseline 부재.
    resetBarometerState();
    nowSpy.mockReturnValue(baseT + BAROMETER_DPDT_WINDOW_MS * 3);
    fireAndFlush(listener, { pressure: 1013.5, timestamp: 100 });
    expect(result.current.stop).toBeUndefined();

    nowSpy.mockRestore();
  });

  it('#921 — stop hysteresis: 카운터 미달은 state 미반영 + 동일 verdict 도착 시 카운터 리셋', async () => {
    const { result, listener, nowSpy, baseT } = await setupBarometerWithListener();

    // baseline.
    fireAndFlush(listener, { pressure: 1013, timestamp: 0 });
    // stop=true 2번만 — confirm 3 미달.
    fireListenerWindow(listener, nowSpy, baseT, 2, () => 1013);
    expect(result.current.stop).toBeUndefined();

    nowSpy.mockRestore();
  });

  it('#1279 — subsurface flip 시 setSubsurfaceState 호출', async () => {
    const { listener, nowSpy, baseT } = await setupBarometerWithListener();

    fireAndFlush(listener, { pressure: 1013, timestamp: 0 });
    // hysteresis 3회 미달 — setSubsurfaceState 미호출.
    expect(mockSetSubsurfaceState).not.toHaveBeenCalled();

    // confirm 3회 → subsurface=true flip → setSubsurfaceState(true) 호출.
    fireListenerWindow(
      listener,
      nowSpy,
      baseT,
      3,
      () => 1013 + BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA,
    );
    expect(mockSetSubsurfaceState).toHaveBeenCalledWith(true);

    nowSpy.mockRestore();
  });

  it('#903 — unmount 시 subscription remove + ring buffer reset', async () => {
    const { result, unmount, listener, nowSpy, baseT } = await setupBarometerWithListener();
    fireAndFlush(listener, { pressure: 1013, timestamp: 0 });
    fireListenerWindow(
      listener,
      nowSpy,
      baseT,
      3,
      () => 1013 + BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA,
    );
    expect(result.current.subsurface).toBe(true);

    unmount();
    expect(mockRemove).toHaveBeenCalled();
    expect(getBarometerReadings()).toEqual([]);
    nowSpy.mockRestore();
  });

  it('#2619 review (F2) — listener 등록 직후 첫 flush tick에 reading이 아직 0건이면 skip(빈 버퍼)', async () => {
    const { result, nowSpy } = await setupBarometerWithListener();
    // listener를 한 번도 호출하지 않은 채 flush interval만 advance — ring buffer가 비어 있어
    // latestTs=null인 분기(readings.length===0)를 그대로 skip해야 한다(크래시/오염 없음).
    act(() => {
      jest.advanceTimersByTime(BAROMETER_SAMPLE_INTERVAL_MS);
    });
    expect(result.current.subsurface).toBe(false);
    expect(result.current.stop).toBeUndefined();
    expect(result.current.readingCount).toBe(0);
    nowSpy.mockRestore();
  });

  it('#2619 review (F2) — native listener stall(마지막 flush 이후 신규 reading 0) 시 subsurface 유지', async () => {
    // 배경(#1950 게이트 오염): 지하 한복판에서 listener가 stall돼도 1Hz flush interval은 계속
    // 돌면서 evaluateLatestSubsurface(now)를 호출 — ring buffer에 최근 window 안 reading이
    // 없으면 null verdict → subDetected=false로 즉시 붕괴하고, hysteresis confirm
    // 3회(≈3s, 1Hz)만에 subsurface가 false로 떨어지는 회귀가 있었다. fix: 마지막 flush 이후
    // 신규 reading이 없으면 평가 자체를 skip해 상태를 hold한다.
    const { result, listener, nowSpy, baseT } = await setupBarometerWithListener();

    // subsurface=true 확정.
    fireAndFlush(listener, { pressure: 1013, timestamp: 0 });
    fireListenerWindow(
      listener,
      nowSpy,
      baseT,
      3,
      () => 1013 + BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA,
    );
    expect(result.current.subsurface).toBe(true);

    // native listener stall — 이후 여러 flush tick 동안 listener() 미호출(신규 reading 0).
    // hysteresis confirm 3회(BAROMETER_SUBSURFACE_CONFIRM_SAMPLES)를 넘는 5tick을 advance해도
    // 평가 자체가 skip되므로 subsurface는 false로 붕괴하지 않아야 한다.
    act(() => {
      jest.advanceTimersByTime(BAROMETER_SAMPLE_INTERVAL_MS * 5);
    });
    expect(result.current.subsurface).toBe(true);

    nowSpy.mockRestore();
  });

  // #2619 review (F3)는 원래 이 steady 구간에서 렌더 0을 요구했다. #2699(PR #2789 리뷰
  // 2라운드)가 `lastEvaluatedAt` liveness heartbeat(매 신규 reading 처리마다 setState, verdict/
  // quorum 변화와 무관)를 추가하면서 이 불변식이 의도적으로 바뀌었다 — subsurface
  // flap-quarantine이 "raw 값 자체가 안 바뀌는" 구간에서도 quarantine 만료를 재평가할 신호가
  // 필요했고(`useApnsTripRegistration.ts` 참고), barometer가 살아있는 동안만 전진하는 이
  // heartbeat가 그 신호다. 대가는 steady 상태에서도 1Hz(신규 reading 처리 주기) 렌더가
  // 발생한다는 것 — F3가 막으려던 14~21Hz 네이티브 콜백 폭주에 비하면 여전히 14~21배 개선.
  it('#2699 이후 steady 상태에서도 신규 reading마다 1Hz 렌더(liveness heartbeat) — F3 0-렌더 불변식은 의도적으로 대체됨', async () => {
    let renderCount = 0;
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockResolvedValue({ granted: true });
    const baseT = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseT);
    const { result } = renderHook(() => {
      renderCount += 1;
      return useBarometer();
    });
    await flush();
    const listener = mockAddListener.mock.calls[0][0] as Listener;

    // steady 정차 상태 확립(stop=true, confirm 3회) — 이후 idle 구간의 baseline.
    fireAndFlush(listener, { pressure: 1013, timestamp: 0 });
    fireListenerWindow(listener, nowSpy, baseT, 3, () => 1013);
    expect(result.current.stop).toBe(true);

    // steady state 진입 이후부터만 렌더 카운트(mount/permission/hysteresis 확립 렌더는 제외).
    renderCount = 0;

    // 이후 10 tick 동안 listener는 계속 발화(stall 아님 — 신규 reading은 매 tick 들어옴)하지만
    // dP≈0(verdict 불변) + readingCount는 quorum(30) 미만에 머물러 경계 변화도 없다. verdict/
    // quorum 자체는 안 바뀌지만, 매 tick 신규 reading을 처리하므로 liveness heartbeat
    // (lastEvaluatedAt)가 매번 갱신돼 10회 렌더가 발생한다.
    for (let i = 0; i < 10; i++) {
      nowSpy.mockReturnValue(baseT + BAROMETER_DPDT_WINDOW_MS + (3 + i) * 1_000);
      act(() => {
        listener({ pressure: 1013, timestamp: 30 + 3 + i });
        jest.advanceTimersByTime(BAROMETER_SAMPLE_INTERVAL_MS);
      });
    }

    expect(renderCount).toBe(10);
    expect(result.current.lastEvaluatedAt).toBe(baseT + BAROMETER_DPDT_WINDOW_MS + 12_000);
    nowSpy.mockRestore();
  });

  describe('#1398 — unavailable 원인 분해 + reading count 노출', () => {
    it('isAvailable=false → unavailableReason="sensor"', async () => {
      mockIsAvailable.mockResolvedValue(false);
      const { result } = renderHook(() => useBarometer());
      await flush();
      expect(result.current.unavailableReason).toBe('sensor');
      expect(result.current.readingCount).toBe(0);
    });

    it('권한 거절 → unavailableReason="permission"', async () => {
      mockIsAvailable.mockResolvedValue(true);
      mockRequestPermissions.mockResolvedValue({ granted: false });
      const { result } = renderHook(() => useBarometer());
      await flush();
      expect(result.current.unavailableReason).toBe('permission');
    });

    it('게이트 통과 + reading 0건 → unavailableReason="readings" (warm-up 초기)', async () => {
      mockIsAvailable.mockResolvedValue(true);
      mockRequestPermissions.mockResolvedValue({ granted: true });
      const { result } = renderHook(() => useBarometer());
      await flush();
      // listener 등록까지 진행됐지만 sample 미도착 → readings 단계.
      expect(result.current.unavailableReason).toBe('readings');
      expect(result.current.readingCount).toBe(0);
    });

    it('stop이 boolean 결정 → unavailableReason=undefined (정상) + readingCount는 quorum 경계 미만이면 0(F3)', async () => {
      const { result, listener, nowSpy, baseT } = await setupBarometerWithListener();
      // baseline + 30s 후 dP≈0 정상 stop 신호. 총 4 reading(quorum 30 미만)이라 #2619 review
      // (F3)에 따라 readingCount state는 아직 quorum 경계를 넘지 않아 초기값 0을 유지한다.
      fireAndFlush(listener, { pressure: 1013, timestamp: 0 });
      fireListenerWindow(listener, nowSpy, baseT, 3, () => 1013);
      expect(result.current.stop).toBe(true);
      expect(result.current.unavailableReason).toBeUndefined();
      expect(result.current.readingCount).toBe(0);
      nowSpy.mockRestore();
    });

    it('#2619 review (F3) — readingCount는 quorum(BAROMETER_MISMATCH_QUORUM_READINGS) 경계를 넘는 tick에만 갱신', async () => {
      const { result, listener, nowSpy, baseT } = await setupBarometerWithListener();
      fireAndFlush(listener, { pressure: 1013, timestamp: 0 });
      // BAROMETER_MISMATCH_QUORUM_READINGS(30)를 넘는 30 reading을 추가 — dP≈0 유지해
      // stop/subsurface hysteresis는 건드리지 않고 순수하게 quorum crossing만 검증.
      fireListenerWindow(listener, nowSpy, baseT, 30, () => 1013);
      expect(result.current.readingCount).toBeGreaterThanOrEqual(BAROMETER_MISMATCH_QUORUM_READINGS);
      nowSpy.mockRestore();
    });

    it('stop이 boolean 결정된 후 reading buffer reset → unavailableReason="readings"로 회귀', async () => {
      const { result, listener, nowSpy, baseT } = await setupBarometerWithListener();
      fireAndFlush(listener, { pressure: 1013, timestamp: 0 });
      fireListenerWindow(listener, nowSpy, baseT, 3, () => 1013);
      expect(result.current.stop).toBe(true);
      expect(result.current.unavailableReason).toBeUndefined();

      // ring buffer reset → 새 tick은 baseline 부재 → verdict null → readings.
      resetBarometerState();
      nowSpy.mockReturnValue(baseT + BAROMETER_DPDT_WINDOW_MS * 3);
      fireAndFlush(listener, { pressure: 1013.5, timestamp: 100 });
      expect(result.current.stop).toBeUndefined();
      expect(result.current.unavailableReason).toBe('readings');
      nowSpy.mockRestore();
    });

    it('unavailable 유지 (같은 undefined verdict 반복) → reason="readings" 그대로 유지', async () => {
      const { result, listener, nowSpy, baseT } = await setupBarometerWithListener();
      // baseline 1건 — 30s 윈도우 부족 → verdict null 유지.
      fireAndFlush(listener, { pressure: 1013, timestamp: 0 });
      // 그 후 1초 후 한 번 더 — 여전히 baseline 부재(첫 reading=30s 이전 아님) → verdict null.
      nowSpy.mockReturnValue(baseT + 1_000);
      fireAndFlush(listener, { pressure: 1013, timestamp: 1 });
      expect(result.current.stop).toBeUndefined();
      expect(result.current.unavailableReason).toBe('readings');
      nowSpy.mockRestore();
    });
  });

  // #2006 (ADR-022 Phase 4-4) — arrival-api-ssot-v1 flag ON 시 dormant. arrival API 가 지하도
  // 커버하므로 기압계 SPOF 신호를 배터리 절약을 위해 listener 등록 자체를 skip.
  describe('flag guard (#2006)', () => {
    it('flag ON — Barometer.isAvailableAsync 호출 0 (native gate skip)', async () => {
      process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
      // isAvailable 은 pending 상태로 유지 — 실제로 native 호출이 있었다면 등록될 것.
      mockIsAvailable.mockImplementation(() => new Promise(() => {}));

      const { result } = renderHook(() => useBarometer());
      await flush();

      expect(mockIsAvailable).not.toHaveBeenCalled();
      expect(mockRequestPermissions).not.toHaveBeenCalled();
      expect(mockSetUpdateInterval).not.toHaveBeenCalled();
      expect(mockAddListener).not.toHaveBeenCalled();
      // dormant 반환값 계약.
      expect(result.current.subsurface).toBe(false);
      expect(result.current.stop).toBeUndefined();
      expect(result.current.readingCount).toBe(0);
      expect(result.current.unavailableReason).toBe('flag-on-dormant');
    });

    it('flag ON — unmount 시에도 크래시 없이 종료 (subscription null)', async () => {
      process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
      const { unmount } = renderHook(() => useBarometer());
      await flush();
      // native subscription 미등록 → remove 호출 없어야 함.
      unmount();
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it('flag OFF 명시 — 기존 sensor 게이트 진입 (backward-compat)', async () => {
      process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'false';
      mockIsAvailable.mockResolvedValue(true);
      mockRequestPermissions.mockResolvedValue({ granted: true });

      const { result } = renderHook(() => useBarometer());
      await flush();

      expect(mockIsAvailable).toHaveBeenCalled();
      expect(mockAddListener).toHaveBeenCalledTimes(1);
      // 정상 등록 후 첫 tick 전 warmup: reason 'readings'.
      expect(result.current.unavailableReason).toBe('readings');
    });
  });

  describe('#2626 — native listener 계측 wire-up', () => {
    it('addListener 성공 → listenerRegisteredCount 증가, 콜백마다 totalCallbackCount/firstCallbackAtMs 갱신', async () => {
      const { listener, nowSpy, baseT } = await setupBarometerWithListener();
      expect(getBarometerInstrumentation().listenerRegisteredCount).toBe(1);
      expect(getBarometerInstrumentation().listenerRegistrationFailedCount).toBe(0);
      expect(getBarometerInstrumentation().firstCallbackAtMs).toBeNull();
      expect(getBarometerInstrumentation().totalCallbackCount).toBe(0);

      fireAndFlush(listener, { pressure: 1013, timestamp: 0 });
      const inst = getBarometerInstrumentation();
      expect(inst.totalCallbackCount).toBe(1);
      expect(inst.firstCallbackAtMs).toBe(baseT);

      nowSpy.mockRestore();
    });

    it('#2626 review — addListener 호출이 예외를 던지면 listenerRegistrationFailedCount 증가 + 예외 메시지 보존 + reason="listener-failed" + flush interval(setInterval) 미시작', async () => {
      mockIsAvailable.mockResolvedValue(true);
      mockRequestPermissions.mockResolvedValue({ granted: true });
      mockAddListener.mockImplementation(() => {
        throw new Error('native registration failed');
      });
      // #2626 review — "flush interval 미시작" 주장을 실제로 assert하기 위해 setInterval 자체를
      // spy. 이전 버전은 카운터 2개만 확인해 회귀(예: catch 안에서도 setInterval이 호출되는
      // 버그)를 잡지 못했다.
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      const { result } = renderHook(() => useBarometer());
      await flush();

      expect(getBarometerInstrumentation().listenerRegisteredCount).toBe(0);
      expect(getBarometerInstrumentation().listenerRegistrationFailedCount).toBe(1);
      // #2626 review — 예외 메시지가 계측에 보존되는지(권한 vs expo-sensors 문제 판별 단서).
      expect(getBarometerInstrumentation().lastRegistrationError).toBe('native registration failed');
      // #2626 review — 게이트 통과 상태('readings')로 남아 9/15 회귀와 dump가 동일해지면 안 됨.
      expect(result.current.unavailableReason).toBe('listener-failed');
      expect(setIntervalSpy).not.toHaveBeenCalled();

      setIntervalSpy.mockRestore();
    });

    it('게이트 실패(isAvailable=false) → addListener 자체가 호출되지 않으므로 등록/실패 카운트 모두 0', async () => {
      mockIsAvailable.mockResolvedValue(false);
      renderHook(() => useBarometer());
      await flush();
      expect(getBarometerInstrumentation().listenerRegisteredCount).toBe(0);
      expect(getBarometerInstrumentation().listenerRegistrationFailedCount).toBe(0);
    });

    it('이중 mount — 두 훅 인스턴스가 각각 등록되고, 각 unmount마다 resetCount가 누적', async () => {
      mockIsAvailable.mockResolvedValue(true);
      mockRequestPermissions.mockResolvedValue({ granted: true });

      const first = renderHook(() => useBarometer());
      await flush();
      const second = renderHook(() => useBarometer());
      await flush();

      expect(getBarometerInstrumentation().listenerRegisteredCount).toBe(2);

      first.unmount();
      expect(getBarometerInstrumentation().resetCount).toBe(1);
      second.unmount();
      expect(getBarometerInstrumentation().resetCount).toBe(2);
    });
  });
});
