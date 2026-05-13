import { renderHook } from '@testing-library/react-native';
import { useTripOrigin } from '../useTripOrigin';
import type { Station } from '../../types/station';

function makeStation(id: string, name: string): Station {
  return {
    id,
    name,
    line: '7',
    lineColor: '#000',
    lat: 0,
    lng: 0,
  };
}

const stationA = makeStation('7-001', 'A');
const stationB = makeStation('7-002', 'B');
const stationC = makeStation('7-003', 'C');

describe('useTripOrigin', () => {
  it('destination이 처음부터 null이면 setter를 호출하지 않는다 (이미 null이므로 noop)', () => {
    const setter = jest.fn();
    const { rerender } = renderHook(
      ({ origin }: { origin: Station | null }) => useTripOrigin(null, origin, setter),
      { initialProps: { origin: stationA as Station | null } },
    );
    expect(setter).not.toHaveBeenCalled();
    rerender({ origin: stationB });
    rerender({ origin: null });
    expect(setter).not.toHaveBeenCalled();
  });

  it('destination이 처음 set되는 순간 effectiveOrigin을 캡처한다', () => {
    const setter = jest.fn();
    renderHook(() => useTripOrigin(stationB, stationA, setter));
    expect(setter).toHaveBeenCalledWith(stationA);
  });

  it('첫 set 시 effectiveOrigin이 null이면 다음 렌더에서 lazily 캡처한다', () => {
    const setter = jest.fn();
    const { rerender } = renderHook(
      ({ dest, origin }: { dest: Station | null; origin: Station | null }) =>
        useTripOrigin(dest, origin, setter),
      { initialProps: { dest: stationB, origin: null } },
    );
    expect(setter).toHaveBeenLastCalledWith(null);
    setter.mockClear();
    rerender({ dest: stationB, origin: stationA });
    expect(setter).toHaveBeenCalledWith(stationA);
  });

  it('destination이 같은 동안 effectiveOrigin이 바뀌어도 tripOrigin은 갱신하지 않는다', () => {
    const setter = jest.fn();
    const { rerender } = renderHook(
      ({ dest, origin }: { dest: Station | null; origin: Station | null }) =>
        useTripOrigin(dest, origin, setter),
      { initialProps: { dest: stationB, origin: stationA } },
    );
    expect(setter).toHaveBeenCalledWith(stationA);
    setter.mockClear();
    rerender({ dest: stationB, origin: stationC });
    expect(setter).not.toHaveBeenCalled();
  });

  it('destination이 다른 역으로 바뀌면 새 effectiveOrigin으로 재캡처한다', () => {
    const setter = jest.fn();
    const { rerender } = renderHook(
      ({ dest, origin }: { dest: Station | null; origin: Station | null }) =>
        useTripOrigin(dest, origin, setter),
      { initialProps: { dest: stationB, origin: stationA } },
    );
    setter.mockClear();
    rerender({ dest: stationC, origin: stationB });
    expect(setter).toHaveBeenCalledWith(stationB);
  });

  it('destination이 null로 바뀌면 tripOrigin을 null로 클리어한다', () => {
    const setter = jest.fn();
    const { rerender } = renderHook(
      ({ dest, origin }: { dest: Station | null; origin: Station | null }) =>
        useTripOrigin(dest, origin, setter),
      { initialProps: { dest: stationB as Station | null, origin: stationA as Station | null } },
    );
    setter.mockClear();
    rerender({ dest: null, origin: stationA });
    expect(setter).toHaveBeenCalledWith(null);
  });
});
