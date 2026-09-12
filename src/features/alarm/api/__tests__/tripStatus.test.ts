import { fetchTripStatus } from '../tripStatus';

function jsonResponse(body: unknown, status: number = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('fetchTripStatus', () => {
  it('200 active → { status: active, endedAt: null, endReason: null }', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({ tripToken: 'tk', status: 'active', endedAt: null, endReason: null }),
    );
    const result = await fetchTripStatus('tk', 'https://api.test.dev', fetchImpl);
    expect(result).toEqual({ status: 'active', endedAt: null, endReason: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.test.dev/trips/tk/status');
    expect(init.method).toBe('GET');
  });

  it('200 ended → endedAt/endReason 반환 (destination → destination-arrived 정규화)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        tripToken: 'tk',
        status: 'ended',
        endedAt: 1_700_000_000_000,
        endReason: 'destination',
      }),
    );
    const result = await fetchTripStatus('tk', 'https://api.test.dev/', fetchImpl);
    expect(result).toEqual({
      status: 'ended',
      endedAt: 1_700_000_000_000,
      endReason: 'destination-arrived',
    });
  });

  it.each([
    ['expired'],
    ['eta-missing'],
    ['push-unrecoverable'],
  ])('200 ended endReason=%s는 동일 enum 유지', async (reason) => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({ tripToken: 'tk', status: 'ended', endedAt: 1, endReason: reason }),
    );
    const result = await fetchTripStatus('tk', 'https://api.test.dev', fetchImpl);
    expect(result?.endReason).toBe(reason);
  });

  it('200 ended endReason이 알 수 없는 값이면 unknown', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({ tripToken: 'tk', status: 'ended', endedAt: 1, endReason: 'mystery' }),
    );
    const result = await fetchTripStatus('tk', 'https://api.test.dev', fetchImpl);
    expect(result?.endReason).toBe('unknown');
  });

  it('200 ended endReason 타입 비-string → unknown', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({ tripToken: 'tk', status: 'ended', endedAt: 1, endReason: 42 }),
    );
    const result = await fetchTripStatus('tk', 'https://api.test.dev', fetchImpl);
    expect(result?.endReason).toBe('unknown');
  });

  it('200 ended endedAt 누락/비-number → Date.now() fallback', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T00:00:00Z'));
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({ tripToken: 'tk', status: 'ended', endReason: 'expired' }),
    );
    const result = await fetchTripStatus('tk', 'https://api.test.dev', fetchImpl);
    expect(result?.endedAt).toBe(Date.now());
    jest.useRealTimers();
  });

  it('404 → null', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ error: 'trip_not_found' }, 404));
    const result = await fetchTripStatus('tk', 'https://api.test.dev', fetchImpl);
    expect(result).toBeNull();
  });

  it('410 → null', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({ tripToken: 'tk', status: 'expired-retention' }, 410),
    );
    const result = await fetchTripStatus('tk', 'https://api.test.dev', fetchImpl);
    expect(result).toBeNull();
  });

  it('500 → throw', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}, 500));
    await expect(fetchTripStatus('tk', 'https://api.test.dev', fetchImpl)).rejects.toThrow();
  });

  it('네트워크 에러 → throw', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('network'));
    await expect(fetchTripStatus('tk', 'https://api.test.dev', fetchImpl)).rejects.toThrow('network');
  });

  it('알 수 없는 status body → throw', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ tripToken: 'tk' }));
    await expect(fetchTripStatus('tk', 'https://api.test.dev', fetchImpl)).rejects.toThrow();
  });

  it('tripToken은 URL encode된다', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({ tripToken: 'a/b', status: 'active', endedAt: null, endReason: null }),
    );
    await fetchTripStatus('a/b', 'https://api.test.dev', fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.test.dev/trips/a%2Fb/status');
  });

  it('타임아웃 초과 시 abort 호출 → 네트워크 에러로 throw', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const pending = fetchTripStatus('tk', 'https://api.test.dev', fetchImpl);
    jest.advanceTimersByTime(5001);
    await expect(pending).rejects.toThrow();
    jest.useRealTimers();
  });

  it('fetchImpl 미지정 시 global fetch 사용', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ tripToken: 'tk', status: 'active', endedAt: null, endReason: null }),
    );
    try {
      const result = await fetchTripStatus('tk', 'https://api.test.dev');
      expect(result?.status).toBe('active');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
