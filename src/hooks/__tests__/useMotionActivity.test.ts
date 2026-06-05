/**
 * #728 — useMotionActivity 훅 테스트.
 *
 * 동작:
 *   1. mount 시 isMotionActivitySupported가 true면 requestPermission → startUpdates
 *   2. 권한 부여되면 폴링 (POLL_INTERVAL_MS)으로 getCurrentMotionStationary 결과 상태 동기화
 *   3. 미지원/거절 시 stationary는 항상 false (suppress 안 함)
 *   4. unmount 시 stopUpdates
 */

const mockSupported = jest.fn();
const mockRequest = jest.fn();
const mockStart = jest.fn();
const mockStop = jest.fn();
const mockGet = jest.fn();

jest.mock('../../features/nearest-station/utils/motionActivity', () => ({
  isMotionActivitySupported: () => mockSupported(),
  requestMotionActivityPermission: () => mockRequest(),
  startMotionActivityUpdates: () => mockStart(),
  stopMotionActivityUpdates: () => mockStop(),
  getCurrentMotionStationary: () => mockGet(),
}));

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useMotionActivity } from '../useMotionActivity';

describe('useMotionActivity (#728)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSupported.mockReset();
    mockRequest.mockReset();
    mockStart.mockReset();
    mockStop.mockReset();
    mockGet.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('미지원 디바이스 — stationary 항상 false, start/stop 호출 안 함', async () => {
    mockSupported.mockReturnValue(false);
    const { result, unmount } = renderHook(() => useMotionActivity());
    await waitFor(() => expect(mockSupported).toHaveBeenCalled());
    expect(result.current).toBe(false);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    unmount();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('권한 거절 — stationary false, startUpdates 호출 안 함', async () => {
    mockSupported.mockReturnValue(true);
    mockRequest.mockResolvedValue(false);
    const { result, unmount } = renderHook(() => useMotionActivity());
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    expect(result.current).toBe(false);
    expect(mockStart).not.toHaveBeenCalled();
    unmount();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('지원 + 권한 부여 — startUpdates 호출, 폴링으로 상태 sync', async () => {
    mockSupported.mockReturnValue(true);
    mockRequest.mockResolvedValue(true);
    mockGet.mockReturnValue(false);

    const { result, unmount } = renderHook(() => useMotionActivity());
    await waitFor(() => expect(mockStart).toHaveBeenCalled());
    expect(result.current).toBe(false);

    // 폴링 한 번 — 여전히 false
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(false);

    // native가 stationary=true 신호 — 다음 폴링에서 반영
    mockGet.mockReturnValue(true);
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    await waitFor(() => expect(result.current).toBe(true));

    // 다시 false
    mockGet.mockReturnValue(false);
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    await waitFor(() => expect(result.current).toBe(false));

    unmount();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('mount 직후 즉시 한 번 평가 — getCurrentMotionStationary가 true면 초기값 true', async () => {
    mockSupported.mockReturnValue(true);
    mockRequest.mockResolvedValue(true);
    mockGet.mockReturnValue(true);

    const { result } = renderHook(() => useMotionActivity());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('unmount 시 stopUpdates 호출 (cleanup)', async () => {
    mockSupported.mockReturnValue(true);
    mockRequest.mockResolvedValue(true);
    mockGet.mockReturnValue(false);

    const { unmount } = renderHook(() => useMotionActivity());
    await waitFor(() => expect(mockStart).toHaveBeenCalled());
    unmount();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });
});
