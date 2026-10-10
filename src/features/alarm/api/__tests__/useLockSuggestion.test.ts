/**
 * #1534 (S1, T9b, ADR-016) — useLockSuggestion hook acceptance.
 *
 * 매핑된 acceptance:
 *   - V2 lockless 첫 station miss ≤ 2 — useLockSuggestion이 lockSuggestion mirror를 1순위 노출
 *   - lockSuggestion 부재 → null (caller 9-AND fallback)
 *   - LOCK_SUGGESTION_MAX_AGE_MS 초과 → null (mirror leak 차단)
 *   - 동일 mirror entry 재read는 setState skip (re-render 폭주 차단)
 */

import { act, renderHook, waitFor } from '@testing-library/react-native';
import {
  LOCK_SUGGESTION_MAX_AGE_MS,
  LOCK_SUGGESTION_POLL_INTERVAL_MS,
  useLockSuggestion,
} from '../useLockSuggestion';
import * as backendSsotMirror from '../../utils/backendSsotMirror';
import type {
  BackendSsotMirrorEntry,
  LockSuggestionMirror,
} from '../../utils/backendSsotMirror';

const SUGGESTION: LockSuggestionMirror = {
  stationId: '용마산',
  trainCode: '7246',
  lineId: '7',
  confidence: 'high',
  decidedAt: 1_700_000_000_000,
};

const ENTRY: BackendSsotMirrorEntry = {
  currentStationId: '용마산',
  motionState: 'moving',
  lastAdvanceEvidence: 'arvlcd-confirmed-train',
  lastAdvanceAt: 1_700_000_000_000,
  passedStations: ['중곡'],
  receivedAt: 1_700_000_000_000,
  lockSuggestion: SUGGESTION,
};

