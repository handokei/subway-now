import { act, renderHook } from '@testing-library/react-native';

const mockRunCycle = jest.fn();
jest.mock('../../utils/lastTrainAlarm', () => ({
  runLastTrainAlarmCycle: (...args: unknown[]) => mockRunCycle(...args),
}));

import { useLastTrainAlarm } from '../useLastTrainAlarm';
import type { Station } from '../../../../shared/types/station';
import type { Route } from '../../../../shared/utils/stationRoute';

const origin: Station = {
  id: '1-001',
  name: '소요산',
  line: '1',
  lineColor: '#0052A4',
  lat: 0,
  lng: 0,
};
const destination: Station = { ...origin, id: '1-002', name: '동두천' };
const route = {} as Route;

beforeEach(() => {
  jest.clearAllMocks();
  mockRunCycle.mockResolvedValue(false);
});

describe('useLastTrainAlarm', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('마운트 직후 1회 즉시 호출', () => {
    renderHook(() =>
      useLastTrainAlarm({
        sleepMode: true,
        origin,
        destination,
        route,
        intervalMs: 1_000,
      }),
    );
    expect(mockRunCycle).toHaveBeenCalledTimes(1);
    expect(mockRunCycle).toHaveBeenCalledWith(
      expect.objectContaining({
        sleepMode: true,
        origin,
        destination,
        route,
      }),
    );
  });

  it('intervalMs마다 추가 호출', () => {
    renderHook(() =>
      useLastTrainAlarm({
        sleepMode: true,
        origin,
        destination,
        route,
        intervalMs: 1_000,
      }),
    );
    expect(mockRunCycle).toHaveBeenCalledTimes(1);
    act(() => {
      jest.advanceTimersByTime(2_500);
    });
    expect(mockRunCycle).toHaveBeenCalledTimes(3);
  });

  it('intervalMs <= 0이면 effect skip', () => {
    renderHook(() =>
      useLastTrainAlarm({
        sleepMode: true,
        origin,
        destination,
        route,
        intervalMs: 0,
      }),
    );
    expect(mockRunCycle).not.toHaveBeenCalled();
  });

  it('intervalMs 미지정 시 기본값 60s 사용', () => {
    renderHook(() => useLastTrainAlarm({ sleepMode: true, origin, destination, route }));
    expect(mockRunCycle).toHaveBeenCalledTimes(1);
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(mockRunCycle).toHaveBeenCalledTimes(2);
  });

  it('unmount 시 interval 정리', () => {
    const { unmount } = renderHook(() =>
      useLastTrainAlarm({
        sleepMode: true,
        origin,
        destination,
        route,
        intervalMs: 1_000,
      }),
    );
    unmount();
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(mockRunCycle).toHaveBeenCalledTimes(1);
  });

  it('rerender 시 최신 props가 다음 tick에 전달 (interval은 재시작 X)', () => {
    const { rerender } = renderHook(
      ({ sleepMode }: { sleepMode: boolean }) =>
        useLastTrainAlarm({ sleepMode, origin, destination, route, intervalMs: 1_000 }),
      { initialProps: { sleepMode: false } },
    );
    expect(mockRunCycle).toHaveBeenCalledTimes(1);
    expect(mockRunCycle).toHaveBeenLastCalledWith(expect.objectContaining({ sleepMode: false }));
    rerender({ sleepMode: true });
    // rerender만으로 추가 호출은 발생하지 않음
    expect(mockRunCycle).toHaveBeenCalledTimes(1);
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(mockRunCycle).toHaveBeenCalledTimes(2);
    expect(mockRunCycle).toHaveBeenLastCalledWith(expect.objectContaining({ sleepMode: true }));
  });

  it('runCycle reject 시 catch — 다음 tick은 정상 진행', () => {
    mockRunCycle.mockRejectedValueOnce(new Error('boom'));
    renderHook(() =>
      useLastTrainAlarm({
        sleepMode: true,
        origin,
        destination,
        route,
        intervalMs: 1_000,
      }),
    );
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(mockRunCycle).toHaveBeenCalledTimes(2);
  });
});
