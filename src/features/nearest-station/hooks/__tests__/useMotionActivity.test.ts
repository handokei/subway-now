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

jest.mock('../../utils/motionActivity', () => ({
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

  it('미지원 디바이스 — stationary false로 확정, start/stop 호출 안 함', async () => {
    mockSupported.mockReturnValue(false);
    const { result, unmount } = renderHook(() => useMotionActivity());
    // #1013: 초기값 undefined → init()에서 미지원 감지 후 false로 확정. waitFor로 상태 정착 대기.
    await waitFor(() => expect(result.current).toBe(false));
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    unmount();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('권한 거절 — stationary false로 확정, startUpdates 호출 안 함', async () => {
    mockSupported.mockReturnValue(true);
    mockRequest.mockResolvedValue(false);
    const { result, unmount } = renderHook(() => useMotionActivity());
    // #1013: 초기값 undefined → 권한 거절 후 false로 확정. waitFor로 상태 정착 대기.
    await waitFor(() => expect(result.current).toBe(false));
    expect(mockRequest).toHaveBeenCalled();
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

  // #1013 — warmup window 보호: mount 직후 async init 완료 전 undefined 반환.
  it('mount 직후 초기값 undefined (warmup 상태)', () => {
    mockSupported.mockReturnValue(true);
    // requestPermission을 resolve하지 않으면 async init이 pending 상태 유지.
    mockRequest.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useMotionActivity());
    expect(result.current).toBeUndefined();
  });

  it('권한 요청 중 unmount — cancelled=true로 init 조기 종료', async () => {
    // await requestPermission 중 unmount → cancelled=true → setStationary/startUpdates 미호출.
    let resolveRequest!: (v: boolean) => void;
    mockSupported.mockReturnValue(true);
    mockRequest.mockReturnValue(new Promise<boolean>((res) => { resolveRequest = res; }));

    const { result, unmount } = renderHook(() => useMotionActivity());
    // init이 await requestPermission에서 멈춰 있는 동안 undefined 상태.
    expect(result.current).toBeUndefined();
    // unmount → cancelled=true.
    unmount();
    // requestPermission resolve 후 cancelled=true → 즉시 return (startUpdates 미호출).
    act(() => { resolveRequest(true); });
    expect(mockStart).not.toHaveBeenCalled();
  });
});
