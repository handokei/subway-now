import { renderHook } from '@testing-library/react-native';
import { useTripOrigin } from '../useTripOrigin';
import type { Station } from '../../../../shared/types/station';

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

  it('첫 set 시 effectiveOrigin이 null이면 다음 렌더에서 lazily 캡처한다 (#700: 첫 호출에서 null setter는 영속 보호로 스킵)', () => {
    const setter = jest.fn();
    const { rerender } = renderHook(
      ({ dest, origin }: { dest: Station | null; origin: Station | null }) =>
        useTripOrigin(dest, origin, setter),
      { initialProps: { dest: stationB, origin: null } },
    );
    // #700 — destination이 truthy로 첫 set됐는데 effectiveOrigin이 null인 시점에
    // setter(null)을 호출하면 hydration race로 영속값을 덮어쓸 수 있어 스킵한다.
    expect(setter).not.toHaveBeenCalled();
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

  // #700 — cold restart 회복: 영속화된 tripOrigin이 hydrate된 상태에서 마운트되면
  // 첫 effect가 GPS 첫 fix(effectiveOrigin)로 덮어쓰지 않아야 한다.
  // 그렇지 않으면 진짜 출발역과 다른 역이 origin으로 잡혀 route가 잘못 계산된다.
  it('persistedTripOrigin이 있으면 마운트 시 effectiveOrigin으로 덮어쓰지 않는다 (cold restart hydration)', () => {
    const setter = jest.fn();
    // destination=stationB, 진짜 출발역=stationA(영속됨), GPS 첫 fix는 잘못된 stationC
    renderHook(() => useTripOrigin(stationB, stationC, setter, stationA));
    // 영속값이 있으므로 effectiveOrigin(stationC) 캡처를 스킵 — setter 미호출
    expect(setter).not.toHaveBeenCalled();
  });

  it('persistedTripOrigin이 있어도 destination이 바뀌면 새 effectiveOrigin으로 재캡처한다', () => {
    const setter = jest.fn();
    const { rerender } = renderHook(
      ({ dest, origin, persisted }: { dest: Station | null; origin: Station | null; persisted: Station | null }) =>
        useTripOrigin(dest, origin, setter, persisted),
      { initialProps: { dest: stationB as Station | null, origin: stationA as Station | null, persisted: stationA as Station | null } },
    );
    setter.mockClear();
    // destination이 stationC로 바뀜 → 영속값 무관하게 새 effectiveOrigin 캡처
    rerender({ dest: stationC, origin: stationB, persisted: stationA });
    expect(setter).toHaveBeenCalledWith(stationB);
  });

  it('persistedTripOrigin이 null이면 기존 캡처 로직대로 effectiveOrigin을 캡처한다', () => {
    const setter = jest.fn();
    // 영속값 없음 — 기존 동작 그대로
    renderHook(() => useTripOrigin(stationB, stationA, setter, null));
    expect(setter).toHaveBeenCalledWith(stationA);
  });

  it('persistedTripOrigin이 있어도 destination이 null이면 영속값을 무시하고 null 캡처', () => {
    const setter = jest.fn();
    // destination이 null인 상태에서 마운트 — 시드 조건 미충족
    renderHook(() => useTripOrigin(null, stationA, setter, stationA));
    // destination이 처음부터 null이므로 setter는 호출되지 않는다 (기존 noop 규칙)
    expect(setter).not.toHaveBeenCalled();
  });

  // #700 — 진짜 race 회귀 가드: 마운트 시점엔 persisted=null(아직 hydrate 전),
  // GPS도 아직 없음 → capture effect가 잘못 setter(null)을 보내 영속을 죽이면 안된다.
  // 그 후 persisted가 hydrate되면 ref가 시드되어 잘못된 GPS가 와도 캡처를 스킵해야 한다.
  it('hydration race: persisted가 늦게 hydrate돼도 영속을 덮어쓰지 않고 시드된다', () => {
    const setter = jest.fn();
    const { rerender } = renderHook(
      ({ persisted, origin }: { persisted: Station | null; origin: Station | null }) =>
        useTripOrigin(stationB, origin, setter, persisted),
      { initialProps: { persisted: null as Station | null, origin: null as Station | null } },
    );
    // 첫 렌더: persisted=null, origin=null — setter는 호출되지 않아야 함 (영속 보호)
    expect(setter).not.toHaveBeenCalled();
    // hydrate 완료: persisted=A로 도착
    rerender({ persisted: stationA, origin: null });
    // 시드만 일어나고 setter는 여전히 무호출 (이미 store에 A가 있으므로)
    expect(setter).not.toHaveBeenCalled();
    // 잘못된 GPS C가 도착 — 시드된 ref 덕에 캡처 스킵
    rerender({ persisted: stationA, origin: stationC });
    expect(setter).not.toHaveBeenCalled();
  });

  it('hydration race: persisted=null + effectiveOrigin null 첫 렌더 후 effectiveOrigin이 먼저 도착하면 lazy capture', () => {
    const setter = jest.fn();
    const { rerender } = renderHook(
      ({ origin }: { origin: Station | null }) =>
        useTripOrigin(stationB, origin, setter, null),
      { initialProps: { origin: null as Station | null } },
    );
    expect(setter).not.toHaveBeenCalled();
    // persisted 없이 GPS가 먼저 도착 — lazy capture로 정상 캡처
    rerender({ origin: stationA });
    expect(setter).toHaveBeenCalledWith(stationA);
  });

  it('persistedTripOrigin이 시드된 후에는 다른 destination으로 바뀔 때 시드를 재적용하지 않는다', () => {
    const setter = jest.fn();
    const { rerender } = renderHook(
      ({ dest, persisted }: { dest: Station | null; persisted: Station | null }) =>
        useTripOrigin(dest, stationC, setter, persisted),
      { initialProps: { dest: stationB as Station | null, persisted: stationA as Station | null } },
    );
    setter.mockClear();
    // destination 변경 → 새 origin(stationC) 캡처
    rerender({ dest: stationC, persisted: stationA });
    expect(setter).toHaveBeenCalledWith(stationC);
    setter.mockClear();
    // persisted가 여전히 stationA지만 시드는 다시 적용되지 않음 (다른 dest)
    rerender({ dest: stationC, persisted: stationA });
    expect(setter).not.toHaveBeenCalled();
  });
});
