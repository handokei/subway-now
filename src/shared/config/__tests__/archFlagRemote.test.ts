import { __test__, fetchArchFlag } from '../archFlagRemote';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.EXPO_PUBLIC_ADMIN_TOKEN = 'test-token';
  process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://alarm.example.test';
  global.fetch = jest.fn() as unknown as typeof fetch;
});

afterEach(() => {
  process.env.EXPO_PUBLIC_ADMIN_TOKEN = ORIGINAL_ENV.EXPO_PUBLIC_ADMIN_TOKEN;
  process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = ORIGINAL_ENV.EXPO_PUBLIC_ALARM_BACKEND_URL;
});

function mockFetchOk(body: unknown): void {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

function mockFetchStatus(status: number): void {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
  });
}

function mockFetchThrow(message: string): void {
  (global.fetch as jest.Mock).mockRejectedValue(new Error(message));
}

describe('fetchArchFlag (#1982, ADR-022 Phase 0)', () => {
  describe('unconfigured', () => {
    it('returns unconfigured when ADMIN_TOKEN is empty', async () => {
      process.env.EXPO_PUBLIC_ADMIN_TOKEN = '';
      const result = await fetchArchFlag();
      expect(result.kind).toBe('unconfigured');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns unconfigured when ADMIN_TOKEN is unset', async () => {
      delete process.env.EXPO_PUBLIC_ADMIN_TOKEN;
      const result = await fetchArchFlag();
      expect(result.kind).toBe('unconfigured');
    });

    it('returns unconfigured when ALARM_BACKEND_URL is empty', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = '';
      const result = await fetchArchFlag();
      expect(result.kind).toBe('unconfigured');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('success', () => {
    it('returns ok with value=on', async () => {
      mockFetchOk({ value: 'on' });
      const result = await fetchArchFlag();
      expect(result).toEqual({ kind: 'ok', value: 'on' });
    });

    it('returns ok with value=off', async () => {
      mockFetchOk({ value: 'off' });
      const result = await fetchArchFlag();
      expect(result).toEqual({ kind: 'ok', value: 'off' });
    });

    it('calls the correct endpoint /admin/arch-flag', async () => {
      mockFetchOk({ value: 'off' });
      await fetchArchFlag();
      const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://alarm.example.test/admin/arch-flag');
    });

    it('sends Bearer authorization header', async () => {
      mockFetchOk({ value: 'off' });
      await fetchArchFlag();
      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['authorization']).toBe(
        'Bearer test-token',
      );
    });
  });

  describe('error cases', () => {
    it('returns error with HTTP status on non-200', async () => {
      mockFetchStatus(401);
      const result = await fetchArchFlag();
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.message).toBe('HTTP 401');
      }
    });

    it('returns error on 503', async () => {
      mockFetchStatus(503);
      const result = await fetchArchFlag();
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.message).toBe('HTTP 503');
      }
    });

    it('returns error with message when fetch throws', async () => {
      mockFetchThrow('network timeout');
      const result = await fetchArchFlag();
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.message).toBe('network timeout');
      }
    });

    it('returns error string when non-Error thrown', async () => {
      (global.fetch as jest.Mock).mockRejectedValue('raw');
      const result = await fetchArchFlag();
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(typeof result.message).toBe('string');
      }
    });

    it('returns error when body.value is invalid (backend drift 방어)', async () => {
      mockFetchOk({ value: 'true' });
      const result = await fetchArchFlag();
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.message).toBe('invalid_body');
      }
    });

    it('returns error when body missing value field', async () => {
      mockFetchOk({});
      const result = await fetchArchFlag();
      expect(result.kind).toBe('error');
    });
  });

  describe('__test__ internal exports', () => {
    it('getAdminToken returns null when unset', () => {
      process.env.EXPO_PUBLIC_ADMIN_TOKEN = '';
      expect(__test__.getAdminToken()).toBeNull();
    });

    it('getAdminToken returns token string when set', () => {
      process.env.EXPO_PUBLIC_ADMIN_TOKEN = 'my-token';
      expect(__test__.getAdminToken()).toBe('my-token');
    });
  });
});
