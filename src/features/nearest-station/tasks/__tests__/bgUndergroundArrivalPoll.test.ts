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
  pollUndergroundArrivalIfDue,
  BG_UNDERGROUND_ARRIVAL_POLL_MIN_INTERVAL_MS,
  __resetBgUndergroundArrivalPollForTests,
} from '../bgUndergroundArrivalPoll';
import {
  BG_UNDERGROUND_ARRIVAL_POLLED_AT_KEY,
  BG_UNDERGROUND_ARRIVAL_CACHE_KEY,
} from '../../../../shared/constants/storageKeys';

const NOW = 1_000_000;

describe('pollUndergroundArrivalIfDue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetBgUndergroundArrivalPollForTests();
    mockGetItem.mockResolvedValue(null);
    mockSetItem.mockResolvedValue(undefined);
  });

  it('첫 폴링(타임스탬프 없음)은 즉시 fetch하고 캐시에 저장한다', async () => {
    const arrival = { up: [], down: [], isMock: false };
    mockGetArrival.mockResolvedValue(arrival);

    const result = await pollUndergroundArrivalIfDue('교대', '2', NOW);

    expect(mockGetArrival).toHaveBeenCalledWith('교대', { lineHint: '2' });
    expect(mockSetItem).toHaveBeenCalledWith(BG_UNDERGROUND_ARRIVAL_POLLED_AT_KEY, String(NOW));
    expect(mockSetItem).toHaveBeenCalledWith(BG_UNDERGROUND_ARRIVAL_CACHE_KEY, JSON.stringify(arrival));
    expect(result).toEqual(arrival);
  });

  it('최소 간격 미경과면 fetch 없이 캐시를 반환한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_UNDERGROUND_ARRIVAL_POLLED_AT_KEY) return Promise.resolve(String(NOW));
      if (key === BG_UNDERGROUND_ARRIVAL_CACHE_KEY) {
        return Promise.resolve(JSON.stringify({ up: [], down: [] }));
      }
      return Promise.resolve(null);
    });

    const result = await pollUndergroundArrivalIfDue(
      '교대',
      '2',
      NOW + BG_UNDERGROUND_ARRIVAL_POLL_MIN_INTERVAL_MS - 1,
    );

    expect(mockGetArrival).not.toHaveBeenCalled();
    expect(result).toEqual({ up: [], down: [] });
  });

  it('최소 간격 미경과 + 캐시 없음이면 null을 반환한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_UNDERGROUND_ARRIVAL_POLLED_AT_KEY) return Promise.resolve(String(NOW));
      return Promise.resolve(null);
    });

    const result = await pollUndergroundArrivalIfDue(
      '교대',
      '2',
      NOW + BG_UNDERGROUND_ARRIVAL_POLL_MIN_INTERVAL_MS - 1,
    );

    expect(mockGetArrival).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('최소 간격 경과 시 다시 fetch한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_UNDERGROUND_ARRIVAL_POLLED_AT_KEY) return Promise.resolve(String(NOW));
      return Promise.resolve(null);
    });
    const arrival = { up: [], down: [], isMock: false };
    mockGetArrival.mockResolvedValue(arrival);

    const result = await pollUndergroundArrivalIfDue(
      '교대',
      '2',
      NOW + BG_UNDERGROUND_ARRIVAL_POLL_MIN_INTERVAL_MS,
    );

    expect(mockGetArrival).toHaveBeenCalled();
    expect(result).toEqual(arrival);
  });

  it('저장된 타임스탬프가 NaN이면(손상) 즉시 due로 처리한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_UNDERGROUND_ARRIVAL_POLLED_AT_KEY) return Promise.resolve('not-a-number');
      return Promise.resolve(null);
    });
    const arrival = { up: [], down: [], isMock: false };
    mockGetArrival.mockResolvedValue(arrival);

    const result = await pollUndergroundArrivalIfDue('교대', '2', NOW);

    expect(mockGetArrival).toHaveBeenCalled();
    expect(result).toEqual(arrival);
  });

  it('fetch 결과가 mock이면 캐시를 갱신하지 않고 기존 캐시를 반환한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_UNDERGROUND_ARRIVAL_CACHE_KEY) {
        return Promise.resolve(JSON.stringify({ up: [], down: [], isMock: false, cached: true }));
      }
      return Promise.resolve(null);
    });
    mockGetArrival.mockResolvedValue({ up: [], down: [], isMock: true });

    const result = await pollUndergroundArrivalIfDue('교대', '2', NOW);

    expect(mockSetItem).not.toHaveBeenCalledWith(
      BG_UNDERGROUND_ARRIVAL_CACHE_KEY,
      expect.anything(),
    );
    expect(result).toEqual({ up: [], down: [], isMock: false, cached: true });
  });

  it('fetch 실패 시 캐시로 graceful fallback한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_UNDERGROUND_ARRIVAL_CACHE_KEY) {
        return Promise.resolve(JSON.stringify({ up: [], down: [], cached: true }));
      }
      return Promise.resolve(null);
    });
    mockGetArrival.mockRejectedValue(new Error('network'));

    const result = await pollUndergroundArrivalIfDue('교대', '2', NOW);

    expect(result).toEqual({ up: [], down: [], cached: true });
  });

  it('캐시 파싱 실패 시 null을 반환한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_UNDERGROUND_ARRIVAL_CACHE_KEY) return Promise.resolve('not-json');
      return Promise.resolve(null);
    });
    mockGetArrival.mockRejectedValue(new Error('network'));

    const result = await pollUndergroundArrivalIfDue('교대', '2', NOW);

    expect(result).toBeNull();
  });

  it('폴링 시각 조회 실패(AsyncStorage getItem reject)도 due로 graceful 처리한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_UNDERGROUND_ARRIVAL_POLLED_AT_KEY) return Promise.reject(new Error('boom'));
      return Promise.resolve(null);
    });
    const arrival = { up: [], down: [], isMock: false };
    mockGetArrival.mockResolvedValue(arrival);

    const result = await pollUndergroundArrivalIfDue('교대', '2', NOW);

    expect(result).toEqual(arrival);
  });

  it('폴링 시각 저장 실패도 graceful하게 fetch를 계속 진행한다', async () => {
    mockSetItem.mockImplementation((key: string) => {
      if (key === BG_UNDERGROUND_ARRIVAL_POLLED_AT_KEY) return Promise.reject(new Error('boom'));
      return Promise.resolve(undefined);
    });
    const arrival = { up: [], down: [], isMock: false };
    mockGetArrival.mockResolvedValue(arrival);

    const result = await pollUndergroundArrivalIfDue('교대', '2', NOW);

    expect(result).toEqual(arrival);
  });

  it('now 인자 미전달 시 Date.now() 기본값으로 동작한다', async () => {
    const arrival = { up: [], down: [], isMock: false };
    mockGetArrival.mockResolvedValue(arrival);

    const result = await pollUndergroundArrivalIfDue('교대', '2');

    expect(mockGetArrival).toHaveBeenCalledWith('교대', { lineHint: '2' });
    expect(result).toEqual(arrival);
  });

  it('provider는 모듈 스코프에서 재사용된다(재생성 없음)', async () => {
    mockGetArrival.mockResolvedValue({ up: [], down: [], isMock: false });

    await pollUndergroundArrivalIfDue('교대', '2', NOW);
    await pollUndergroundArrivalIfDue(
      '교대',
      '2',
      NOW + BG_UNDERGROUND_ARRIVAL_POLL_MIN_INTERVAL_MS,
    );

    expect(mockCreateArrivalProvider).toHaveBeenCalledTimes(1);
  });
});
