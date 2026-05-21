import { registerActiveTrip, clearActiveTrip } from '../alarmBackend';
import type { RegisterTripPayload } from '../alarmBackend';

jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const ORIGINAL_FETCH = global.fetch;
const NOW = new Date('2026-05-13T12:00:00Z').getTime();

const SAMPLE_PAYLOAD: RegisterTripPayload = {
  token: 'token-hex',
  route: { type: 'direct', stops: 5, line: '2' },
  destination: '0228',
  waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
  alarmAtEpochMs: NOW + 60000,
  createdAt: NOW,
  expiresAt: NOW + 1000,
  apnsEnv: 'sandbox',
};

describe('alarmBackend', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = ORIGINAL_FETCH;
  });

  describe('registerActiveTrip', () => {
    it('URL 미설정 시 skipped=true 반환', async () => {
      const result = await registerActiveTrip(SAMPLE_PAYLOAD);
      expect(result).toEqual({ ok: false, skipped: true });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('URL 빈 문자열도 미설정으로 취급', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = '';
      const result = await registerActiveTrip(SAMPLE_PAYLOAD);
      expect(result.skipped).toBe(true);
    });

    it('정상 응답 시 ok=true, body에 트립 직렬화', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);

      const result = await registerActiveTrip(SAMPLE_PAYLOAD);
      expect(result).toEqual({ ok: true, status: 200 });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      // trailing slash 제거 확인
      expect(url).toBe('https://api.test.dev/trips');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toMatchObject({
        token: 'token-hex',
        destination: '0228',
        alarmAtEpochMs: NOW + 60000,
        createdAt: NOW,
        expiresAt: NOW + 1000,
        apnsEnv: 'sandbox',
      });
    });

    it('createdAt/expiresAt 미지정 시 기본값(now, +2시간)', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);

      const payload: RegisterTripPayload = {
        token: 't',
        route: { type: 'direct', stops: 1, line: '2' },
        destination: '0228',
        waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
        alarmAtEpochMs: NOW,
        apnsEnv: 'sandbox',
      };
      await registerActiveTrip(payload);
      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.createdAt).toBe(NOW);
      expect(body.expiresAt).toBe(NOW + 2 * 60 * 60 * 1000);
    });

    it('non-2xx 응답 시 ok=false + status', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 } as Response);
      const result = await registerActiveTrip(SAMPLE_PAYLOAD);
      expect(result).toEqual({ ok: false, status: 500 });
    });

    it('fetch throw 시 ok=false 반환(throw 안 함)', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockRejectedValue(new Error('network'));
      const result = await registerActiveTrip(SAMPLE_PAYLOAD);
      expect(result).toEqual({ ok: false });
    });

    it('타임아웃 시 AbortController가 abort를 호출한다', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      let capturedSignal: AbortSignal | undefined;
      (global.fetch as jest.Mock).mockImplementation(async (_url, init) => {
        capturedSignal = init.signal;
        // 5초 후 timer가 abort()를 호출하도록 시각을 진행시킨다.
        jest.advanceTimersByTime(5000);
        return { ok: true, status: 200 } as Response;
      });
      await registerActiveTrip(SAMPLE_PAYLOAD);
      expect(capturedSignal?.aborted).toBe(true);
    });
  });

  describe('clearActiveTrip', () => {
    it('URL 미설정 시 skipped=true', async () => {
      const result = await clearActiveTrip('token-x');
      expect(result.skipped).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('token 비어 있으면 ok=false (호출 안 함)', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      const result = await clearActiveTrip('');
      expect(result).toEqual({ ok: false });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('정상 응답 시 ok=true, URL에 token URL-encode', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
      const result = await clearActiveTrip('a/b');
      expect(result.ok).toBe(true);
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('https://api.test.dev/trips/a%2Fb');
      expect(init.method).toBe('DELETE');
    });

    it('non-2xx 응답 시 ok=false + status', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 } as Response);
      const result = await clearActiveTrip('t');
      expect(result).toEqual({ ok: false, status: 404 });
    });

    it('fetch throw 시 ok=false (throw 안 함)', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockRejectedValue(new Error('boom'));
      const result = await clearActiveTrip('t');
      expect(result).toEqual({ ok: false });
    });
  });
});
