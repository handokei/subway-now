import { renderHook } from '@testing-library/react-native';
import { useCongestion } from '../useCongestion';

describe('useCongestion', () => {
  it('역+노선+방향이 모두 주어지고 fixture에 매칭되면 entry 반환', () => {
    const now = new Date(2026, 0, 5, 8, 0);
    const { result } = renderHook(() =>
      useCongestion({ stationName: '강남', line: '2', direction: 'up', now }),
    );
    expect(result.current).not.toBeNull();
    expect(result.current?.raw).toBe(155);
    expect(result.current?.level).toBe('veryHigh');
  });

  it('stationName이 null이면 null', () => {
    const { result } = renderHook(() =>
      useCongestion({ stationName: null, line: '2', direction: 'up', now: new Date(2026, 0, 5, 8, 0) }),
    );
    expect(result.current).toBeNull();
  });

  it('stationName이 undefined여도 null', () => {
    const { result } = renderHook(() =>
      useCongestion({ stationName: undefined, line: '2', direction: 'up', now: new Date(2026, 0, 5, 8, 0) }),
    );
    expect(result.current).toBeNull();
  });

  it('line이 null이면 null', () => {
    const { result } = renderHook(() =>
      useCongestion({ stationName: '강남', line: null, direction: 'up', now: new Date(2026, 0, 5, 8, 0) }),
    );
    expect(result.current).toBeNull();
  });

  it('direction이 null이면 null', () => {
    const { result } = renderHook(() =>
      useCongestion({ stationName: '강남', line: '2', direction: null, now: new Date(2026, 0, 5, 8, 0) }),
    );
    expect(result.current).toBeNull();
  });

  it('미커버 시간대는 null', () => {
    const { result } = renderHook(() =>
      useCongestion({ stationName: '강남', line: '2', direction: 'up', now: new Date(2026, 0, 5, 12, 0) }),
    );
    expect(result.current).toBeNull();
  });

  it('now 생략 시 호출 시점의 new Date()로 lookup (시스템 시간 fake로 검증)', () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 0, 5, 8, 0));
    const { result } = renderHook(() =>
      useCongestion({ stationName: '강남', line: '2', direction: 'up' }),
    );
    expect(result.current?.raw).toBe(155);
    jest.useRealTimers();
  });

  it('rerender 시 동일 입력은 메모이즈된 동일 참조 반환', () => {
    const now = new Date(2026, 0, 5, 8, 0);
    const { result, rerender } = renderHook(
      ({ s }: { s: string }) =>
        useCongestion({ stationName: s, line: '2', direction: 'up', now }),
      { initialProps: { s: '강남' } },
    );
    const first = result.current;
    rerender({ s: '강남' });
    expect(result.current).toBe(first);
  });
});
