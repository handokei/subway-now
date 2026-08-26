const mockGetItem = jest.fn();
const mockSetItem = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (...args: unknown[]) => mockGetItem(...args),
  setItem: (...args: unknown[]) => mockSetItem(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { pollWithCooldown } from '../pollWithCooldown';

const NOW = 1_000_000;
const POLLED_AT_KEY = 'test:polled-at';
const CACHE_KEY = 'test:cache';
const MIN_INTERVAL_MS = 25_000;

interface TestPayload {
  value: string;
  isMock?: boolean;
}

function baseParams(fetcher: () => Promise<TestPayload>, now: number = NOW) {
  return {
    polledAtKey: POLLED_AT_KEY,
    cacheKey: CACHE_KEY,
    minIntervalMs: MIN_INTERVAL_MS,
    now,
    fetcher,
    logLabel: 'test',
  };
}

describe('pollWithCooldown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetItem.mockResolvedValue(null);
    mockSetItem.mockResolvedValue(undefined);
  });

  it('첫 폴링(타임스탬프 없음)은 즉시 fetch하고 캐시에 저장한다', async () => {
    const payload: TestPayload = { value: 'fresh', isMock: false };
    const fetcher = jest.fn().mockResolvedValue(payload);

    const result = await pollWithCooldown(baseParams(fetcher));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mockSetItem).toHaveBeenCalledWith(POLLED_AT_KEY, String(NOW));
    expect(mockSetItem).toHaveBeenCalledWith(CACHE_KEY, JSON.stringify(payload));
    expect(result).toEqual(payload);
  });

  it('최소 간격 미경과면 fetch 없이 캐시를 반환한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === POLLED_AT_KEY) return Promise.resolve(String(NOW));
      if (key === CACHE_KEY) return Promise.resolve(JSON.stringify({ value: 'cached' }));
      return Promise.resolve(null);
    });
    const fetcher = jest.fn();

    const result = await pollWithCooldown(baseParams(fetcher, NOW + MIN_INTERVAL_MS - 1));

    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toEqual({ value: 'cached' });
  });

  it('최소 간격 미경과 + 캐시 없음이면 null을 반환한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === POLLED_AT_KEY) return Promise.resolve(String(NOW));
      return Promise.resolve(null);
    });
    const fetcher = jest.fn();

    const result = await pollWithCooldown(baseParams(fetcher, NOW + MIN_INTERVAL_MS - 1));

    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('최소 간격 경과 시 다시 fetch한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === POLLED_AT_KEY) return Promise.resolve(String(NOW));
      return Promise.resolve(null);
    });
    const payload: TestPayload = { value: 'fresh', isMock: false };
    const fetcher = jest.fn().mockResolvedValue(payload);

    const result = await pollWithCooldown(baseParams(fetcher, NOW + MIN_INTERVAL_MS));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual(payload);
  });

  it('저장된 타임스탬프가 NaN이면(손상) 즉시 due로 처리한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === POLLED_AT_KEY) return Promise.resolve('not-a-number');
      return Promise.resolve(null);
    });
    const payload: TestPayload = { value: 'fresh', isMock: false };
    const fetcher = jest.fn().mockResolvedValue(payload);

    const result = await pollWithCooldown(baseParams(fetcher));

    expect(fetcher).toHaveBeenCalled();
    expect(result).toEqual(payload);
  });

  it('fetch 결과가 mock이면 캐시를 갱신하지 않고 기존 캐시를 반환한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === CACHE_KEY) return Promise.resolve(JSON.stringify({ value: 'cached', isMock: false }));
      return Promise.resolve(null);
    });
    const fetcher = jest.fn().mockResolvedValue({ value: 'mock', isMock: true });

    const result = await pollWithCooldown(baseParams(fetcher));

    expect(mockSetItem).not.toHaveBeenCalledWith(CACHE_KEY, expect.anything());
    expect(result).toEqual({ value: 'cached', isMock: false });
  });

  it('fetch 실패 시 캐시로 graceful fallback한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === CACHE_KEY) return Promise.resolve(JSON.stringify({ value: 'cached' }));
      return Promise.resolve(null);
    });
    const fetcher = jest.fn().mockRejectedValue(new Error('network'));

    const result = await pollWithCooldown(baseParams(fetcher));

    expect(result).toEqual({ value: 'cached' });
  });

  it('캐시 파싱 실패 시 null을 반환한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === CACHE_KEY) return Promise.resolve('not-json');
      return Promise.resolve(null);
    });
    const fetcher = jest.fn().mockRejectedValue(new Error('network'));

    const result = await pollWithCooldown(baseParams(fetcher));

    expect(result).toBeNull();
  });

  it('폴링 시각 조회 실패(AsyncStorage getItem reject)도 due로 graceful 처리한다', async () => {
    mockGetItem.mockImplementation((key: string) => {
      if (key === POLLED_AT_KEY) return Promise.reject(new Error('boom'));
      return Promise.resolve(null);
    });
    const payload: TestPayload = { value: 'fresh', isMock: false };
    const fetcher = jest.fn().mockResolvedValue(payload);

    const result = await pollWithCooldown(baseParams(fetcher));

    expect(result).toEqual(payload);
  });

  it('폴링 시각 저장 실패도 graceful하게 fetch를 계속 진행한다', async () => {
    mockSetItem.mockImplementation((key: string) => {
      if (key === POLLED_AT_KEY) return Promise.reject(new Error('boom'));
      return Promise.resolve(undefined);
    });
    const payload: TestPayload = { value: 'fresh', isMock: false };
    const fetcher = jest.fn().mockResolvedValue(payload);

    const result = await pollWithCooldown(baseParams(fetcher));

    expect(result).toEqual(payload);
  });
});
