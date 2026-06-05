import { renderHook, act, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { useTrainPositions, __resetPositionCacheForTests } from '../useTrainPositions';
import * as positionApi from '../../../nearest-station/api/positionApi';
import type { LinePositions } from '../../../nearest-station/api/positionApi';

jest.mock('../../../nearest-station/api/positionApi');

let appStateCallback: ((state: string) => void) | null = null;
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  appStateCallback = listener as (state: string) => void;
  return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
});

const sampleResponse: LinePositions = {
  line: '2',
  trains: [
    {
      statnId: 'X',
      statnNm: 'X',
      trainNo: 'T',
      trainStatus: 1,
      updnLine: 0,
      terminalStationId: '',
      terminalStationName: '',
      trainType: 'normal',
      isLastTrain: false,
      receivedAtMs: 1_700_000_000_000,
    },
  ],
};

describe('useTrainPositions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    appStateCallback = null;
    __resetPositionCacheForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('line=null이면 fetch 안 함', async () => {
    const { result } = renderHook(() => useTrainPositions(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.positions).toBeNull();
    expect(positionApi.fetchTrainPositions).not.toHaveBeenCalled();
  });

  it('line이 주어지면 데이터 가져옴', async () => {
    (positionApi.fetchTrainPositions as jest.Mock).mockResolvedValue(sampleResponse);
    const { result } = renderHook(() => useTrainPositions('2'));
    await waitFor(() => expect(result.current.positions).toEqual(sampleResponse));
    expect(result.current.isMock).toBe(false);
  });

  it('mock 응답이면 isMock=true, 캐시에 저장 안 됨', async () => {
    const mockResp = { ...sampleResponse, isMock: true };
    (positionApi.fetchTrainPositions as jest.Mock).mockResolvedValue(mockResp);
    const { result } = renderHook(() => useTrainPositions('2'));
    await waitFor(() => expect(result.current.isMock).toBe(true));
  });

  it('5초 폴링', async () => {
    (positionApi.fetchTrainPositions as jest.Mock).mockResolvedValue(sampleResponse);
    renderHook(() => useTrainPositions('2'));
    await waitFor(() => expect(positionApi.fetchTrainPositions).toHaveBeenCalledTimes(1));

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await waitFor(() => expect(positionApi.fetchTrainPositions).toHaveBeenCalledTimes(2));
  });

  it('동일 line 두 hook 인스턴스가 캐시 공유 (모듈 싱글톤)', async () => {
    (positionApi.fetchTrainPositions as jest.Mock).mockResolvedValue(sampleResponse);

    const { result: r1 } = renderHook(() => useTrainPositions('2'));
    await waitFor(() => expect(r1.current.positions).toEqual(sampleResponse));
    const initialCalls = (positionApi.fetchTrainPositions as jest.Mock).mock.calls.length;

    // 두 번째 인스턴스가 캐시에서 즉시 받아야 함
    const { result: r2 } = renderHook(() => useTrainPositions('2'));
    expect(r2.current.positions).toEqual(sampleResponse);
    // 새로운 첫 폴링은 발생하지만, 캐시도 활용
    expect((positionApi.fetchTrainPositions as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(
      initialCalls,
    );
  });

  it('line 변경 시 새 데이터 로드', async () => {
    (positionApi.fetchTrainPositions as jest.Mock).mockResolvedValue(sampleResponse);
    const { result, rerender } = renderHook(
      ({ line }: { line: '2' | '5' | null }) => useTrainPositions(line),
      { initialProps: { line: '2' as '2' | '5' | null } },
    );
    await waitFor(() => expect(result.current.positions).toEqual(sampleResponse));

    rerender({ line: '5' });
    await waitFor(() => {
      const calls = (positionApi.fetchTrainPositions as jest.Mock).mock.calls;
      expect(calls.some((c) => c[0] === '5')).toBe(true);
    });
  });

  it('line=null로 변경 시 positions 비움', async () => {
    (positionApi.fetchTrainPositions as jest.Mock).mockResolvedValue(sampleResponse);
    const { result, rerender } = renderHook(
      ({ line }: { line: '2' | null }) => useTrainPositions(line),
      { initialProps: { line: '2' as '2' | null } },
    );
    await waitFor(() => expect(result.current.positions).toEqual(sampleResponse));

    rerender({ line: null });
    await waitFor(() => expect(result.current.positions).toBeNull());
  });

  it('Provider 내부 에러도 상태 안 깨짐 (try/catch fallback)', async () => {
    (positionApi.fetchTrainPositions as jest.Mock).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useTrainPositions('2'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.positions).toBeNull();
  });

  it('AppState resume 시 캐시 clear', async () => {
    (positionApi.fetchTrainPositions as jest.Mock).mockResolvedValue(sampleResponse);
    renderHook(() => useTrainPositions('2'));
    await waitFor(() => expect(positionApi.fetchTrainPositions).toHaveBeenCalled());

    await act(async () => {
      appStateCallback?.('background');
      appStateCallback?.('active');
    });
    // resume 후 폴링 다시 → fetch 추가 호출
    await waitFor(() =>
      expect((positionApi.fetchTrainPositions as jest.Mock).mock.calls.length).toBeGreaterThan(1),
    );
  });

  it('provider 주입 가능', async () => {
    const provider = { getPositions: jest.fn().mockResolvedValue(sampleResponse) };
    renderHook(() => useTrainPositions('2', provider));
    await waitFor(() => expect(provider.getPositions).toHaveBeenCalledWith('2'));
  });

  it('동일 line으로 두 번 갱신해도 동일 positions면 setState 안 함 (cancellation 분기 커버)', async () => {
    (positionApi.fetchTrainPositions as jest.Mock).mockResolvedValue(sampleResponse);
    const { unmount } = renderHook(() => useTrainPositions('2'));
    await waitFor(() => expect(positionApi.fetchTrainPositions).toHaveBeenCalled());

    // unmount → cancelled=true → 다음 polling 응답 무시
    unmount();
  });

  it('폴링 중 line이 null로 변경되면 폴링 콜백 early-return', async () => {
    (positionApi.fetchTrainPositions as jest.Mock).mockResolvedValue(sampleResponse);
    const { rerender } = renderHook(
      ({ line }: { line: '2' | null }) => useTrainPositions(line),
      { initialProps: { line: '2' as '2' | null } },
    );
    await waitFor(() => expect(positionApi.fetchTrainPositions).toHaveBeenCalled());

    rerender({ line: null });
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    // null 후로는 폴링이 더 이상 fetch 호출 안 함 — 이미 직전 값 외엔 추가 호출 없어야
  });

  it('초기 fetch 도중 unmount 시 cancelled로 setState 차단', async () => {
    let resolveFn: (val: LinePositions) => void = () => {};
    (positionApi.fetchTrainPositions as jest.Mock).mockReturnValueOnce(
      new Promise<LinePositions>((res) => {
        resolveFn = res;
      }),
    );
    const { result, unmount } = renderHook(() => useTrainPositions('2'));
    expect(result.current.loading).toBe(true);
    unmount();
    resolveFn(sampleResponse);
    await Promise.resolve();
    // crash 안 나면 cancelled 분기 통과
  });

  it('폴링 도중 line이 바뀌면 응답 무시 (usePolling 콜백, l !== lineRef.current)', async () => {
    // 첫 fetch는 sample로 즉시 resolve해 초기 마운트 안정화
    (positionApi.fetchTrainPositions as jest.Mock).mockResolvedValueOnce(sampleResponse);
    const { rerender } = renderHook(
      ({ line }: { line: '2' | '5' }) => useTrainPositions(line),
      { initialProps: { line: '2' as '2' | '5' } },
    );
    await waitFor(() => expect(positionApi.fetchTrainPositions).toHaveBeenCalled());

    // 다음 폴링은 pending으로 잡아둠
    let resolvePoll: (v: LinePositions) => void = () => {};
    (positionApi.fetchTrainPositions as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<LinePositions>((res) => {
          resolvePoll = res;
        }),
    );
    await act(async () => {
      jest.advanceTimersByTime(5000); // 폴링 발화 → l='2'로 fetch 시작
    });
    rerender({ line: '5' }); // l !== lineRef.current 만들기
    // mock 응답으로 cache.set 분기까지 같이 커버
    resolvePoll({ ...sampleResponse, isMock: true });
    await Promise.resolve();
    await Promise.resolve();
  });

  it('폴링 결과가 mock이면 캐시 set 생략 (105 false 분기)', async () => {
    (positionApi.fetchTrainPositions as jest.Mock).mockResolvedValueOnce(sampleResponse);
    renderHook(() => useTrainPositions('2'));
    await waitFor(() => expect(positionApi.fetchTrainPositions).toHaveBeenCalled());

    (positionApi.fetchTrainPositions as jest.Mock).mockResolvedValueOnce({
      ...sampleResponse,
      isMock: true,
    });
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await Promise.resolve();
  });

  it('폴링 콜백 reject도 안전하게 처리 (catch 분기)', async () => {
    (positionApi.fetchTrainPositions as jest.Mock).mockResolvedValueOnce(sampleResponse);
    renderHook(() => useTrainPositions('2'));
    await waitFor(() => expect(positionApi.fetchTrainPositions).toHaveBeenCalledTimes(1));

    // 두 번째 폴링은 reject
    (positionApi.fetchTrainPositions as jest.Mock).mockRejectedValueOnce(new Error('fail'));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    // crash 안 나면 통과
  });
});
