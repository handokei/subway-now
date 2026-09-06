/**
 * #1910 — cold-start navigate gate tests.
 *
 * 시나리오:
 *   A. cold-start: hydrated=false 시 banner tap → queue → hydrated=true → flush (1회 navigate)
 *   B. hot path: hydrated=true 시 banner tap → 즉시 navigate
 *   C. dedup: 같은 trip 내 banner tap 2회 → 1회만 navigate
 */

import { act, renderHook } from '@testing-library/react-native';
import { useDeferredNavigate } from '../useDeferredNavigate';

jest.mock('../../infra/monitoring/breadcrumb', () => ({
  addDomainBreadcrumb: jest.fn(),
}));
jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const { addDomainBreadcrumb } = jest.requireMock('../../infra/monitoring/breadcrumb') as {
  addDomainBreadcrumb: jest.Mock;
};

describe('useDeferredNavigate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 시나리오 A: cold-start — banner tap이 hydrated=false 시점에 fire됨.
  it('cold-start: hydrated=false 시 tap → queue → hydrated=true 로 전환 시 1회 navigate (flush)', () => {
    const navigate = jest.fn();

    const { result, rerender } = renderHook(
      ({ hydrated }: { hydrated: boolean }) => useDeferredNavigate(hydrated, navigate),
      { initialProps: { hydrated: false } },
    );

    const requestNavigate = result.current;

    // cold-start tap — hydrated=false이므로 즉시 navigate 호출 안 됨.
    act(() => {
      requestNavigate();
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(addDomainBreadcrumb).toHaveBeenCalledWith('lifecycle', 'cold_start_navigate_deferred');

    // hydrated=true 전환 — flush effect 실행.
    rerender({ hydrated: true });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(addDomainBreadcrumb).toHaveBeenCalledWith(
      'lifecycle',
      'cold_start_navigate_deferred_flushed',
    );
  });

  // 시나리오 B: hot path — 이미 hydrated=true인 상태에서 tap.
  it('hot path: hydrated=true 시 tap → 즉시 navigate (defer 없음)', () => {
    const navigate = jest.fn();

    const { result } = renderHook(() => useDeferredNavigate(true, navigate));

    act(() => {
      result.current();
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    // deferred breadcrumb은 발사되지 않아야 한다.
    expect(addDomainBreadcrumb).not.toHaveBeenCalledWith(
      'lifecycle',
      'cold_start_navigate_deferred',
    );
  });

  // 시나리오 C: dedup — 같은 trip 내 banner tap 2회 → hydrated 전환 시 1회만 navigate.
  it('dedup: cold-start 중 tap 2회 → hydrated=true 후 1회만 navigate', () => {
    const navigate = jest.fn();

    const { result, rerender } = renderHook(
      ({ hydrated }: { hydrated: boolean }) => useDeferredNavigate(hydrated, navigate),
      { initialProps: { hydrated: false } },
    );

    const requestNavigate = result.current;

    act(() => {
      requestNavigate(); // 1st tap
      requestNavigate(); // 2nd tap — ref는 이미 true, 중복 기록 없음
    });
    expect(navigate).not.toHaveBeenCalled();

    rerender({ hydrated: true });
    // boolean ref → flush 1회만 실행.
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  // 경계: tap 없이 hydrated=true로 전환 → navigate 호출 없음 (no false flush).
  it('tap 없이 hydrated=true 전환 → navigate 호출 없음', () => {
    const navigate = jest.fn();

    const { rerender } = renderHook(
      ({ hydrated }: { hydrated: boolean }) => useDeferredNavigate(hydrated, navigate),
      { initialProps: { hydrated: false } },
    );

    rerender({ hydrated: true });
    expect(navigate).not.toHaveBeenCalled();
    expect(addDomainBreadcrumb).not.toHaveBeenCalledWith(
      'lifecycle',
      'cold_start_navigate_deferred_flushed',
    );
  });

  // 경계: navigate 함수가 예외를 던져도 swallow (사용자 UX 차단 안 함).
  it('navigate 예외 → swallow (hook 재귀 예외 없음)', () => {
    const navigate = jest.fn(() => {
      throw new Error('navigate before mount');
    });

    const { result } = renderHook(() => useDeferredNavigate(true, navigate));

    expect(() => {
      act(() => {
        result.current();
      });
    }).not.toThrow();
  });

  // 경계: cold-start flush 후 동일 tap 재시도 → navigate 호출 안 함 (ref가 이미 reset됨).
  it('flush 완료 후 재tap 시도 없으면 navigate 2회 호출 안 함', () => {
    const navigate = jest.fn();

    const { result, rerender } = renderHook(
      ({ hydrated }: { hydrated: boolean }) => useDeferredNavigate(hydrated, navigate),
      { initialProps: { hydrated: false } },
    );

    act(() => { result.current(); }); // tap once during cold-start
    rerender({ hydrated: true }); // flush → 1회 navigate
    expect(navigate).toHaveBeenCalledTimes(1);

    // hydrated 유지 상태에서 hydrated 재렌더 — flush effect는 pendingRef=false이므로 no-op.
    rerender({ hydrated: true });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  // 경계: cold-start flush 시 navigate 예외 → swallow (UX 차단 안 함).
  it('cold-start flush 시 navigate 예외 → swallow', () => {
    const navigate = jest.fn(() => {
      throw new Error('navigate before mount');
    });

    const { result, rerender } = renderHook(
      ({ hydrated }: { hydrated: boolean }) => useDeferredNavigate(hydrated, navigate),
      { initialProps: { hydrated: false } },
    );

    act(() => { result.current(); }); // tap during cold-start → queue

    expect(() => {
      rerender({ hydrated: true }); // flush → navigate throws → swallow
    }).not.toThrow();
  });
});
