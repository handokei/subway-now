import { uploadSilentPushTelemetry } from '../telemetryBackend';
import type { SilentPushTelemetryPayload } from '../../utils/telemetryAggregation';

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const ORIGINAL_FETCH = global.fetch;

const PAYLOAD: SilentPushTelemetryPayload = {
  since: 0,
  until: 1_000,
  received: 3,
  fired: 2,
  skipped: 1,
  skipReasons: { 'gate-out-of-range': 1 },
};

describe('uploadSilentPushTelemetry', () => {
  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it('URL 미설정이면 skipped=true', async () => {
    const result = await uploadSilentPushTelemetry('token', PAYLOAD);
    expect(result).toEqual({ ok: false, skipped: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('빈 token도 skipped=true', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    const result = await uploadSilentPushTelemetry('', PAYLOAD);
    expect(result).toEqual({ ok: false, skipped: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('정상 응답 시 ok=true, body 직렬화 확인', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const result = await uploadSilentPushTelemetry('tok', PAYLOAD);
    expect(result).toEqual({ ok: true, status: 200 });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test/telemetry/silent-push');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.token).toBe('tok');
    expect(body.received).toBe(3);
    expect(body.skipReasons).toEqual({ 'gate-out-of-range': 1 });
  });

  it('!res.ok 응답 시 ok=false + status', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const result = await uploadSilentPushTelemetry('tok', PAYLOAD);
    expect(result).toEqual({ ok: false, status: 500 });
  });

  it('fetch throw 시 ok=false', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (global.fetch as jest.Mock).mockRejectedValue(new Error('network'));
    const result = await uploadSilentPushTelemetry('tok', PAYLOAD);
    expect(result).toEqual({ ok: false });
  });

  it('타임아웃 발동 시 abort → ok=false', async () => {
    jest.useFakeTimers();
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (global.fetch as jest.Mock).mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const promise = uploadSilentPushTelemetry('tok', PAYLOAD);
    await jest.advanceTimersByTimeAsync(6000);
    const result = await promise;
    expect(result).toEqual({ ok: false });
    jest.useRealTimers();
  });
});
