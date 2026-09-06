import { describe, expect, it, vi } from 'vitest';
import { logBackendError } from '../d1ErrorLog';
import { captureXEvent } from '../sentry';

vi.mock('../sentry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sentry')>();
  return { ...actual, captureXEvent: vi.fn() };
});

function makeMockDb(): D1Database {
  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare } as unknown as D1Database;
}

describe('logBackendError (#1835)', () => {
  it('db가 undefined일 때 no-op (graceful)', async () => {
    // DB 미바인딩 환경에서 throw 없이 종료
    await expect(
      logBackendError(undefined, { endpoint: '/trips', errorType: 'Error', message: 'fail' }),
    ).resolves.toBeUndefined();
  });

  it('db가 있을 때 INSERT를 실행한다', async () => {
    const db = makeMockDb();
    await logBackendError(db, {
      endpoint: '/scheduled',
      errorType: 'TypeError',
      message: 'oops',
      stack: 'stack trace',
      context: { token: 'abc' },
    });

    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO backend_errors'),
    );
  });

  it('context가 없을 때도 정상 동작한다', async () => {
    const db = makeMockDb();
    await logBackendError(db, { endpoint: '/cron', errorType: 'RangeError' });
    expect(db.prepare).toHaveBeenCalledOnce();
  });

  it('D1 write 실패 시 throw 없이 swallow한다', async () => {
    const run = vi.fn().mockRejectedValue(new Error('D1 write error'));
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    await expect(
      logBackendError(db, { endpoint: '/trips', errorType: 'Error' }),
    ).resolves.toBeUndefined();
  });

  it('D1 write 실패 시 무음이 아니라 captureXEvent로 관측 승격된다 (#2227)', async () => {
    const run = vi.fn().mockRejectedValue(new Error('D1 write error'));
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    await logBackendError(db, { endpoint: '/trips', errorType: 'Error' });

    expect(captureXEvent).toHaveBeenCalledWith(
      'D1-write-failure',
      expect.objectContaining({ table: 'backend_errors' }),
    );
  });
});
