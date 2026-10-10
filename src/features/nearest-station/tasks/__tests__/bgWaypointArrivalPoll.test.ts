const mockGetItem = jest.fn();
const mockSetItem = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (...args: unknown[]) => mockGetItem(...args),
  setItem: (...args: unknown[]) => mockSetItem(...args),
}));

const mockGetArrival = jest.fn();
const mockCreateArrivalProvider = jest.fn<{ getArrival: jest.Mock }, []>(() => ({
  getArrival: mockGetArrival,
}));
jest.mock('../../../arrival/providers/factory', () => ({
  createArrivalProvider: () => mockCreateArrivalProvider(),
}));

import {
  pollWaypointArrivalIfDue,
  BG_WAYPOINT_ARRIVAL_POLL_MIN_INTERVAL_MS,
  __resetBgWaypointArrivalPollForTests,
} from '../bgWaypointArrivalPoll';
import {
  BG_WAYPOINT_ARRIVAL_POLLED_AT_KEY,
  BG_WAYPOINT_ARRIVAL_CACHE_KEY,
} from '../../../../shared/constants/storageKeys';

const NOW = 1_000_000;

describe('pollWaypointArrivalIfDue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetBgWaypointArrivalPollForTests();
    mockGetItem.mockResolvedValue(null);
    mockSetItem.mockResolvedValue(undefined);
  });

  it('첫 폴링(타임스탬프 없음)은 즉시 fetch하고 캐시에 저장한다', async () => {
    const arrival = { up: [], down: [], isMock: false };
    mockGetArrival.mockResolvedValue(arrival);

    const result = await pollWaypointArrivalIfDue('용마산', '7', NOW);

    expect(mockGetArrival).toHaveBeenCalledWith('용마산', { lineHint: '7' });
    expect(mockSetItem).toHaveBeenCalledWith(BG_WAYPOINT_ARRIVAL_POLLED_AT_KEY, String(NOW));
    expect(mockSetItem).toHaveBeenCalledWith(BG_WAYPOINT_ARRIVAL_CACHE_KEY, JSON.stringify(arrival));
    expect(result).toEqual(arrival);
  });

  it('최소 간격 미경과면 fetch 없이 캐시를 반환한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_WAYPOINT_ARRIVAL_POLLED_AT_KEY) return Promise.resolve(String(NOW));
      if (key === BG_WAYPOINT_ARRIVAL_CACHE_KEY) {
        return Promise.resolve(JSON.stringify({ up: [], down: [] }));
      }
      return Promise.resolve(null);
    });

    const result = await pollWaypointArrivalIfDue(
      '용마산',
      '7',
      NOW + BG_WAYPOINT_ARRIVAL_POLL_MIN_INTERVAL_MS - 1,
    );

    expect(mockGetArrival).not.toHaveBeenCalled();
    expect(result).toEqual({ up: [], down: [] });
  });

  it('최소 간격 경과 시 다시 fetch한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_WAYPOINT_ARRIVAL_POLLED_AT_KEY) return Promise.resolve(String(NOW));
      return Promise.resolve(null);
    });
    const arrival = { up: [], down: [], isMock: false };
    mockGetArrival.mockResolvedValue(arrival);

    const result = await pollWaypointArrivalIfDue(
      '용마산',
      '7',
      NOW + BG_WAYPOINT_ARRIVAL_POLL_MIN_INTERVAL_MS,
    );

    expect(mockGetArrival).toHaveBeenCalled();
    expect(result).toEqual(arrival);
  });

  it('fetch 결과가 mock이면 캐시를 갱신하지 않고 기존 캐시를 반환한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_WAYPOINT_ARRIVAL_CACHE_KEY) {
        return Promise.resolve(JSON.stringify({ up: [], down: [], isMock: false, cached: true }));
      }
      return Promise.resolve(null);
    });
    mockGetArrival.mockResolvedValue({ up: [], down: [], isMock: true });

    const result = await pollWaypointArrivalIfDue('용마산', '7', NOW);

    expect(mockSetItem).not.toHaveBeenCalledWith(
      BG_WAYPOINT_ARRIVAL_CACHE_KEY,
      expect.anything(),
    );
    expect(result).toEqual({ up: [], down: [], isMock: false, cached: true });
  });

  it('fetch 실패 시 캐시로 graceful fallback한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_WAYPOINT_ARRIVAL_CACHE_KEY) {
        return Promise.resolve(JSON.stringify({ up: [], down: [], cached: true }));
      }
      return Promise.resolve(null);
    });
    mockGetArrival.mockRejectedValue(new Error('network'));

    const result = await pollWaypointArrivalIfDue('용마산', '7', NOW);

    expect(result).toEqual({ up: [], down: [], cached: true });
  });

  it('now 인자 미전달 시 Date.now() 기본값으로 동작한다', async () => {
    const arrival = { up: [], down: [], isMock: false };
    mockGetArrival.mockResolvedValue(arrival);

    const result = await pollWaypointArrivalIfDue('용마산', '7');

    expect(mockGetArrival).toHaveBeenCalledWith('용마산', { lineHint: '7' });
    expect(result).toEqual(arrival);
  });

  it('provider는 모듈 스코프에서 재사용된다(재생성 없음)', async () => {
    mockGetArrival.mockResolvedValue({ up: [], down: [], isMock: false });

    await pollWaypointArrivalIfDue('용마산', '7', NOW);
    await pollWaypointArrivalIfDue(
      '용마산',
      '7',
      NOW + BG_WAYPOINT_ARRIVAL_POLL_MIN_INTERVAL_MS,
    );

    expect(mockCreateArrivalProvider).toHaveBeenCalledTimes(1);
  });

  it('최소 간격은 20s(#2381 25s보다 짧다)', () => {
    expect(BG_WAYPOINT_ARRIVAL_POLL_MIN_INTERVAL_MS).toBe(20_000);
  });
});
