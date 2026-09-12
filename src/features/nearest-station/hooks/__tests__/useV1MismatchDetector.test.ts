/**
 * #1621 Phase B — useV1MismatchDetector 단위 테스트.
 *
 * 동작:
 *   1. UI/SSoT 일치 → appendAlarmLog 호출 X
 *   2. UI/SSoT 다름 → appendAlarmLog 1건 호출 (reason='v1-mismatch')
 *   3. null input (둘 중 하나라도 null) → no-op
 *   4. 같은 (ui, ssot) mismatch 반복 → 1분 dedup
 *   5. 다른 mismatch 쌍 → 각각 적재
 */

const mockAppend = jest.fn();
jest.mock('../../../alarm/utils/alarmLog', () => ({
  appendAlarmLog: (entry: unknown) => mockAppend(entry),
}));

import { renderHook } from '@testing-library/react-native';
import {
  useV1MismatchDetector,
  V1_MISMATCH_DEDUP_WINDOW_MS,
} from '../useV1MismatchDetector';

/** rerender 가능한 hook factory — 4건 테스트의 동일 setup 중복 제거. */
function renderDetector(initialProps: { ui: string | null; ssot: string | null }) {
  return renderHook(
    ({ ui, ssot }: { ui: string | null; ssot: string | null }) =>
      useV1MismatchDetector(ui, ssot),
    { initialProps },
  );
}

describe('useV1MismatchDetector (#1621 Phase B)', () => {
  beforeEach(() => {
    mockAppend.mockReset();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-21T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    {
      label: 'UI/SSoT 일치',
      ui: 'STN_A',
      ssot: 'STN_A',
    },
    {
      label: 'UI null',
      ui: null,
      ssot: 'STN_A',
    },
    {
      label: 'SSoT null',
      ui: 'STN_A',
      ssot: null,
    },
    {
      label: '둘 다 null',
      ui: null,
      ssot: null,
    },
  ])('적재 X — $label', ({ ui, ssot }) => {
    renderHook(() => useV1MismatchDetector(ui, ssot));
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('UI/SSoT 다름 → alarmLog v1-mismatch 1건 적재', () => {
    renderHook(() => useV1MismatchDetector('STN_UI', 'STN_SSOT'));
    expect(mockAppend).toHaveBeenCalledTimes(1);
    const entry = mockAppend.mock.calls[0][0];
    expect(entry.source).toBe('fg-evaluated');
    expect(entry.outcome).toBe('suppressed');
    expect(entry.reason).toBe('v1-mismatch');
    expect(entry.stationName).toBe('STN_UI');
    expect(entry.expectedStationAtFire).toBe('STN_SSOT');
  });

  it('같은 (ui, ssot) mismatch 반복 — re-render에도 effect 미재실행 (deps 안 변함)', () => {
    const { rerender } = renderDetector({ ui: 'STN_UI', ssot: 'STN_SSOT' });
    expect(mockAppend).toHaveBeenCalledTimes(1);
    // 같은 props 재호출 — useEffect deps([ui, ssot]) 안 바뀌어 재실행 X.
    rerender({ ui: 'STN_UI', ssot: 'STN_SSOT' });
    expect(mockAppend).toHaveBeenCalledTimes(1);
    rerender({ ui: 'STN_UI', ssot: 'STN_SSOT' });
    expect(mockAppend).toHaveBeenCalledTimes(1);
  });

  it('같은 쌍이 dedup window 안에 재진입 시 차단 (effect deps 변경 케이스)', () => {
    const { rerender } = renderDetector({ ui: 'STN_UI', ssot: 'STN_SSOT' });
    expect(mockAppend).toHaveBeenCalledTimes(1);
    // 일시적으로 SSoT가 UI와 일치 → mismatch 아님 (적재 X).
    rerender({ ui: 'STN_UI', ssot: 'STN_UI' });
    expect(mockAppend).toHaveBeenCalledTimes(1);
    // 같은 쌍 재진입 — dedup window 안이라 차단.
    rerender({ ui: 'STN_UI', ssot: 'STN_SSOT' });
    expect(mockAppend).toHaveBeenCalledTimes(1);
  });

  it('dedup 윈도우 만료 후 같은 쌍 재적재', () => {
    const { rerender } = renderDetector({ ui: 'STN_UI', ssot: 'STN_SSOT' });
    expect(mockAppend).toHaveBeenCalledTimes(1);
    // 다른 쌍으로 잠시 전환
    rerender({ ui: 'STN_OTHER', ssot: 'STN_SSOT' });
    expect(mockAppend).toHaveBeenCalledTimes(2);
    // 시간 점프 후 동일 (UI, SSoT) 쌍 복귀
    jest.setSystemTime(new Date(Date.now() + V1_MISMATCH_DEDUP_WINDOW_MS + 1));
    rerender({ ui: 'STN_UI', ssot: 'STN_SSOT' });
    expect(mockAppend).toHaveBeenCalledTimes(3);
  });

  it('다른 (ui, ssot) 쌍은 각각 적재', () => {
    const { rerender } = renderDetector({ ui: 'STN_A', ssot: 'STN_X' });
    expect(mockAppend).toHaveBeenCalledTimes(1);
    rerender({ ui: 'STN_B', ssot: 'STN_Y' });
    expect(mockAppend).toHaveBeenCalledTimes(2);
    rerender({ ui: 'STN_C', ssot: 'STN_Z' });
    expect(mockAppend).toHaveBeenCalledTimes(3);
  });
});
