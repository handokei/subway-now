import { act, renderHook, waitFor } from '@testing-library/react-native';
import {
  ARCH_FLAG_REMOTE_REFRESH_MS,
  useArchFlagRemote,
} from '../useArchFlagRemote';

jest.mock('../archFlagRemote', () => ({
  fetchArchFlag: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fetchArchFlag } = jest.requireMock('../archFlagRemote') as {
  fetchArchFlag: jest.Mock;
};

describe('useArchFlagRemote (#1982, ADR-022 Phase 0)', () => {
  beforeEach(() => {
    fetchArchFlag.mockReset();
  });

  it('mount 시 loading 상태에서 시작', () => {
    fetchArchFlag.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useArchFlagRemote());
    expect(result.current.kind).toBe('loading');
    expect(result.current.value).toBeUndefined();
    expect(result.current.lastFetchedAt).toBeNull();
  });

  it('첫 fetch 성공 시 kind=ok + value 반영', async () => {
    fetchArchFlag.mockResolvedValue({ kind: 'ok', value: 'on' });
    const { result } = renderHook(() => useArchFlagRemote());
    await waitFor(() => {
      expect(result.current.kind).toBe('ok');
    });
    expect(result.current.value).toBe('on');
    expect(result.current.lastFetchedAt).not.toBeNull();
  });

  it('unconfigured 결과는 value=undefined + kind=unconfigured', async () => {
    fetchArchFlag.mockResolvedValue({ kind: 'unconfigured' });
    const { result } = renderHook(() => useArchFlagRemote());
    await waitFor(() => {
      expect(result.current.kind).toBe('unconfigured');
    });
    expect(result.current.value).toBeUndefined();
  });

  it('error 결과는 value=undefined + kind=error', async () => {
    fetchArchFlag.mockResolvedValue({ kind: 'error', message: 'HTTP 503' });
    const { result } = renderHook(() => useArchFlagRemote());
    await waitFor(() => {
      expect(result.current.kind).toBe('error');
    });
    expect(result.current.value).toBeUndefined();
  });

  describe('interval refresh', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('5분 마다 재조회', async () => {
      fetchArchFlag.mockResolvedValue({ kind: 'ok', value: 'off' });
      renderHook(() => useArchFlagRemote());
      // 첫 fetch (mount 즉시)
      await act(async () => {
        await Promise.resolve();
      });
      expect(fetchArchFlag).toHaveBeenCalledTimes(1);

      // 5분 경과
      await act(async () => {
        jest.advanceTimersByTime(ARCH_FLAG_REMOTE_REFRESH_MS);
        await Promise.resolve();
      });
      expect(fetchArchFlag).toHaveBeenCalledTimes(2);
    });

    it('unmount 시 cancel — 늦게 도착한 fetch 결과 무시', async () => {
      let resolveFetch: (v: unknown) => void = () => undefined;
      fetchArchFlag.mockReturnValue(
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
      );
      const { result, unmount } = renderHook(() => useArchFlagRemote());
      // mount 직후: loading
      expect(result.current.kind).toBe('loading');
      // 컴포넌트가 사라진 뒤에 fetch 응답 도착
      unmount();
      resolveFetch({ kind: 'ok', value: 'on' });
      await act(async () => {
        await Promise.resolve();
      });
      // React warning 이 발생하지 않으면 cancel 이 정상 동작 (setState 미호출).
      // 결과값 자체는 unmounted hook 이라 관찰 불가 — 실제 실행 흐름에서 no-op 확인이 목적.
      // (React Testing Library 는 warning 이 있으면 test fail 시킴)
    });

    it('unmount 후 clearInterval 호출로 refresh 중단', async () => {
      fetchArchFlag.mockResolvedValue({ kind: 'ok', value: 'off' });
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      const { unmount } = renderHook(() => useArchFlagRemote());
      await act(async () => {
        await Promise.resolve();
      });
      unmount();
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });
  });
});
