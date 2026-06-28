/**
 * useTripDetail (#1956, S-m3-1 P0) 단위 테스트.
 *
 * 커버:
 *   - tripToken=null → null
 *   - rawSignalBuffer empty → null
 *   - tripToken 변경 → snapshot 재계산
 *   - pushRawSignal 호출 → subscribe 콜백 → re-render
 *   - unmount → unsubscribe (이후 push가 setState 호출 안 함)
 */
import { act, renderHook } from '@testing-library/react-native';
import { useTripDetail } from '../useTripDetail';
import {
  __resetRawSignalForTests__,
  pushRawSignal,
  type RawSignalEntry,
} from '../../../observability/utils/rawSignalBuffer';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function makeEntry(overrides?: Partial<RawSignalEntry>): RawSignalEntry {
  return {
    ts: 1_700_000_000_000,
    corrId: 'corr-abc',
    kind: 'cycle',
    gps: null,
    motion: null,
    accelPattern: null,
    cellular: null,
    subsurface: null,
    arvlCd: null,
    line: null,
    dir: null,
    arcIdx: null,
    arcProgress: null,
    stationId: null,
    source: null,
    confidence: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  __resetRawSignalForTests__();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useTripDetail', () => {
  it('returns null when tripToken is null', () => {
    pushRawSignal(makeEntry({ corrId: 'corr-1' }));
    const { result } = renderHook(() => useTripDetail(null));
    expect(result.current).toBeNull();
  });

  it('returns null when rawSignalBuffer is empty', () => {
    const { result } = renderHook(() => useTripDetail('corr-1'));
    expect(result.current).toBeNull();
  });

  it('returns a snapshot when tripToken matches existing entries', () => {
    pushRawSignal(makeEntry({ corrId: 'corr-1', ts: 1_000 }));
    pushRawSignal(makeEntry({ corrId: 'corr-1', ts: 2_000 }));
    const { result } = renderHook(() => useTripDetail('corr-1'));
    expect(result.current).not.toBeNull();
    expect(result.current?.tripToken).toBe('corr-1');
    expect(result.current?.entries).toHaveLength(2);
  });

  it('recomputes when tripToken changes', () => {
    pushRawSignal(makeEntry({ corrId: 'corr-1', ts: 1_000 }));
    pushRawSignal(makeEntry({ corrId: 'corr-2', ts: 2_000 }));
    const { result, rerender } = renderHook(
      ({ token }: { token: string | null }) => useTripDetail(token),
      { initialProps: { token: 'corr-1' } },
    );
    expect(result.current?.tripToken).toBe('corr-1');
    rerender({ token: 'corr-2' });
    expect(result.current?.tripToken).toBe('corr-2');
  });

  it('re-renders when rawSignalBuffer pushes a new entry for the same token', () => {
    pushRawSignal(makeEntry({ corrId: 'corr-1', ts: 1_000 }));
    const { result } = renderHook(() => useTripDetail('corr-1'));
    expect(result.current?.entries).toHaveLength(1);

    act(() => {
      pushRawSignal(makeEntry({ corrId: 'corr-1', ts: 2_000 }));
    });
    expect(result.current?.entries).toHaveLength(2);
  });

  it('unsubscribes on unmount (no further updates)', () => {
    pushRawSignal(makeEntry({ corrId: 'corr-1', ts: 1_000 }));
    const { result, unmount } = renderHook(() => useTripDetail('corr-1'));
    expect(result.current?.entries).toHaveLength(1);

    unmount();
    // 언마운트 후 push는 result에 영향을 주지 않아야 함 — error 없이 끝나면 OK
    act(() => {
      pushRawSignal(makeEntry({ corrId: 'corr-1', ts: 2_000 }));
    });
    // 마지막 snapshot은 unmount 시점 — 갱신 안 됨
    expect(result.current?.entries).toHaveLength(1);
  });
});
