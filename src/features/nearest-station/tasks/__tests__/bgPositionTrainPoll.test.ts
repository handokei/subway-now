const mockGetItem = jest.fn();
const mockSetItem = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (...args: unknown[]) => mockGetItem(...args),
  setItem: (...args: unknown[]) => mockSetItem(...args),
}));

const mockFetchTrainPositions = jest.fn();
jest.mock('../../api/positionApi', () => ({
  fetchTrainPositions: (...args: unknown[]) => mockFetchTrainPositions(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {
  pollTrainPositionsIfDue,
  BG_POSITION_TRAIN_POLL_MIN_INTERVAL_MS,
} from '../bgPositionTrainPoll';
import {
  BG_POSITION_TRAIN_POLLED_AT_KEY,
  BG_POSITION_TRAIN_CACHE_KEY,
} from '../../../../shared/constants/storageKeys';

const NOW = 1_000_000;

describe('pollTrainPositionsIfDue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetItem.mockResolvedValue(null);
    mockSetItem.mockResolvedValue(undefined);
  });

  it('첫 폴링(타임스탬프 없음)은 즉시 fetch하고 캐시에 저장한다', async () => {
    const positions = { line: '2', trains: [], isMock: false };
    mockFetchTrainPositions.mockResolvedValue(positions);

    const result = await pollTrainPositionsIfDue('2', NOW);

    expect(mockFetchTrainPositions).toHaveBeenCalledWith('2');
    expect(mockSetItem).toHaveBeenCalledWith(BG_POSITION_TRAIN_POLLED_AT_KEY, String(NOW));
    expect(mockSetItem).toHaveBeenCalledWith(BG_POSITION_TRAIN_CACHE_KEY, JSON.stringify(positions));
    expect(result).toEqual(positions);
  });

  it('최소 간격 미경과면 fetch 없이 캐시를 반환한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_POSITION_TRAIN_POLLED_AT_KEY) return Promise.resolve(String(NOW));
      if (key === BG_POSITION_TRAIN_CACHE_KEY) {
        return Promise.resolve(JSON.stringify({ line: '2', trains: [] }));
      }
      return Promise.resolve(null);
    });

    const result = await pollTrainPositionsIfDue(
      '2',
      NOW + BG_POSITION_TRAIN_POLL_MIN_INTERVAL_MS - 1,
    );

    expect(mockFetchTrainPositions).not.toHaveBeenCalled();
    expect(result).toEqual({ line: '2', trains: [] });
  });

  it('최소 간격 미경과 + 캐시 없음이면 null을 반환한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_POSITION_TRAIN_POLLED_AT_KEY) return Promise.resolve(String(NOW));
      return Promise.resolve(null);
    });

    const result = await pollTrainPositionsIfDue(
      '2',
      NOW + BG_POSITION_TRAIN_POLL_MIN_INTERVAL_MS - 1,
    );

    expect(mockFetchTrainPositions).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('최소 간격 경과 시 다시 fetch한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_POSITION_TRAIN_POLLED_AT_KEY) return Promise.resolve(String(NOW));
      return Promise.resolve(null);
    });
    const positions = { line: '2', trains: [], isMock: false };
    mockFetchTrainPositions.mockResolvedValue(positions);

    const result = await pollTrainPositionsIfDue(
      '2',
      NOW + BG_POSITION_TRAIN_POLL_MIN_INTERVAL_MS,
    );

    expect(mockFetchTrainPositions).toHaveBeenCalled();
    expect(result).toEqual(positions);
  });

  it('저장된 타임스탬프가 NaN이면(손상) 즉시 due로 처리한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_POSITION_TRAIN_POLLED_AT_KEY) return Promise.resolve('not-a-number');
      return Promise.resolve(null);
    });
    const positions = { line: '2', trains: [], isMock: false };
    mockFetchTrainPositions.mockResolvedValue(positions);

    const result = await pollTrainPositionsIfDue('2', NOW);

    expect(mockFetchTrainPositions).toHaveBeenCalled();
    expect(result).toEqual(positions);
  });

  it('fetch 결과가 mock이면 캐시를 갱신하지 않고 기존 캐시를 반환한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_POSITION_TRAIN_CACHE_KEY) {
        return Promise.resolve(JSON.stringify({ line: '2', trains: [], cached: true }));
      }
      return Promise.resolve(null);
    });
    mockFetchTrainPositions.mockResolvedValue({ line: '2', trains: [], isMock: true });

    const result = await pollTrainPositionsIfDue('2', NOW);

    expect(mockSetItem).not.toHaveBeenCalledWith(BG_POSITION_TRAIN_CACHE_KEY, expect.anything());
    expect(result).toEqual({ line: '2', trains: [], cached: true });
  });

  it('fetch 실패 시 캐시로 graceful fallback한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_POSITION_TRAIN_CACHE_KEY) {
        return Promise.resolve(JSON.stringify({ line: '2', trains: [], cached: true }));
      }
      return Promise.resolve(null);
    });
    mockFetchTrainPositions.mockRejectedValue(new Error('network'));

    const result = await pollTrainPositionsIfDue('2', NOW);

    expect(result).toEqual({ line: '2', trains: [], cached: true });
  });

  it('캐시 파싱 실패 시 null을 반환한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_POSITION_TRAIN_CACHE_KEY) return Promise.resolve('not-json');
      return Promise.resolve(null);
    });
    mockFetchTrainPositions.mockRejectedValue(new Error('network'));

    const result = await pollTrainPositionsIfDue('2', NOW);

    expect(result).toBeNull();
  });

  it('폴링 시각 조회 실패(AsyncStorage getItem reject)도 due로 graceful 처리한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === BG_POSITION_TRAIN_POLLED_AT_KEY) return Promise.reject(new Error('boom'));
      return Promise.resolve(null);
    });
    const positions = { line: '2', trains: [], isMock: false };
    mockFetchTrainPositions.mockResolvedValue(positions);

    const result = await pollTrainPositionsIfDue('2', NOW);

    expect(result).toEqual(positions);
  });

  it('폴링 시각 저장 실패도 graceful하게 fetch를 계속 진행한다', async () => {
    mockSetItem.mockImplementation((key: string) => {
      if (key === BG_POSITION_TRAIN_POLLED_AT_KEY) return Promise.reject(new Error('boom'));
      return Promise.resolve(undefined);
    });
    const positions = { line: '2', trains: [], isMock: false };
    mockFetchTrainPositions.mockResolvedValue(positions);

    const result = await pollTrainPositionsIfDue('2', NOW);

    expect(result).toEqual(positions);
  });

  it('now 인자 미전달 시 Date.now() 기본값으로 동작한다', async () => {
    const positions = { line: '2', trains: [], isMock: false };
    mockFetchTrainPositions.mockResolvedValue(positions);

    const result = await pollTrainPositionsIfDue('2');

    expect(mockFetchTrainPositions).toHaveBeenCalledWith('2');
    expect(result).toEqual(positions);
  });
});
