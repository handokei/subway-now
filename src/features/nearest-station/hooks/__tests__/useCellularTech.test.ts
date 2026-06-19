/**
 * #1543 (ADR-016 S10) — useCellularTech 훅 테스트.
 *
 * 동작:
 *   1. mount 시 isCellularTechSupported가 true면 startCellularTechUpdates
 *   2. 5s 폴링으로 getCurrentCellularTech → classifyCellularEnvironment 결과 sync
 *   3. 미지원 시 vote='unknown'으로 확정 (start/stop 호출 안 함)
 *   4. unmount 시 stopCellularTechUpdates
 */

const mockSupported = jest.fn();
const mockStart = jest.fn();
const mockStop = jest.fn();
const mockGet = jest.fn();

jest.mock('../../utils/cellularTech', () => {
  const actual = jest.requireActual('../../utils/cellularTech');
  return {
    ...actual,
    isCellularTechSupported: () => mockSupported(),
    startCellularTechUpdates: () => mockStart(),
    stopCellularTechUpdates: () => mockStop(),
    getCurrentCellularTech: () => mockGet(),
  };
});

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useCellularTech } from '../useCellularTech';

describe('useCellularTech (#1543)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSupported.mockReset();
    mockStart.mockReset();
    mockStop.mockReset();
    mockGet.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('미지원 디바이스 — vote unknown으로 확정, start/stop 호출 안 함', () => {
    mockSupported.mockReturnValue(false);
    const { result, unmount } = renderHook(() => useCellularTech());
    expect(result.current).toBe('unknown');
    expect(mockStart).not.toHaveBeenCalled();
    unmount();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('지원 — LTE 잡힘 시 surface vote', async () => {
    mockSupported.mockReturnValue(true);
    mockGet.mockReturnValue('CTRadioAccessTechnologyLTE');

    const { result } = renderHook(() => useCellularTech());
    await waitFor(() => expect(result.current).toBe('surface'));
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('지원 — Edge fallback 시 underground vote (다음 폴링)', async () => {
    mockSupported.mockReturnValue(true);
    mockGet.mockReturnValue('CTRadioAccessTechnologyLTE');

    const { result } = renderHook(() => useCellularTech());
    await waitFor(() => expect(result.current).toBe('surface'));

    // 지하 진입 — native가 Edge로 떨어짐
    mockGet.mockReturnValue('CTRadioAccessTechnologyEdge');
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    await waitFor(() => expect(result.current).toBe('underground'));
  });

  it('지원 — native null 반환 시 unknown', async () => {
    mockSupported.mockReturnValue(true);
    mockGet.mockReturnValue(null);

    const { result } = renderHook(() => useCellularTech());
    await waitFor(() => expect(result.current).toBe('unknown'));
  });

  it('unmount 시 stopCellularTechUpdates 호출 (cleanup)', async () => {
    mockSupported.mockReturnValue(true);
    mockGet.mockReturnValue('CTRadioAccessTechnologyLTE');

    const { unmount } = renderHook(() => useCellularTech());
    await waitFor(() => expect(mockStart).toHaveBeenCalled());
    unmount();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });
});
