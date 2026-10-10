import { renderHook, act } from '@testing-library/react-native';

// #2768 — 자동 종료 발동을 alarmLog로 배선(computeBoardableWaitsForRoute.ts 등과 같은
// cross-feature 적재 패턴, eslint-disable import/no-restricted-paths로 옵트인).
const mockLogArrivalAutoClearFired = jest.fn();
jest.mock('../../../alarm/utils/alarmLog', () => ({
  logArrivalAutoClearFired: (...args: unknown[]) => mockLogArrivalAutoClearFired(...args),
}));

import { useArrivalAutoClear, type UseArrivalAutoClearParams } from '../useArrivalAutoClear';

type Params = UseArrivalAutoClearParams;

const baseProps = (overrides: Partial<Params> = {}): Params => ({
  currentStationName: undefined,
  distanceKm: undefined,
  // #2716 — 기본값은 'gps'(실측 거리) + 확증 불필요. 기존 테스트 전부가 이 기본값으로
  // distanceKm 임계값 게이트 경로를 그대로 타므로 회귀 없이 하위 호환된다.
  distanceSource: 'gps',
  // #2741 — 기본값은 false(실측 거리) — 기존 테스트 전부가 distanceKm 임계값 게이트 경로를
  // 그대로 타므로 회귀 없이 하위 호환된다.
  distanceIsPlaceholder: false,
  destinationArrivalConfirmed: false,
  destinationName: undefined,
  onClear: jest.fn(),
  ...overrides,
});

