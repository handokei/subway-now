/**
 * observabilityMetricsClient (#1753, Sub 3) 단위 테스트.
 *
 * 커버:
 *   - ADMIN_TOKEN 미설정 → unconfigured
 *   - ALARM_BACKEND_URL 미설정 → unconfigured
 *   - fetch 200 성공 → ok + metrics 반환
 *   - fetch non-200 → error + HTTP status
 *   - fetch throw → error + message
 *   - endpoint URL 포맷 (`/v1/observability/metrics?window=24h`)
 *   - Bearer token header 전달
 */
import {
  fetchObservabilityMetrics,
  __test__,
  type ObservabilityMetrics,
} from '../observabilityMetricsClient';

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

function makeMetrics(): ObservabilityMetrics {
  return {
    accuracyRatio: { value: 8, total: 10, ratio: 0.8 },
    silentPushDeliveryRatio: { value: 5, total: 6, ratio: 0.833 },
    locklessMissRatio: { value: 1, total: 10, ratio: 0.1 },
    boardableMissRatio: { value: 0, total: 0, ratio: 0 },
    accelPatternHitRatio: {
      automotive: { count: 5, ratio: 0.5 },
      walking: { count: 2, ratio: 0.2 },
      stationary: { count: 2, ratio: 0.2 },
      unknown: { count: 1, ratio: 0.1 },
    },
    laPushDeliveryRatio: { sent: 10, failed: 2, ratio: 10 / 12 },
    window: '24h',
    timestamp: 1_700_000_000_000,
  };
}

function mockFetchOk(body: unknown) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

function mockFetchStatus(status: number) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
  });
}

function mockFetchThrow(message: string) {
  (global.fetch as jest.Mock).mockRejectedValue(new Error(message));
}

describe('fetchObservabilityMetrics', () => {
  describe('unconfigured', () => {
    it('returns unconfigured when ADMIN_TOKEN is empty', async () => {
      process.env.EXPO_PUBLIC_ADMIN_TOKEN = '';
      const result = await fetchObservabilityMetrics();
      expect(result.kind).toBe('unconfigured');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns unconfigured when ADMIN_TOKEN is unset', async () => {
      delete process.env.EXPO_PUBLIC_ADMIN_TOKEN;
      const result = await fetchObservabilityMetrics();
      expect(result.kind).toBe('unconfigured');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns unconfigured when ALARM_BACKEND_URL is empty', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = '';
      const result = await fetchObservabilityMetrics();
      expect(result.kind).toBe('unconfigured');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('success', () => {
    it('returns ok with metrics on 200', async () => {
      const metrics = makeMetrics();
      mockFetchOk(metrics);
      const result = await fetchObservabilityMetrics();
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.metrics.accuracyRatio.value).toBe(8);
        expect(result.metrics.locklessMissRatio.ratio).toBe(0.1);
        expect(result.metrics.window).toBe('24h');
      }
    });

    it('forwards laPushDeliveryRatio from response (#1779)', async () => {
      mockFetchOk(makeMetrics());
      const result = await fetchObservabilityMetrics();
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.metrics.laPushDeliveryRatio.sent).toBe(10);
        expect(result.metrics.laPushDeliveryRatio.failed).toBe(2);
        expect(result.metrics.laPushDeliveryRatio.ratio).toBeCloseTo(10 / 12);
      }
    });

    it('forwards silentPushReachRatio from response (#1958)', async () => {
      const metrics = makeMetrics();
      metrics.silentPushReachRatio = { sent: 7, received: 5, joined: 5, ratio: 5 / 7 };
      mockFetchOk(metrics);
      const result = await fetchObservabilityMetrics();
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.metrics.silentPushReachRatio?.sent).toBe(7);
        expect(result.metrics.silentPushReachRatio?.received).toBe(5);
        expect(result.metrics.silentPushReachRatio?.joined).toBe(5);
        expect(result.metrics.silentPushReachRatio?.ratio).toBeCloseTo(5 / 7);
      }
    });

    it('silentPushReachRatio 누락 (구 backend) → undefined graceful', async () => {
      mockFetchOk(makeMetrics());
      const result = await fetchObservabilityMetrics();
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.metrics.silentPushReachRatio).toBeUndefined();
      }
    });

    it('forwards locklessTripMissRatio from response (#1972)', async () => {
      const metrics = makeMetrics();
      metrics.locklessTripMissRatio = {
        miss: 3,
        fired: 7,
        paradigmIntent: 5,
        ratio: 0.3,
      };
      mockFetchOk(metrics);
      const result = await fetchObservabilityMetrics();
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.metrics.locklessTripMissRatio?.miss).toBe(3);
        expect(result.metrics.locklessTripMissRatio?.fired).toBe(7);
        expect(result.metrics.locklessTripMissRatio?.paradigmIntent).toBe(5);
        expect(result.metrics.locklessTripMissRatio?.ratio).toBeCloseTo(0.3);
      }
    });

    it('locklessTripMissRatio 누락 (구 backend) → undefined graceful', async () => {
      mockFetchOk(makeMetrics());
      const result = await fetchObservabilityMetrics();
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.metrics.locklessTripMissRatio).toBeUndefined();
      }
    });

    it('calls the correct endpoint URL with window=24h', async () => {
      mockFetchOk(makeMetrics());
      await fetchObservabilityMetrics();
      const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://alarm.example.test/v1/observability/metrics?window=24h');
    });

    it('sends Bearer authorization header', async () => {
      mockFetchOk(makeMetrics());
      await fetchObservabilityMetrics();
      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['authorization']).toBe(
        'Bearer test-token',
      );
    });

    it('strips trailing slash from ALARM_BACKEND_URL', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://alarm.example.test/';
      mockFetchOk(makeMetrics());
      await fetchObservabilityMetrics();
      const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect(url).not.toContain('//v1');
      expect(url).toContain('/v1/observability/metrics');
    });
  });

  describe('error cases', () => {
    it('returns error with HTTP status on non-200', async () => {
      mockFetchStatus(401);
      const result = await fetchObservabilityMetrics();
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.message).toBe('HTTP 401');
      }
    });

    it('returns error on 503', async () => {
      mockFetchStatus(503);
      const result = await fetchObservabilityMetrics();
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.message).toBe('HTTP 503');
      }
    });

    it('returns error with message when fetch throws', async () => {
      mockFetchThrow('network timeout');
      const result = await fetchObservabilityMetrics();
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.message).toBe('network timeout');
      }
    });

    it('returns error with string when non-Error thrown', async () => {
      (global.fetch as jest.Mock).mockRejectedValue('raw string error');
      const result = await fetchObservabilityMetrics();
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(typeof result.message).toBe('string');
      }
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
