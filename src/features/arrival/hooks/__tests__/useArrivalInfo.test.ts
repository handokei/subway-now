import { renderHook, act, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { prefetchArrival, useArrivalInfo, __resetArrivalCacheForTests } from '../useArrivalInfo';
import * as arrivalApiModule from '../../api/arrivalApi';

jest.mock('../../api/arrivalApi');

const mockRemove = jest.fn();
let appStateCallback: ((state: string) => void) | null = null;
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  appStateCallback = listener as (state: string) => void;
  return { remove: mockRemove } as unknown as ReturnType<typeof AppState.addEventListener>;
});

const mockArrival = {
  up: [{ destination: '소요산행', arrivalMinutes: 2, arrivalSeconds: 120, statusMessage: '전역 출발', trainCode: 'T001', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' }],
  down: [{ destination: '인천행', arrivalMinutes: 5, arrivalSeconds: 300, statusMessage: '', trainCode: 'T002', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' }],
};

const mockArrivalWithMock = {
  ...mockArrival,
  isMock: true,
};

describe('useArrivalInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    appStateCallback = null;
    __resetArrivalCacheForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stationName이 null이면 arrival은 null이다', async () => {
    const { result } = renderHook(() => useArrivalInfo(null));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.arrival).toBeNull();
    expect(result.current.isMock).toBe(false);
    expect(arrivalApiModule.fetchArrivalInfo).not.toHaveBeenCalled();
  });

  it('stationName이 주어지면 arrival 데이터를 가져온다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result } = renderHook(() => useArrivalInfo('강남'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.arrival).toEqual(mockArrival);
    expect(result.current.isMock).toBe(false);
  });

  it('isMock이 true인 데이터를 받으면 isMock이 true이다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrivalWithMock);

    const { result } = renderHook(() => useArrivalInfo('강남'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.arrival).toEqual(mockArrivalWithMock);
    expect(result.current.isMock).toBe(true);
  });

  it('5초 인터벌 후 자동으로 도착 정보를 갱신한다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    renderHook(() => useArrivalInfo('강남'));

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(1)
    );

    act(() => {
      jest.advanceTimersByTime(5_000);
    });

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(2)
    );
  });

  it('lineHint가 주어지면 provider에 그대로 전달한다 (환승역 fallback 정확도)', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    renderHook(() => useArrivalInfo('서울역', '4'));

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledWith('서울역', { lineHint: '4' })
    );
  });

  it('lineHint가 null이면 undefined로 전달한다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    renderHook(() => useArrivalInfo('강남', null));

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledWith('강남', { lineHint: undefined })
    );
  });

  it('stationName이 변경되면 새로운 역의 데이터를 가져온다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { rerender } = renderHook(
      ({ name }: { name: string | null }) => useArrivalInfo(name),
      { initialProps: { name: '강남' as string | null } }
    );

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledWith('강남', { lineHint: undefined })
    );

    rerender({ name: '역삼' });

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledWith('역삼', { lineHint: undefined })
    );
  });

  it('언마운트 시 interval이 정리된다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const { unmount } = renderHook(() => useArrivalInfo('강남'));

    await waitFor(() =>
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(1)
    );

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('언마운트 후 fetch 응답이 도착하면 상태를 갱신하지 않는다', async () => {
    let resolve!: (value: typeof mockArrival) => void;
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockImplementation(
      () => new Promise((r) => { resolve = r; })
    );

    const { result, unmount } = renderHook(() => useArrivalInfo('강남'));

    expect(result.current.loading).toBe(true);

    unmount();
    resolve(mockArrival);
    await Promise.resolve();

    expect(result.current.arrival).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('같은 역 재진입 시 캐시 데이터를 즉시 표시한다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result, rerender } = renderHook(
      ({ name }: { name: string | null }) => useArrivalInfo(name),
      { initialProps: { name: '강남' as string | null } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.arrival).toEqual(mockArrival);

    // 다른 역으로 전환
    rerender({ name: '역삼' });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 다시 강남으로 복귀 — 캐시 즉시 표시
    rerender({ name: '강남' });
    expect(result.current.arrival).toEqual(mockArrival);
    expect(result.current.loading).toBe(false);
  });

  it('캐시가 없는 새 역은 loading이 true로 시작한다', async () => {
    let resolveFirst!: (value: typeof mockArrival) => void;
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockImplementation(
      () => new Promise((r) => { resolveFirst = r; })
    );

    const { result } = renderHook(() => useArrivalInfo('신규역'));

    expect(result.current.arrival).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => { resolveFirst(mockArrival); });

    expect(result.current.arrival).toEqual(mockArrival);
    expect(result.current.loading).toBe(false);
  });

  it('캐시 표시 후 백그라운드 갱신이 데이터를 업데이트한다', async () => {
    const updatedArrival = {
      up: [{ destination: '소요산행', arrivalMinutes: 5, arrivalSeconds: 300, statusMessage: '', trainCode: 'T001', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' }],
      down: [{ destination: '인천행', arrivalMinutes: 8, arrivalSeconds: 480, statusMessage: '', trainCode: 'T002', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' }],
    };

    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result, rerender } = renderHook(
      ({ name }: { name: string | null }) => useArrivalInfo(name),
      { initialProps: { name: '강남' as string | null } }
    );

    await waitFor(() => expect(result.current.arrival).toEqual(mockArrival));

    // 다른 역으로 갔다가 복귀
    rerender({ name: '역삼' });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 복귀 시 새로운 데이터로 갱신
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(updatedArrival);
    rerender({ name: '강남' });

    // 캐시 즉시 표시
    expect(result.current.arrival).toEqual(mockArrival);

    // 백그라운드 fetch 완료 후 갱신
    await waitFor(() => expect(result.current.arrival).toEqual(updatedArrival));
  });

  it('stationName이 유효한 값에서 null로 바뀌면 loading이 false가 된다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result, rerender } = renderHook(
      ({ name }: { name: string | null }) => useArrivalInfo(name),
      { initialProps: { name: '강남' as string | null } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.arrival).toEqual(mockArrival);

    rerender({ name: null });

    await waitFor(() => {
      expect(result.current.arrival).toBeNull();
      expect(result.current.loading).toBe(false);
    });
  });

  it('백그라운드 전환 시 폴링을 중지한다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

    renderHook(() => useArrivalInfo('강남'));
    await waitFor(() => expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(1));

    act(() => { appStateCallback?.('background'); });
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('포그라운드 복귀 시 폴링을 재개한다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    renderHook(() => useArrivalInfo('강남'));
    await waitFor(() => expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(1));

    act(() => { appStateCallback?.('background'); });
    act(() => { appStateCallback?.('active'); });
    await waitFor(() => expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(2));
  });

  it('언마운트 시 AppState 리스너를 해제한다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { unmount } = renderHook(() => useArrivalInfo('강남'));
    await waitFor(() => expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledTimes(1));

    unmount();
    expect(mockRemove).toHaveBeenCalled();
  });

  it('TTL 만료 시 캐시를 사용하지 않고 loading 상태로 전환한다', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result, rerender } = renderHook(
      ({ name }: { name: string | null }) => useArrivalInfo(name),
      { initialProps: { name: '강남' as string | null } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // 다른 역으로 전환
    rerender({ name: '역삼' });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // TTL 초과 후 강남 복귀
    jest.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    rerender({ name: '강남' });

    // TTL 만료 → 캐시 미사용 → loading 상태
    expect(result.current.arrival).toBeNull();
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    jest.restoreAllMocks();
  });

  it('stationName이 null일 때 폴링 콜백은 fetch하지 않는다', async () => {
    renderHook(() => useArrivalInfo(null));

    jest.advanceTimersByTime(5_000);
    await Promise.resolve();

    expect(arrivalApiModule.fetchArrivalInfo).not.toHaveBeenCalled();
  });

  it('폴링 중 stationName이 변경되면 이전 폴링 응답을 무시한다', async () => {
    const staleArrival = {
      up: [{ destination: '이전역', arrivalMinutes: 99, arrivalSeconds: 5940, statusMessage: '', trainCode: 'OLD', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' }],
      down: [],
    };
    const freshArrival = {
      up: [{ destination: '새역', arrivalMinutes: 1, arrivalSeconds: 60, statusMessage: '', trainCode: 'NEW', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' }],
      down: [],
    };

    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(freshArrival);

    const { result, rerender } = renderHook(
      ({ name }: { name: string | null }) => useArrivalInfo(name),
      { initialProps: { name: '강남' as string | null } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // 폴링 콜백에서 느린 fetch가 시작되도록 설정
    let resolvePollingFetch!: (value: typeof staleArrival) => void;
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockImplementation(
      (name: string) => {
        if (name === '강남') {
          return new Promise((r) => { resolvePollingFetch = r; });
        }
        return Promise.resolve(freshArrival);
      }
    );

    // 폴링 트리거 → '강남'에 대한 느린 fetch 시작
    act(() => { jest.advanceTimersByTime(5_000); });

    // 역 변경 → stationNameRef.current가 '역삼'으로 바뀜
    rerender({ name: '역삼' });
    await waitFor(() => expect(result.current.arrival).toEqual(freshArrival));

    // 이전 폴링의 '강남' 응답 도착 → name !== stationNameRef.current → 무시
    await act(async () => { resolvePollingFetch(staleArrival); });

    expect(result.current.arrival).toEqual(freshArrival);
  });

  it('폴링 콜백에서 mock 데이터를 받으면 캐시에 저장하지 않는다', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result } = renderHook(() => useArrivalInfo('강남'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.arrival).toEqual(mockArrival);

    // 폴링에서 mock 데이터 반환 → 캐시에 저장 안 됨
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrivalWithMock);

    act(() => { jest.advanceTimersByTime(5_000); });
    await waitFor(() => expect(result.current.isMock).toBe(true));
    // mock 데이터가 arrival에 반영되었지만 캐시에는 이전 실제 데이터만 있음
    expect(result.current.arrival).toEqual(mockArrivalWithMock);

    jest.restoreAllMocks();
  });

  it('폴링 콜백에서 fetch 실패 시 에러를 무시한다', async () => {
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result } = renderHook(() => useArrivalInfo('강남'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 폴링에서 에러 발생
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockRejectedValue(new Error('network'));

    act(() => { jest.advanceTimersByTime(5_000); });
    await Promise.resolve();

    // 에러 무시 — 기존 데이터 유지
    expect(result.current.arrival).toEqual(mockArrival);
  });

  describe('prefetchArrival (#814)', () => {
    it('stationName이 null이면 fetch하지 않는다', async () => {
      await prefetchArrival(null, '5');
      expect(arrivalApiModule.fetchArrivalInfo).not.toHaveBeenCalled();
    });

    it('cache miss 시 fetch + cache에 저장 — 다음 useArrivalInfo 마운트에서 cache hit', async () => {
      (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

      await prefetchArrival('공덕', '5');
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledWith('공덕', { lineHint: '5' });

      // 후속 useArrivalInfo 마운트는 cache hit으로 loading=false 즉시 표시.
      const { result } = renderHook(() => useArrivalInfo('공덕', '5'));
      expect(result.current.arrival).toEqual(mockArrival);
      expect(result.current.loading).toBe(false);
    });

    it('cache가 valid면 no-op — 중복 네트워크 호출 방지', async () => {
      (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

      await prefetchArrival('공덕', '5');
      const firstCalls = (arrivalApiModule.fetchArrivalInfo as jest.Mock).mock.calls.length;
      await prefetchArrival('공덕', '5');
      expect((arrivalApiModule.fetchArrivalInfo as jest.Mock).mock.calls.length).toBe(firstCalls);
    });

    it('lineHint=null이면 undefined로 provider에 전달', async () => {
      (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);
      await prefetchArrival('공덕', null);
      expect(arrivalApiModule.fetchArrivalInfo).toHaveBeenCalledWith('공덕', { lineHint: undefined });
    });

    it('mock 데이터는 cache에 저장하지 않는다', async () => {
      (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrivalWithMock);
      await prefetchArrival('공덕', '5');
      // 같은 station에 한 번 더 prefetch — cache가 비어 있으므로 다시 fetch 발생
      await prefetchArrival('공덕', '5');
      expect((arrivalApiModule.fetchArrivalInfo as jest.Mock).mock.calls.length).toBe(2);
    });

    it('fetch 실패는 silent하게 무시한다 — 다음 폴링이 재시도', async () => {
      (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockRejectedValue(new Error('network'));
      await expect(prefetchArrival('공덕', '5')).resolves.toBeUndefined();
    });
  });

  describe('refetch (#814)', () => {
    it('refetch 호출 시 polling 주기를 기다리지 않고 즉시 fetch한다', async () => {
      (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);
      const { result } = renderHook(() => useArrivalInfo('강남'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      const initialCalls = (arrivalApiModule.fetchArrivalInfo as jest.Mock).mock.calls.length;
      act(() => result.current.refetch());
      await waitFor(() =>
        expect((arrivalApiModule.fetchArrivalInfo as jest.Mock).mock.calls.length).toBeGreaterThan(
          initialCalls,
        ),
      );
    });

    it('stationName이 null이면 refetch는 no-op', async () => {
      const { result } = renderHook(() => useArrivalInfo(null));
      await waitFor(() => expect(result.current.loading).toBe(false));
      act(() => result.current.refetch());
      expect(arrivalApiModule.fetchArrivalInfo).not.toHaveBeenCalled();
    });
  });

  it('포그라운드 복귀 시 캐시를 클리어하고 fresh fetch한다', async () => {
    const freshArrival = {
      up: [{ destination: '소요산행', arrivalMinutes: 1, arrivalSeconds: 60, statusMessage: '', trainCode: 'T003', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' }],
      down: [{ destination: '인천행', arrivalMinutes: 3, arrivalSeconds: 180, statusMessage: '', trainCode: 'T004', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' }],
    };
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);

    const { result } = renderHook(() => useArrivalInfo('강남'));
    await waitFor(() => expect(result.current.arrival).toEqual(mockArrival));

    // 백그라운드 → 포그라운드 복귀 시 새 데이터
    (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(freshArrival);
    act(() => { appStateCallback?.('background'); });
    act(() => { appStateCallback?.('active'); });

    await waitFor(() => expect(result.current.arrival).toEqual(freshArrival));
  });

  // #1400 — 캐시 키는 (stationName, lineHint) 튜플로 호선별 격리되어야 한다.
  // BFF 실시간 응답은 호선 무관 동일하지만 schedule fallback은 호선별로 달라지므로
  // 호선 무관 키로 캐싱하면 직전 호선의 fallback이 다음 호선 폴링에도 잔존한다.
  describe('cache key by (stationName, lineHint) (#1400)', () => {
    it('같은 stationName 다른 lineHint는 캐시를 공유하지 않는다 (호선별 격리)', async () => {
      const arrivalLine2 = {
        up: [{ destination: '내선순환', arrivalMinutes: 2, arrivalSeconds: 120, statusMessage: '', trainCode: 'L2-A', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' }],
        down: [],
      };
      const arrivalLine3 = {
        up: [{ destination: '대화행', arrivalMinutes: 3, arrivalSeconds: 180, statusMessage: '', trainCode: 'L3-B', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' }],
        down: [],
      };

      // line=2 prefetch — line=2 응답을 그 키에만 적재.
      (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(arrivalLine2);
      await prefetchArrival('교대', '2');
      const callsAfterLine2 = (arrivalApiModule.fetchArrivalInfo as jest.Mock).mock.calls.length;

      // line=3 prefetch — line=2 캐시는 미적용. 다시 fetch가 발생해야 한다.
      (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(arrivalLine3);
      await prefetchArrival('교대', '3');
      expect((arrivalApiModule.fetchArrivalInfo as jest.Mock).mock.calls.length).toBeGreaterThan(callsAfterLine2);

      // line=3로 마운트하면 line=3 캐시(arrivalLine3) hit이 노출되어야 함.
      const { result } = renderHook(() => useArrivalInfo('교대', '3'));
      expect(result.current.arrival).toEqual(arrivalLine3);
    });

    it('같은 (stationName, lineHint) 재사용은 캐시 hit', async () => {
      (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);
      await prefetchArrival('교대', '2');
      const callsAfterFirst = (arrivalApiModule.fetchArrivalInfo as jest.Mock).mock.calls.length;

      // 같은 (stationName, lineHint) prefetch는 캐시 hit으로 fetch 미발생.
      await prefetchArrival('교대', '2');
      expect((arrivalApiModule.fetchArrivalInfo as jest.Mock).mock.calls.length).toBe(callsAfterFirst);
    });

    it('lineHint=null과 lineHint="2"는 서로 다른 캐시 키', async () => {
      (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(mockArrival);
      await prefetchArrival('교대', null);
      const callsAfterNull = (arrivalApiModule.fetchArrivalInfo as jest.Mock).mock.calls.length;

      // null 캐시는 line='2'에 사용되지 않으므로 새 fetch가 발생.
      await prefetchArrival('교대', '2');
      expect((arrivalApiModule.fetchArrivalInfo as jest.Mock).mock.calls.length).toBeGreaterThan(callsAfterNull);
    });

    it('lineHint가 바뀌면 직전 호선의 캐시 데이터가 표시되지 않는다', async () => {
      const arrivalLine2 = {
        up: [{ destination: '내선순환', arrivalMinutes: 2, arrivalSeconds: 120, statusMessage: '', trainCode: 'L2-A', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' }],
        down: [],
      };
      // line=2 캐시 채워 둠.
      (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockResolvedValue(arrivalLine2);
      await prefetchArrival('교대', '2');

      // 같은 station을 line=3으로 mount — line=2 cache는 hit 안 됨.
      // 그 사이 mock을 막혀(pending) 상태로 둬 cache가 진짜 비어있는지(loading=true) 확인.
      let resolveLine3!: (v: typeof mockArrival) => void;
      (arrivalApiModule.fetchArrivalInfo as jest.Mock).mockImplementation(
        () => new Promise((r) => { resolveLine3 = r; })
      );
      const { result } = renderHook(() => useArrivalInfo('교대', '3'));
      // 캐시 miss → loading=true, arrival=null.
      expect(result.current.arrival).toBeNull();
      expect(result.current.loading).toBe(true);

      // fetch 완료 후 line=3 데이터로 표시.
      await act(async () => { resolveLine3(mockArrival); });
      expect(result.current.arrival).toEqual(mockArrival);
    });
  });
});
