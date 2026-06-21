/**
 * #1542 (ADR-016 S9) — useAccelerometerFingerprint 훅 테스트.
 *
 * 동작:
 *   1. mount 시 isAccelerometerFingerprintSupported가 true면 startAccelerometerFingerprint
 *   2. 5s 폴링으로 getLatestAccelerometerSnapshot → classifyAccelerometerPattern 결과 sync
 *   3. 미지원 시 pattern='unknown'으로 확정 (start/stop 호출 안 함)
 *   4. unmount 시 stopAccelerometerFingerprint
 */

const mockSupported = jest.fn();
const mockStart = jest.fn();
const mockStop = jest.fn();
const mockGetSnapshot = jest.fn();

jest.mock('../../utils/accelerometerFingerprint', () => {
  const actual = jest.requireActual('../../utils/accelerometerFingerprint');
  return {
    ...actual,
    isAccelerometerFingerprintSupported: () => mockSupported(),
    startAccelerometerFingerprint: () => mockStart(),
    stopAccelerometerFingerprint: () => mockStop(),
    getLatestAccelerometerSnapshot: () => mockGetSnapshot(),
  };
});

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useAccelerometerFingerprint } from '../useAccelerometerFingerprint';
import type { AccelerometerSnapshot } from '../../utils/accelerometerFingerprint';

function makeSnapshot(
  patternClass: AccelerometerSnapshot['patternClass'],
  rmsMagnitude: number = 0.5,
): AccelerometerSnapshot {
  return {
    timestamp: 1_700_000_000_000,
    rmsMagnitude,
    patternClass,
    sampleCount: 200,
  };
}

describe('useAccelerometerFingerprint (#1542)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSupported.mockReset();
    mockStart.mockReset();
    mockStop.mockReset();
    mockGetSnapshot.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('미지원 디바이스 — pattern unknown으로 확정, start/stop 호출 안 함', () => {
    mockSupported.mockReturnValue(false);
    const { result, unmount } = renderHook(() => useAccelerometerFingerprint());
    expect(result.current).toBe('unknown');
    expect(mockStart).not.toHaveBeenCalled();
    unmount();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('지원 — automotive snapshot 시 automotive pattern', async () => {
    mockSupported.mockReturnValue(true);
    mockGetSnapshot.mockReturnValue(makeSnapshot('automotive', 3.5));

    const { result } = renderHook(() => useAccelerometerFingerprint());
    await waitFor(() => expect(result.current).toBe('automotive'));
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('지원 — stationary → automotive 전환 시 다음 폴링에서 채택', async () => {
    mockSupported.mockReturnValue(true);
    mockGetSnapshot.mockReturnValue(makeSnapshot('stationary', 0.1));

    const { result } = renderHook(() => useAccelerometerFingerprint());
    await waitFor(() => expect(result.current).toBe('stationary'));

    // train 출발 — 진동 RMS 상승
    mockGetSnapshot.mockReturnValue(makeSnapshot('automotive', 3.0));
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    await waitFor(() => expect(result.current).toBe('automotive'));
  });

  it('지원 — native null 반환 시 unknown', async () => {
    mockSupported.mockReturnValue(true);
    mockGetSnapshot.mockReturnValue(null);

    const { result } = renderHook(() => useAccelerometerFingerprint());
    await waitFor(() => expect(result.current).toBe('unknown'));
  });

  it('unmount 시 stopAccelerometerFingerprint 호출 (cleanup)', async () => {
    mockSupported.mockReturnValue(true);
    mockGetSnapshot.mockReturnValue(makeSnapshot('walking', 1.2));

    const { unmount } = renderHook(() => useAccelerometerFingerprint());
    await waitFor(() => expect(mockStart).toHaveBeenCalled());
    unmount();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });
});
