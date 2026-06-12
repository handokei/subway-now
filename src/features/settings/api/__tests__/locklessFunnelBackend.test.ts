import { uploadLocklessFunnelStep } from '../locklessFunnelBackend';
import { LOCKLESS_FUNNEL_STEPS } from '../../utils/locklessFunnel';

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const ORIGINAL_FETCH = globalThis.fetch;
const FIXED_NOW = 1_700_000_000_000;

describe('uploadLocklessFunnelStep', () => {
  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    globalThis.fetch = jest.fn();
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    jest.restoreAllMocks();
  });

  it('URL 미설정이면 skipped=true', async () => {
    const result = await uploadLocklessFunnelStep('tok', LOCKLESS_FUNNEL_STEPS.VIEWED);
    expect(result).toEqual({ ok: false, skipped: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('빈 token이면 skipped=true', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    const result = await uploadLocklessFunnelStep('', LOCKLESS_FUNNEL_STEPS.ON);
    expect(result).toEqual({ ok: false, skipped: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('정상 응답 시 ok=true + body에 token/step/at 직렬화', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const result = await uploadLocklessFunnelStep('tok', LOCKLESS_FUNNEL_STEPS.OFF);
    expect(result).toEqual({ ok: true, status: 200 });
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test/telemetry/lockless-funnel');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      token: 'tok',
      step: LOCKLESS_FUNNEL_STEPS.OFF,
      at: FIXED_NOW,
    });
  });

  it('meta 제공 시 body에 포함된다', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    await uploadLocklessFunnelStep('tok', LOCKLESS_FUNNEL_STEPS.RE_ON, { src: 'unit' });
    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body).meta).toEqual({ src: 'unit' });
  });

  it('non-OK 응답 시 ok=false + status 반환', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const result = await uploadLocklessFunnelStep('tok', LOCKLESS_FUNNEL_STEPS.VIEWED);
    expect(result).toEqual({ ok: false, status: 500 });
  });

  it('fetch throw 시 ok=false (throw 안 함)', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockRejectedValue(new Error('net'));
    const result = await uploadLocklessFunnelStep('tok', LOCKLESS_FUNNEL_STEPS.VIEWED);
    expect(result).toEqual({ ok: false });
  });

  it('REQUEST_TIMEOUT_MS 경과 시 AbortController가 fetch를 중단한다', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    jest.useFakeTimers();
    (globalThis.fetch as jest.Mock).mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const promise = uploadLocklessFunnelStep('tok', LOCKLESS_FUNNEL_STEPS.VIEWED);
    jest.advanceTimersByTime(5000);
    const result = await promise;
    expect(result).toEqual({ ok: false });
    jest.useRealTimers();
  });

  it('URL 끝 슬래시는 제거된다', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    await uploadLocklessFunnelStep('tok', LOCKLESS_FUNNEL_STEPS.ON);
    const [url] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test/telemetry/lockless-funnel');
  });
});