describe('useArrivalAutoClear', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockLogArrivalAutoClearFired.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('초기 상태에서는 arrivedBanner가 false다', () => {
    const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps(),
    });
    expect(result.current.arrivedBanner).toBe(false);
  });

  it('도착 조건 충족 시 arrivedBanner=true가 되고 2초 뒤 onClear가 호출되며 banner가 false로 돌아온다', () => {
    const onClear = jest.fn();
    const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
        distanceKm: 0.3,
        onClear,
      }),
    });

    expect(result.current.arrivedBanner).toBe(true);
    expect(onClear).not.toHaveBeenCalled();
    // #2770 code review 4번 — 실제 clear(onClear)가 실행되는 시점(2s 타임아웃 콜백)까지는
    // alarmLog에 적재하지 않는다. 트리거 시점 stamp는 unmount로 타이머가 취소될 수 있어
    // 발동 안 한 auto-clear가 'fired'로 남는 거짓 양성을 만든다.
    expect(mockLogArrivalAutoClearFired).not.toHaveBeenCalled();

    act(() => { jest.advanceTimersByTime(2_000); });

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(result.current.arrivedBanner).toBe(false);
    // #2770 code review 4번 — 실제 clear 실행 시점(타임아웃 콜백)에 alarmLog 적재.
    expect(mockLogArrivalAutoClearFired).toHaveBeenCalledWith('용마산');
  });

  // #2770 code review 4번 — 트리거 시점 stamp는 거짓 양성(발동 안 했는데 'fired' 기록)을
  // 만든다. unmount로 타이머(clearTimeout)가 취소되면 타임아웃 콜백 자체가 실행되지 않으므로
  // 로그도 없어야 한다.
  it('트리거 후 2s 내 unmount → 로그 없음 (#2770 code review 4번, 거짓 양성 차단)', () => {
    const onClear = jest.fn();
    const { unmount } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
        distanceKm: 0.3,
        onClear,
      }),
    });

    act(() => { jest.advanceTimersByTime(500); });
    unmount();
    act(() => { jest.advanceTimersByTime(2_000); });

    expect(onClear).not.toHaveBeenCalled();
    expect(mockLogArrivalAutoClearFired).not.toHaveBeenCalled();
  });

  it('도착 후 2초 안에 distanceKm이 여러 번 바뀌어도 타이머가 살아남아 onClear가 호출된다 (#551 회귀)', () => {
    const onClear = jest.fn();
    const { result, rerender } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
        distanceKm: 0.3,
        onClear,
      }),
    });

    expect(result.current.arrivedBanner).toBe(true);

    act(() => { jest.advanceTimersByTime(500); });
    rerender(baseProps({ currentStationName: '용마산', destinationName: '용마산', distanceKm: 0.2, onClear }));
    act(() => { jest.advanceTimersByTime(500); });
    rerender(baseProps({ currentStationName: '용마산', destinationName: '용마산', distanceKm: 0.1, onClear }));
    act(() => { jest.advanceTimersByTime(500); });
    rerender(baseProps({ currentStationName: '용마산', destinationName: '용마산', distanceKm: 0.05, onClear }));

    expect(onClear).not.toHaveBeenCalled();

    act(() => { jest.advanceTimersByTime(500); });

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(result.current.arrivedBanner).toBe(false);
  });

  it('현재역이 목적지와 다르면 trigger하지 않는다', () => {
    const onClear = jest.fn();
    const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '강남',
        destinationName: '용마산',
        distanceKm: 0.1,
        onClear,
      }),
    });

    act(() => { jest.advanceTimersByTime(3_000); });

    expect(result.current.arrivedBanner).toBe(false);
    expect(onClear).not.toHaveBeenCalled();
    // #2768 — trigger 안 됐으므로 alarmLog도 적재되지 않는다.
    expect(mockLogArrivalAutoClearFired).not.toHaveBeenCalled();
  });

  it('거리가 0.5km를 초과하면 trigger하지 않는다', () => {
    const onClear = jest.fn();
    const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
        distanceKm: 0.6,
        onClear,
      }),
    });

    expect(result.current.arrivedBanner).toBe(false);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('destinationName이 없으면 trigger하지 않는다', () => {
    const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        distanceKm: 0.1,
      }),
    });

    expect(result.current.arrivedBanner).toBe(false);
  });

  it('currentStationName이 없으면 trigger하지 않는다', () => {
    const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        destinationName: '용마산',
        distanceKm: 0.1,
      }),
    });

    expect(result.current.arrivedBanner).toBe(false);
  });

  it('distanceKm이 없으면 trigger하지 않는다', () => {
    const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
      }),
    });

    expect(result.current.arrivedBanner).toBe(false);
  });

  it('도착 트리거 이후 props가 같은 채로 rerender 되어도 새 타이머가 생기지 않는다', () => {
    const onClear = jest.fn();
    const props = baseProps({
      currentStationName: '용마산',
      destinationName: '용마산',
      distanceKm: 0.3,
      onClear,
    });
    const { rerender } = renderHook((p: Params) => useArrivalAutoClear(p), { initialProps: props });

    rerender(props);
    rerender(props);

    act(() => { jest.advanceTimersByTime(2_000); });

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('타이머 발화 전 unmount 되면 pending timer가 정리된다 (onClear 미호출)', () => {
    const onClear = jest.fn();
    const { unmount } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
        distanceKm: 0.3,
        onClear,
      }),
    });

    act(() => { jest.advanceTimersByTime(500); });
    unmount();
    act(() => { jest.advanceTimersByTime(2_000); });

    expect(onClear).not.toHaveBeenCalled();
  });

  it('도착 트리거 없는 상태로 unmount 되어도 안전하다', () => {
    const { unmount } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps(),
    });
    expect(() => unmount()).not.toThrow();
  });

  it('도착 후 destination이 null로 리셋되었다가 다시 같은 목적지로 설정되면 재트리거된다', () => {
    const onClear = jest.fn();
    const { result, rerender } = renderHook((p: Params) => useArrivalAutoClear(p), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
        distanceKm: 0.3,
        onClear,
      }),
    });

    act(() => { jest.advanceTimersByTime(2_000); });
    expect(onClear).toHaveBeenCalledTimes(1);

    rerender(baseProps({ currentStationName: '용마산', destinationName: undefined, distanceKm: 0.3, onClear }));
    rerender(baseProps({ currentStationName: '용마산', destinationName: '용마산', distanceKm: 0.3, onClear }));

    expect(result.current.arrivedBanner).toBe(true);
    act(() => { jest.advanceTimersByTime(2_000); });
    expect(onClear).toHaveBeenCalledTimes(2);
  });

  it('onClear가 바뀌면 최신 콜백이 호출된다', () => {
    const onClear1 = jest.fn();
    const onClear2 = jest.fn();
    const { rerender } = renderHook((props: Params) => useArrivalAutoClear(props), {
      initialProps: baseProps({
        currentStationName: '용마산',
        destinationName: '용마산',
        distanceKm: 0.3,
        onClear: onClear1,
      }),
    });

    rerender(baseProps({
      currentStationName: '용마산',
      destinationName: '용마산',
      distanceKm: 0.3,
      onClear: onClear2,
    }));

    act(() => { jest.advanceTimersByTime(2_000); });

    expect(onClear1).not.toHaveBeenCalled();
    expect(onClear2).toHaveBeenCalledTimes(1);
  });

  // #2716 — backend-ssot tier는 mirror가 사용자 위치를 모르는 상태에서 distanceKm=0을
  // placeholder로 보고한다(실측 아님, "0m 떨어짐"이 아니라 "모름"). 실측 덤프
  // (2026-09-17 저녁): src=backend-ssot d=0m인데 GPS-nearest는 다른 역(용마산)이었다.
  // 이 값을 실측 0m와 동일하게 취급하면 역명 일치만으로 trip이 종료된다.
  describe('#2716 — backend-ssot 거리 placeholder', () => {
    it('red 재현: distanceSource=backend-ssot + distanceKm=0 + 역명 일치만으로는 trigger하지 않는다', () => {
      const onClear = jest.fn();
      const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
        initialProps: baseProps({
          currentStationName: '성수',
          destinationName: '성수',
          distanceKm: 0,
          distanceSource: 'backend-ssot',
          destinationArrivalConfirmed: false,
          onClear,
        }),
      });

      act(() => { jest.advanceTimersByTime(3_000); });

      expect(result.current.arrivedBanner).toBe(false);
      expect(onClear).not.toHaveBeenCalled();
    });

    it('distanceSource=backend-ssot이어도 목적지 arvlCd 확증(destinationArrivalConfirmed=true)이 있으면 trigger한다', () => {
      const onClear = jest.fn();
      const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
        initialProps: baseProps({
          currentStationName: '성수',
          destinationName: '성수',
          distanceKm: 0,
          distanceSource: 'backend-ssot',
          destinationArrivalConfirmed: true,
          onClear,
        }),
      });

      expect(result.current.arrivedBanner).toBe(true);
      expect(onClear).not.toHaveBeenCalled();

      act(() => { jest.advanceTimersByTime(2_000); });

      expect(onClear).toHaveBeenCalledTimes(1);
      expect(result.current.arrivedBanner).toBe(false);
    });

    it('회귀: distanceSource=gps(실측 거리)로 목적지 도착 시 기존 동작(배너+자동클리어) 유지', () => {
      const onClear = jest.fn();
      const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
        initialProps: baseProps({
          currentStationName: '용마산',
          destinationName: '용마산',
          distanceKm: 0.1,
          distanceSource: 'gps',
          destinationArrivalConfirmed: false,
          onClear,
        }),
      });

      expect(result.current.arrivedBanner).toBe(true);

      act(() => { jest.advanceTimersByTime(2_000); });

      expect(onClear).toHaveBeenCalledTimes(1);
      expect(result.current.arrivedBanner).toBe(false);
    });
  });

  // #2741 — wifi-ssid tier도 GPS 부재 시 distanceKm=0 placeholder를 쓴다(#2716과 동일 결함
  // 클래스). SSID는 사용자-역 거리를 모르므로 0을 "실측 0m"로 오인하면 안 된다. GPS가 있어
  // 실측 거리를 낸 wifi-ssid(1222행)는 기존 거리 가드를 그대로 타야 하므로, distanceSource만으로는
  // 두 케이스를 구분할 수 없다 — placeholder 여부를 별도 신호(distanceIsPlaceholder)로 전달한다.
  describe('#2741 — wifi-ssid 거리 placeholder', () => {
    it('red 재현: source=wifi-ssid + distanceIsPlaceholder=true(GPS 부재 placeholder) + 역명 일치만으로는 trigger하지 않는다', () => {
      const onClear = jest.fn();
      const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
        initialProps: baseProps({
          currentStationName: '용마산',
          destinationName: '용마산',
          distanceKm: 0,
          distanceSource: 'wifi-ssid',
          distanceIsPlaceholder: true,
          destinationArrivalConfirmed: false,
          onClear,
        }),
      });

      act(() => { jest.advanceTimersByTime(3_000); });

      // 왜 통과하면 안 되는지: distanceIsPlaceholder=true인 wifi-ssid는 destinationArrivalConfirmed
      // 대체 확증이 필요하다 — distanceKm=0을 실측 거리로 오인해 통과해서는 안 된다.
      expect(result.current.arrivedBanner).toBe(false);
      expect(onClear).not.toHaveBeenCalled();
    });

    it('source=wifi-ssid + distanceIsPlaceholder=true여도 목적지 arvlCd 확증(destinationArrivalConfirmed=true)이 있으면 trigger한다', () => {
      const onClear = jest.fn();
      const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
        initialProps: baseProps({
          currentStationName: '용마산',
          destinationName: '용마산',
          distanceKm: 0,
          distanceSource: 'wifi-ssid',
          distanceIsPlaceholder: true,
          destinationArrivalConfirmed: true,
          onClear,
        }),
      });

      expect(result.current.arrivedBanner).toBe(true);
      expect(onClear).not.toHaveBeenCalled();

      act(() => { jest.advanceTimersByTime(2_000); });

      expect(onClear).toHaveBeenCalledTimes(1);
      expect(result.current.arrivedBanner).toBe(false);
    });

    it('회귀: source=wifi-ssid + distanceIsPlaceholder=false(GPS 있음, 실측 거리)면 기존 거리 가드가 그대로 동작한다', () => {
      const onClear = jest.fn();
      const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
        initialProps: baseProps({
          currentStationName: '용마산',
          destinationName: '용마산',
          distanceKm: 0.1,
          distanceSource: 'wifi-ssid',
          distanceIsPlaceholder: false,
          destinationArrivalConfirmed: false,
          onClear,
        }),
      });

      // distanceIsPlaceholder=false → destinationArrivalConfirmed=false여도 실측 거리 게이트로 통과.
      expect(result.current.arrivedBanner).toBe(true);

      act(() => { jest.advanceTimersByTime(2_000); });

      expect(onClear).toHaveBeenCalledTimes(1);
      expect(result.current.arrivedBanner).toBe(false);
    });

    it('회귀: source=wifi-ssid + distanceIsPlaceholder=false + 거리가 0.5km 초과면 trigger하지 않는다', () => {
      const onClear = jest.fn();
      const { result } = renderHook((props: Params) => useArrivalAutoClear(props), {
        initialProps: baseProps({
          currentStationName: '용마산',
          destinationName: '용마산',
          distanceKm: 0.6,
          distanceSource: 'wifi-ssid',
          distanceIsPlaceholder: false,
          destinationArrivalConfirmed: true,
          onClear,
        }),
      });

      expect(result.current.arrivedBanner).toBe(false);
      expect(onClear).not.toHaveBeenCalled();
    });
  });
});
