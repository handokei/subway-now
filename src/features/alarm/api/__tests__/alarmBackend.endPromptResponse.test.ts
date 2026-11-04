/**
 * #3007 PR-2 — 종료 질문 [계속] 응답을 backend에 전달하는 FG 재전송 클라이언트.
 * native ContinueGuidanceIntent POST가 실패했을 때 `useLiveActivityIntentBridge`가 쓴다.
 */
import { postEndPromptContinue } from '../alarmBackend';

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const ORIGINAL_FETCH = global.fetch;

describe('postEndPromptContinue', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  });

  it('URL 미설정 -> skipped, fetch 없음', async () => {
    expect(await postEndPromptContinue('tok')).toEqual({ ok: false, skipped: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('빈 token -> ok:false, fetch 없음', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
    expect(await postEndPromptContinue('')).toEqual({ ok: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('POST /trips/:token/end-prompt-response {action:continue}', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
    expect(await postEndPromptContinue('tok/1')).toEqual({ ok: true, status: 200 });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test.dev/trips/tok%2F1/end-prompt-response');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ action: 'continue' });
  });

  it('non-2xx -> ok:false + status (404 포함)', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 } as Response);
    expect(await postEndPromptContinue('tok')).toEqual({ ok: false, status: 404 });
  });

  it('fetch throw -> ok:false (throw 안 함, status 없음)', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
    (global.fetch as jest.Mock).mockRejectedValue(new Error('boom'));
    expect(await postEndPromptContinue('tok')).toEqual({ ok: false });
  });
});
