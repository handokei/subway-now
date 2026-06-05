import { renderHook, act } from '@testing-library/react-native';

const mockIsAvailable = jest.fn();
const mockRequestPermissions = jest.fn();
const mockSetUpdateInterval = jest.fn();
const mockAddListener = jest.fn();
const mockRemove = jest.fn();

jest.mock('expo-sensors', () => ({
  Barometer: {
    isAvailableAsync: (...args: unknown[]) => mockIsAvailable(...args),
    requestPermissionsAsync: (...args: unknown[]) => mockRequestPermissions(...args),
    setUpdateInterval: (...args: unknown[]) => mockSetUpdateInterval(...args),
    addListener: (...args: unknown[]) => mockAddListener(...args),
  },
}));

import { useBarometer } from '../useBarometer';
import {
  BAROMETER_SAMPLE_INTERVAL_MS,
  BAROMETER_DPDT_WINDOW_MS,
  BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA,
} from '../../constants/barometer';
import {
  getBarometerReadings,
  resetBarometerState,
} from '../../utils/barometerState';

type Listener = (m: { pressure: number; timestamp: number }) => void;

beforeEach(() => {
  mockIsAvailable.mockReset();
  mockRequestPermissions.mockReset();
  mockSetUpdateInterval.mockReset();
  mockAddListener.mockReset();
  mockRemove.mockReset();
  mockAddListener.mockReturnValue({ remove: mockRemove });
  resetBarometerState();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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

  it('#903 — 초기 subsurface=false', async () => {
    mockIsAvailable.mockResolvedValue(false);
    const { result } = renderHook(() => useBarometer());
    await flush();
    expect(result.current.subsurface).toBe(false);
  });

  it('#903 — dP/dt가 임계 이상 N회 연속이면 subsurface=true (hysteresis)', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockResolvedValue({ granted: true });

    // listener가 호출하는 Date.now()를 제어하기 위해 spyOn.
    const baseT = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseT);

    const { result } = renderHook(() => useBarometer());
    await flush();
    const listener = mockAddListener.mock.calls[0][0] as Listener;

    // t=0 baseline.
    act(() => {
      listener({ pressure: 1013.0, timestamp: 0 });
    });
    expect(result.current.subsurface).toBe(false);

    // 30s 경과 + 임계 이상 dP — confirm 3회 누적.
    for (let i = 0; i < 3; i++) {
      nowSpy.mockReturnValue(baseT + BAROMETER_DPDT_WINDOW_MS + i * 1_000);
      act(() => {
        listener({
          pressure: 1013.0 + BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA,
          timestamp: 30 + i,
        });
      });
    }
    expect(result.current.subsurface).toBe(true);

    nowSpy.mockRestore();
  });

  it('#903 — hysteresis: 임계 근처 1Hz 토글은 setSubsurface 발사 안 함', async () => {
    // 임계 부근 진동 시 카운터는 누적 못 하고 같은 verdict 1회 도착마다 리셋 → state flip 발생 안 함.
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockResolvedValue({ granted: true });
    const baseT = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseT);

    const { result } = renderHook(() => useBarometer());
    await flush();
    const listener = mockAddListener.mock.calls[0][0] as Listener;

    act(() => {
      listener({ pressure: 1013.0, timestamp: 0 });
    });

    // 임계+, 임계-, 임계+ 진동 — 같은 카운트(true)가 2회 누적되나 사이의 false가 reset.
    for (let i = 0; i < 6; i++) {
      nowSpy.mockReturnValue(baseT + BAROMETER_DPDT_WINDOW_MS + i * 1_000);
      const overshoot = i % 2 === 0 ? BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA : 0;
      act(() => {
        listener({ pressure: 1013.0 + overshoot, timestamp: 30 + i });
      });
    }
    expect(result.current.subsurface).toBe(false);

    nowSpy.mockRestore();
  });

  it('#903 — unmount 시 subscription remove + ring buffer reset', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockResolvedValue({ granted: true });
    const baseT = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseT);

    const { result, unmount } = renderHook(() => useBarometer());
    await flush();
    const listener = mockAddListener.mock.calls[0][0] as Listener;
    act(() => {
      listener({ pressure: 1013.0, timestamp: 0 });
    });
    for (let i = 0; i < 3; i++) {
      nowSpy.mockReturnValue(baseT + BAROMETER_DPDT_WINDOW_MS + i * 1_000);
      act(() => {
        listener({
          pressure: 1013.0 + BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA,
          timestamp: 30 + i,
        });
      });
    }
    expect(result.current.subsurface).toBe(true);

    unmount();
    expect(mockRemove).toHaveBeenCalled();
    expect(getBarometerReadings()).toEqual([]);
    nowSpy.mockRestore();
  });
});
