import {
  TELEMETRY_REQUEST_TIMEOUT_MS,
  fetchWithTelemetryTimeout,
  getAlarmBackendUrl,
} from '../telemetryHttp';

describe('telemetryHttp', () => {
  const originalUrl = process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    } else {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = originalUrl;
    }
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  describe('getAlarmBackendUrl', () => {
    it('returns null when env not set', () => {
      delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
      expect(getAlarmBackendUrl()).toBeNull();
    });

    it('returns env value trimmed of trailing slash', () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.example.com/';
      expect(getAlarmBackendUrl()).toBe('https://api.example.com');
    });

    it('returns env value as-is when no trailing slash', () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.example.com';
      expect(getAlarmBackendUrl()).toBe('https://api.example.com');
    });
  });

  describe('fetchWithTelemetryTimeout', () => {
    it('resolves to response when fetch succeeds', async () => {
      const fakeResponse = { ok: true, status: 200 } as Response;
      global.fetch = jest.fn().mockResolvedValue(fakeResponse);
      const res = await fetchWithTelemetryTimeout('https://x/y', { method: 'POST' });
      expect(res).toBe(fakeResponse);
      expect((global.fetch as jest.Mock).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it('aborts when timeout elapses', async () => {
      jest.useFakeTimers();
      global.fetch = jest.fn((input, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      ) as unknown as typeof fetch;
      const promise = fetchWithTelemetryTimeout('https://x/y', { method: 'POST' });
      jest.advanceTimersByTime(TELEMETRY_REQUEST_TIMEOUT_MS);
      await expect(promise).rejects.toThrow('aborted');
    });

    it('clears timer when fetch resolves before timeout', async () => {
      jest.useFakeTimers();
      const clearSpy = jest.spyOn(global, 'clearTimeout');
      global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);
      await fetchWithTelemetryTimeout('https://x/y', { method: 'POST' });
      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    });
  });

  it('exports timeout constant', () => {
    expect(TELEMETRY_REQUEST_TIMEOUT_MS).toBe(5000);
  });
});
