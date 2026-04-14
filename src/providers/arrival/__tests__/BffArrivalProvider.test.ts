import { BffArrivalProvider } from '../BffArrivalProvider';
import { MOCK_ARRIVALS } from '../../../api/arrivalApi';
import type { StationArrival } from '../../../api/arrivalApi';

describe('BffArrivalProvider', () => {
  const BASE_URL = 'https://bff.example.com';
  let provider: BffArrivalProvider;

  beforeEach(() => {
    provider = new BffArrivalProvider(BASE_URL);
    global.fetch = jest.fn();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('should return arrival data when fetch succeeds with non-empty result', async () => {
    const mockData: StationArrival = {
      up: [{ destination: '서울역', arrivalMinutes: 3, trainCode: 'UP-001' }],
      down: [{ destination: '인천역', arrivalMinutes: 5, trainCode: 'DN-001' }],
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce(mockData),
    });

    const resultPromise = provider.getArrival('강남');
    jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual(mockData);
  });

  it('should call fetch with correct URL and default options', async () => {
    const mockData: StationArrival = {
      up: [{ destination: '서울역', arrivalMinutes: 3, trainCode: 'UP-001' }],
      down: [{ destination: '인천역', arrivalMinutes: 5, trainCode: 'DN-001' }],
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce(mockData),
    });

    const resultPromise = provider.getArrival('강남');
    jest.runAllTimersAsync();
    await resultPromise;

    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/arrival/${encodeURIComponent('강남')}?maxPerDirection=2`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should call fetch with custom maxPerDirection option', async () => {
    const mockData: StationArrival = {
      up: [{ destination: '서울역', arrivalMinutes: 3, trainCode: 'UP-001' }],
      down: [{ destination: '인천역', arrivalMinutes: 5, trainCode: 'DN-001' }],
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce(mockData),
    });

    const resultPromise = provider.getArrival('홍대입구', { maxPerDirection: 5 });
    jest.runAllTimersAsync();
    await resultPromise;

    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/arrival/${encodeURIComponent('홍대입구')}?maxPerDirection=5`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should return MOCK_ARRIVALS when response is not ok', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const resultPromise = provider.getArrival('강남');
    jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe(MOCK_ARRIVALS);
  });

  it('should return MOCK_ARRIVALS when both up and down arrays are empty', async () => {
    const emptyData: StationArrival = { up: [], down: [] };
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce(emptyData),
    });

    const resultPromise = provider.getArrival('강남');
    jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe(MOCK_ARRIVALS);
  });

  it('should return data when only up array has items', async () => {
    const partialData: StationArrival = {
      up: [{ destination: '서울역', arrivalMinutes: 3, trainCode: 'UP-001' }],
      down: [],
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce(partialData),
    });

    const resultPromise = provider.getArrival('강남');
    jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual(partialData);
  });

  it('should return data when only down array has items', async () => {
    const partialData: StationArrival = {
      up: [],
      down: [{ destination: '인천역', arrivalMinutes: 5, trainCode: 'DN-001' }],
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce(partialData),
    });

    const resultPromise = provider.getArrival('강남');
    jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual(partialData);
  });

  it('should return MOCK_ARRIVALS when fetch throws an error', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

    const resultPromise = provider.getArrival('강남');
    jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe(MOCK_ARRIVALS);
  });

  it('should return MOCK_ARRIVALS when fetch is aborted by timeout', async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 6000);
        }),
    );

    const resultPromise = provider.getArrival('강남', { timeoutMs: 100 });
    jest.runAllTimers();
    const result = await resultPromise;

    expect(result).toBe(MOCK_ARRIVALS);
  });

  it('should URL-encode station name with special characters', async () => {
    const mockData: StationArrival = {
      up: [{ destination: '서울역', arrivalMinutes: 3, trainCode: 'UP-001' }],
      down: [{ destination: '인천역', arrivalMinutes: 5, trainCode: 'DN-001' }],
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce(mockData),
    });

    const resultPromise = provider.getArrival('서울 역');
    jest.runAllTimersAsync();
    await resultPromise;

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('서울 역')),
      expect.any(Object),
    );
  });
});
