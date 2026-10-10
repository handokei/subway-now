import { renderHook, waitFor } from '@testing-library/react-native';
import { useStationExits } from '../useStationExits';
import type { ExitInfoProvider } from '../../providers/types';
import type { ExitInfo } from '../../../../shared/types/exitInfo';
import type { LineNumber } from '../../../../shared/types/station';

function makeProvider(exits: ExitInfo[]): ExitInfoProvider {
  return {
    getExits: jest.fn(async () => exits),
  };
}

const gangnamExits: ExitInfo[] = [
  { stationName: '강남', line: '2', exitNumber: '1', facilities: ['국기원'] },
  { stationName: '강남', line: '2', exitNumber: '6', facilities: ['교보타워'] },
  { stationName: '강남', line: '2', exitNumber: '10', facilities: ['뉴욕제과', '강남대로 버스환승센터'] },
];

describe('useStationExits', () => {
  it('stationName 또는 line이 null이면 빈 결과', async () => {
    const provider = makeProvider(gangnamExits);
    const { result } = renderHook(() =>
      useStationExits({ stationName: null, line: '2', provider }),
    );
    expect(result.current.exits).toEqual([]);
    expect(result.current.ranked).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(provider.getExits).not.toHaveBeenCalled();
  });

  it('line이 null이어도 호출하지 않는다', () => {
    const provider = makeProvider(gangnamExits);
    renderHook(() =>
      useStationExits({ stationName: '강남', line: null, provider }),
    );
    expect(provider.getExits).not.toHaveBeenCalled();
  });

  it('역+노선이 주어지면 provider를 호출하고 결과를 반환한다', async () => {
    const provider = makeProvider(gangnamExits);
    const { result } = renderHook(() =>
      useStationExits({ stationName: '강남', line: '2', provider }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.exits).toEqual(gangnamExits);
    expect(provider.getExits).toHaveBeenCalledWith('강남', '2');
  });

  it('destination 없으면 ranked는 원본 순서 + matchesDestination=false', async () => {
    const provider = makeProvider(gangnamExits);
    const { result } = renderHook(() =>
      useStationExits({ stationName: '강남', line: '2', provider }),
    );
    await waitFor(() => expect(result.current.ranked.length).toBe(3));
    expect(result.current.ranked.map((r) => r.exit.exitNumber)).toEqual(['1', '6', '10']);
    expect(result.current.ranked.every((r) => !r.matchesDestination)).toBe(true);
  });

  it('destination이 facilities에 포함된 출구를 앞으로 정렬', async () => {
    const provider = makeProvider(gangnamExits);
    const { result } = renderHook(() =>
      useStationExits({
        stationName: '강남',
        line: '2',
        destination: '교보타워',
        provider,
      }),
    );
    await waitFor(() => expect(result.current.ranked.length).toBe(3));
    expect(result.current.ranked[0]?.exit.exitNumber).toBe('6');
    expect(result.current.ranked[0]?.matchesDestination).toBe(true);
    expect(result.current.ranked.slice(1).every((r) => !r.matchesDestination)).toBe(true);
  });

  it('destination이 빈 문자열/공백이면 매칭하지 않는다', async () => {
    const provider = makeProvider(gangnamExits);
    const { result } = renderHook(() =>
      useStationExits({
        stationName: '강남',
        line: '2',
        destination: '   ',
        provider,
      }),
    );
    await waitFor(() => expect(result.current.ranked.length).toBe(3));
    expect(result.current.ranked.every((r) => !r.matchesDestination)).toBe(true);
  });

  it('provider 실패 시 빈 결과로 fallback', async () => {
    const provider: ExitInfoProvider = {
      getExits: jest.fn(async () => {
        throw new Error('boom');
      }),
    };
    const { result } = renderHook(() =>
      useStationExits({ stationName: '강남', line: '2', provider }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.exits).toEqual([]);
  });

  it('stationName이 바뀌면 재조회', async () => {
    const provider = makeProvider(gangnamExits);
    const { result, rerender } = renderHook(
      ({ stationName, line }: { stationName: string | null; line: LineNumber | null }) =>
        useStationExits({ stationName, line, provider }),
      { initialProps: { stationName: '강남', line: '2' as LineNumber | null } },
    );
    await waitFor(() => expect(result.current.exits.length).toBe(3));
    rerender({ stationName: '시청', line: '1' });
    await waitFor(() => expect(provider.getExits).toHaveBeenCalledWith('시청', '1'));
  });

  it('unmount 후 resolve된 promise는 상태를 갱신하지 않는다', async () => {
    let resolveFn: (v: ExitInfo[]) => void = () => undefined;
    const provider: ExitInfoProvider = {
      getExits: jest.fn(
        () =>
          new Promise<ExitInfo[]>((resolve) => {
            resolveFn = resolve;
          }),
      ),
    };
    const { unmount } = renderHook(() =>
      useStationExits({ stationName: '강남', line: '2', provider }),
    );
    unmount();
    // resolve 후에도 throw 없이 통과해야 한다.
    resolveFn(gangnamExits);
    await Promise.resolve();
  });

  it('unmount 후 reject된 promise도 silent fail', async () => {
    let rejectFn: (e: Error) => void = () => undefined;
    const provider: ExitInfoProvider = {
      getExits: jest.fn(
        () =>
          new Promise<ExitInfo[]>((_, reject) => {
            rejectFn = reject;
          }),
      ),
    };
    const { unmount } = renderHook(() =>
      useStationExits({ stationName: '강남', line: '2', provider }),
    );
    unmount();
    rejectFn(new Error('late'));
    await Promise.resolve();
  });

  it('기본 provider(MockExitInfoProvider)로도 동작', async () => {
    const { result } = renderHook(() =>
      useStationExits({ stationName: '강남', line: '2' }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    // sample fixture에 강남 2호선 출구가 들어있다.
    expect(result.current.exits.length).toBeGreaterThan(0);
  });
});
