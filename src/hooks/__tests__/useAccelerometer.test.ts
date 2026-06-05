import { renderHook, act } from '@testing-library/react-native';

const mockIsAvailable = jest.fn();
const mockRequestPermissions = jest.fn();
const mockSetUpdateInterval = jest.fn();
const mockAddListener = jest.fn();
const mockRemove = jest.fn();

jest.mock('expo-sensors', () => ({
  Accelerometer: {
    isAvailableAsync: (...args: unknown[]) => mockIsAvailable(...args),
    requestPermissionsAsync: (...args: unknown[]) => mockRequestPermissions(...args),
    setUpdateInterval: (...args: unknown[]) => mockSetUpdateInterval(...args),
    addListener: (...args: unknown[]) => mockAddListener(...args),
  },
}));

import { useAccelerometer, SAMPLE_INTERVAL_MS, WINDOW_FLUSH_MS } from '../useAccelerometer';
import { getLatestAccelSummary, setLatestAccelSummary } from '../../features/nearest-station/utils/accelMotionState';

type Listener = (m: { x: number; y: number; z: number; timestamp: number }) => void;

beforeEach(() => {
  mockIsAvailable.mockReset();
  mockRequestPermissions.mockReset();
  mockSetUpdateInterval.mockReset();
  mockAddListener.mockReset();
  mockRemove.mockReset();
  mockAddListener.mockReturnValue({ remove: mockRemove });
  setLatestAccelSummary(null);
});

async function flush(): Promise<void> {
  // microtask queue를 비워 async useEffect init이 끝나도록 함.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useAccelerometer (#823 Phase 3 E1)', () => {
  it('isAvailable=false → permission 요청도 하지 않고 listener 등록 X', async () => {
    mockIsAvailable.mockResolvedValue(false);
    renderHook(() => useAccelerometer());
    await flush();
    expect(mockRequestPermissions).not.toHaveBeenCalled();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('isAvailable throw → graceful, no-op', async () => {
    mockIsAvailable.mockRejectedValue(new Error('boom'));
    renderHook(() => useAccelerometer());
    await flush();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('권한 거절 → listener 등록 X', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockResolvedValue({ granted: false });
    renderHook(() => useAccelerometer());
    await flush();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('requestPermissions throw → graceful, no-op', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockRejectedValue(new Error('denied'));
    renderHook(() => useAccelerometer());
    await flush();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('정상 케이스 → SAMPLE_INTERVAL_MS 설정, listener 등록, flush마다 summary 노출', async () => {
    jest.useFakeTimers();
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockResolvedValue({ granted: true });

    const { unmount } = renderHook(() => useAccelerometer());
    await flush();
    expect(mockSetUpdateInterval).toHaveBeenCalledWith(SAMPLE_INTERVAL_MS);
    expect(mockAddListener).toHaveBeenCalledTimes(1);

    // listener에 60개 sample push — 정지 상태 시뮬레이션 ((0,0,1g))
    // expo-sensors timestamp(boot 이후 초)는 의도적으로 무시되고 Date.now()로 stamp되는지 확인.
    const epochBefore = Date.now();
    const listener = mockAddListener.mock.calls[0][0] as Listener;
    for (let i = 0; i < 60; i++) {
      listener({ x: 0, y: 0, z: 1, timestamp: i * 0.01 });
    }
    const epochAfter = Date.now();
    // flush interval만큼 advance
    act(() => {
      jest.advanceTimersByTime(WINDOW_FLUSH_MS);
    });
    const s = getLatestAccelSummary();
    expect(s).not.toBeNull();
    expect(s!.count).toBe(60);
    // wall-clock stamp — boot timestamp(0.01s 류)가 아닌 epoch ms 범위에 있어야 함.
    expect(s!.startTs).toBeGreaterThanOrEqual(epochBefore);
    expect(s!.endTs).toBeLessThanOrEqual(epochAfter);
    // 중력 제거 후 magnitude≈0
    expect(s!.magnitudeMean).toBeCloseTo(0);

    unmount();
    expect(mockRemove).toHaveBeenCalled();
    expect(getLatestAccelSummary()).toBeNull();
    jest.useRealTimers();
  });

  it('flush 시점 buffer가 비어있으면 summary 업데이트 X (latest 유지)', async () => {
    jest.useFakeTimers();
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockResolvedValue({ granted: true });

    renderHook(() => useAccelerometer());
    await flush();
    // 빈 윈도우 → flush 호출돼도 setLatestAccelSummary 호출되지 않아야 함.
    act(() => {
      jest.advanceTimersByTime(WINDOW_FLUSH_MS);
    });
    expect(getLatestAccelSummary()).toBeNull();
    jest.useRealTimers();
  });

  it('샘플 수가 MIN 미만이면 summary null로 폐기 (latest 그대로)', async () => {
    jest.useFakeTimers();
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockResolvedValue({ granted: true });

    renderHook(() => useAccelerometer());
    await flush();
    const listener = mockAddListener.mock.calls[0][0] as Listener;
    // 10개만 push → MIN_SAMPLES_FOR_SUMMARY 미달
    for (let i = 0; i < 10; i++) {
      listener({ x: 0, y: 0, z: 1, timestamp: i * 0.01 });
    }
    act(() => {
      jest.advanceTimersByTime(WINDOW_FLUSH_MS);
    });
    expect(getLatestAccelSummary()).toBeNull();
    jest.useRealTimers();
  });

  it('unmount가 init 완료 전에 일어나도 listener 등록 X (cancelled 경로)', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockImplementation(() => new Promise(() => {})); // never resolve
    const { unmount } = renderHook(() => useAccelerometer());
    unmount();
    await flush();
    expect(mockAddListener).not.toHaveBeenCalled();
  });
});
