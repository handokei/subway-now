import { SeoulBffProgressProvider } from '../SeoulBffProgressProvider';
import type { BffProgressResponse } from '../types';

describe('SeoulBffProgressProvider', () => {
  const BASE_URL = 'https://bff.example.com';
  const TRIP_TOKEN = 'trainCode-7301:line-2';
  const NOW_MS = 1_700_000_000_000;

  function mockFetchOk(data: BffProgressResponse) {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce(data),
    });
  }

  beforeEach(() => {
    global.fetch = jest.fn();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('정상 응답 시 BffProgressResponse를 그대로 반환한다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    const response: BffProgressResponse = {
      waypointIndex: 3,
      remainingHopsMs: 45_000,
      confidence: 'high',
      receivedAtMs: NOW_MS,
      ttlMs: 60_000,
    };
    mockFetchOk(response);

    const result = await provider.fetch(TRIP_TOKEN, NOW_MS);

    expect(result).toEqual(response);
    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/progress/${encodeURIComponent(TRIP_TOKEN)}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('응답이 만료되면 null을 반환한다 (nowMs - receivedAtMs > ttlMs)', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    const expired: BffProgressResponse = {
      waypointIndex: 1,
      remainingHopsMs: 30_000,
      confidence: 'high',
      receivedAtMs: NOW_MS - 120_000,
      ttlMs: 60_000,
    };
    mockFetchOk(expired);

    const result = await provider.fetch(TRIP_TOKEN, NOW_MS);

    expect(result).toBeNull();
  });

  it('confidence가 low면 신선해도 null을 반환한다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    const lowConfidence: BffProgressResponse = {
      waypointIndex: 2,
      remainingHopsMs: 40_000,
      confidence: 'low',
      receivedAtMs: NOW_MS,
      ttlMs: 60_000,
    };
    mockFetchOk(lowConfidence);

    const result = await provider.fetch(TRIP_TOKEN, NOW_MS);

    expect(result).toBeNull();
  });

  it('네트워크 실패 시 null을 반환한다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

    const result = await provider.fetch(TRIP_TOKEN, NOW_MS);

    expect(result).toBeNull();
  });

  it('non-2xx 응답 시 null을 반환한다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 503 });

    const result = await provider.fetch(TRIP_TOKEN, NOW_MS);

    expect(result).toBeNull();
  });

  it('TTL 만료 전까지 캐시에서 응답해 fetch를 중복 호출하지 않는다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    const fresh: BffProgressResponse = {
      waypointIndex: 5,
      remainingHopsMs: 25_000,
      confidence: 'medium',
      receivedAtMs: NOW_MS,
      ttlMs: 60_000,
    };
    mockFetchOk(fresh);

    const first = await provider.fetch(TRIP_TOKEN, NOW_MS);
    const second = await provider.fetch(TRIP_TOKEN, NOW_MS + 10_000);

    expect(first).toEqual(fresh);
    expect(second).toEqual(fresh);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('캐시가 TTL을 넘기면 다시 fetch한다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    const first: BffProgressResponse = {
      waypointIndex: 1,
      remainingHopsMs: 50_000,
      confidence: 'high',
      receivedAtMs: NOW_MS,
      ttlMs: 60_000,
    };
    const second: BffProgressResponse = {
      waypointIndex: 2,
      remainingHopsMs: 30_000,
      confidence: 'high',
      receivedAtMs: NOW_MS + 70_000,
      ttlMs: 60_000,
    };
    mockFetchOk(first);
    mockFetchOk(second);

    const r1 = await provider.fetch(TRIP_TOKEN, NOW_MS);
    const r2 = await provider.fetch(TRIP_TOKEN, NOW_MS + 70_000);

    expect(r1).toEqual(first);
    expect(r2).toEqual(second);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('타임아웃 abort 시 null을 반환한다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL, 100);
    (global.fetch as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 6000);
        }),
    );

    const resultPromise = provider.fetch(TRIP_TOKEN, NOW_MS);
    jest.runAllTimers();
    const result = await resultPromise;

    expect(result).toBeNull();
  });

  it('특수 문자가 포함된 tripToken을 URL 인코딩한다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    const response: BffProgressResponse = {
      waypointIndex: 0,
      remainingHopsMs: 60_000,
      confidence: 'high',
      receivedAtMs: NOW_MS,
      ttlMs: 60_000,
    };
    mockFetchOk(response);

    await provider.fetch('lock/with spaces', NOW_MS);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('lock/with spaces')),
      expect.any(Object),
    );
  });
});