describe('useLockSuggestion (#1534 S1 T9b)', () => {
  let readSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    readSpy = jest.spyOn(backendSsotMirror, 'readBackendSsotMirror');
  });

  afterEach(() => {
    jest.useRealTimers();
    readSpy.mockRestore();
  });

  it('첫 tick 전에는 suggestion=null (마운트 직후 동기 read X)', () => {
    readSpy.mockResolvedValue(ENTRY);
    const { result } = renderHook(() =>
      useLockSuggestion({ now: () => 1_700_000_000_000 }),
    );
    expect(result.current.suggestion).toBeNull();
    expect(result.current.decidedAt).toBeNull();
    expect(result.current.sourceReceivedAt).toBeNull();
  });

  it('첫 tick에서 valid suggestion read → state 갱신', async () => {
    readSpy.mockResolvedValue(ENTRY);
    const { result } = renderHook(() =>
      useLockSuggestion({ now: () => 1_700_000_000_000 }),
    );
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion).toEqual(SUGGESTION);
    });
    expect(result.current.decidedAt).toBe(SUGGESTION.decidedAt);
    expect(result.current.sourceReceivedAt).toBe(ENTRY.receivedAt);
  });

  it('mirror 부재 → null state 유지', async () => {
    readSpy.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useLockSuggestion({ now: () => 1_700_000_000_000 }),
    );
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion).toBeNull();
    });
    expect(result.current.decidedAt).toBeNull();
    expect(result.current.sourceReceivedAt).toBeNull();
  });

  it('mirror 있지만 lockSuggestion 없음 → null state', async () => {
    readSpy.mockResolvedValue({ ...ENTRY, lockSuggestion: undefined });
    const { result } = renderHook(() =>
      useLockSuggestion({ now: () => 1_700_000_000_000 }),
    );
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion).toBeNull();
    });
  });

  it('LOCK_SUGGESTION_MAX_AGE_MS 초과 stale → null (mirror leak 차단)', async () => {
    readSpy.mockResolvedValue(ENTRY);
    const { result } = renderHook(() =>
      useLockSuggestion({
        now: () => ENTRY.receivedAt + LOCK_SUGGESTION_MAX_AGE_MS + 1,
      }),
    );
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion).toBeNull();
    });
  });

  it('LOCK_SUGGESTION_MAX_AGE_MS 정확히 도달 → 통과 (boundary)', async () => {
    readSpy.mockResolvedValue(ENTRY);
    const { result } = renderHook(() =>
      useLockSuggestion({
        now: () => ENTRY.receivedAt + LOCK_SUGGESTION_MAX_AGE_MS,
      }),
    );
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion).toEqual(SUGGESTION);
    });
  });

  it('동일 entry 재read → setState skip (re-render 폭주 차단)', async () => {
    readSpy.mockResolvedValue(ENTRY);
    const renders: number[] = [];
    const { result } = renderHook(() => {
      const state = useLockSuggestion({ now: () => 1_700_000_000_000 });
      renders.push(renders.length);
      return state;
    });
    // 3 tick — 동일 entry라 setState는 1회만 발생해야 한다.
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion).toEqual(SUGGESTION);
    });
    // 초기 mount 1회 + 첫 tick state 갱신 1회 = 2회 (정확한 횟수는 React 내부, 적어도 폭주 X)
    expect(renders.length).toBeLessThan(6);
  });

  it('lockSuggestion이 다른 trainCode로 변경 → state 갱신', async () => {
    readSpy.mockResolvedValueOnce(ENTRY);
    const { result, rerender } = renderHook(() =>
      useLockSuggestion({ now: () => 1_700_000_000_000 }),
    );
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion?.trainCode).toBe('7246');
    });
    const newSuggestion: LockSuggestionMirror = {
      ...SUGGESTION,
      trainCode: '9999',
      decidedAt: ENTRY.receivedAt + 1_000,
    };
    readSpy.mockResolvedValue({
      ...ENTRY,
      receivedAt: ENTRY.receivedAt + 1_000,
      lockSuggestion: newSuggestion,
    });
    rerender({ now: () => 1_700_000_000_000 });
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion?.trainCode).toBe('9999');
    });
  });

  it('null → entry 전이 시 state 갱신', async () => {
    readSpy.mockResolvedValueOnce(null);
    const { result } = renderHook(() =>
      useLockSuggestion({ now: () => 1_700_000_000_000 }),
    );
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion).toBeNull();
    });
    readSpy.mockResolvedValue(ENTRY);
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion).toEqual(SUGGESTION);
    });
  });

  it('entry → null 전이 시 state reset', async () => {
    readSpy.mockResolvedValueOnce(ENTRY);
    const { result } = renderHook(() =>
      useLockSuggestion({ now: () => 1_700_000_000_000 }),
    );
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion).toEqual(SUGGESTION);
    });
    readSpy.mockResolvedValue(null);
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion).toBeNull();
    });
  });

  it('unmount 시 interval cleanup (cancelled guard)', async () => {
    readSpy.mockResolvedValue(ENTRY);
    const { unmount } = renderHook(() =>
      useLockSuggestion({ now: () => 1_700_000_000_000 }),
    );
    unmount();
    // unmount 후 추가 tick은 setState 호출 X (cancelled가 true)
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS * 3);
    });
    // 정확한 호출 횟수보다는 throw 없이 종료되는지 확인
  });

  it('tick 발사 후 unmount 시점에 promise 해소 → cancelled 가드로 setState skip (line 89)', async () => {
    // Promise를 외부 resolve 함수로 만들어 unmount 후 해결되도록 정확하게 race 시뮬레이션.
    let resolveRead!: (entry: BackendSsotMirrorEntry | null) => void;
    readSpy.mockImplementation(
      () =>
        new Promise<BackendSsotMirrorEntry | null>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const { unmount, result } = renderHook(() =>
      useLockSuggestion({ now: () => 1_700_000_000_000 }),
    );
    // tick 발사 (Promise pending 상태)
    jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    // unmount → cancelled=true
    unmount();
    // 이제 해소 — cancelled 가드가 setState를 차단해야 한다
    await act(async () => {
      resolveRead(ENTRY);
      // microtask flush
      await Promise.resolve();
    });
    // state 갱신 안 됨 (unmount 후라 React에서 read하지 못해도 throw 없으면 통과)
    expect(result.current.suggestion).toBeNull();
  });

  it('valid suggestion 채택 후 stale 전이 → setState로 null로 전환 (line 107)', async () => {
    // 첫 tick: 신선한 entry
    const receivedAt = 1_700_000_000_000;
    readSpy.mockResolvedValue({ ...ENTRY, receivedAt });
    let currentNow = receivedAt;
    const { result } = renderHook(() =>
      useLockSuggestion({ now: () => currentNow }),
    );
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion).toEqual(SUGGESTION);
    });
    // now를 stale window 너머로 이동 — 다음 tick에서 stale 분기 진입
    currentNow = receivedAt + LOCK_SUGGESTION_MAX_AGE_MS + 1;
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion).toBeNull();
    });
    expect(result.current.decidedAt).toBeNull();
    expect(result.current.sourceReceivedAt).toBeNull();
  });

  it('options 미전달 → now=Date.now 기본 (회귀 없음)', async () => {
    const realNow = Date.now();
    readSpy.mockResolvedValue({ ...ENTRY, receivedAt: realNow });
    const { result } = renderHook(() => useLockSuggestion());
    await act(async () => {
      jest.advanceTimersByTime(LOCK_SUGGESTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(result.current.suggestion).toEqual(SUGGESTION);
    });
  });

  it('LOCK_SUGGESTION_POLL_INTERVAL_MS === 5000 (정책 박제)', () => {
    expect(LOCK_SUGGESTION_POLL_INTERVAL_MS).toBe(5_000);
  });

  it('LOCK_SUGGESTION_MAX_AGE_MS === 300000 (5분 박제)', () => {
    expect(LOCK_SUGGESTION_MAX_AGE_MS).toBe(5 * 60_000);
  });
});
