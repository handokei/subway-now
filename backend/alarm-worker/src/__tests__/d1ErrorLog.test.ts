import { describe, expect, it, vi } from 'vitest';
import { logBackendError } from '../d1ErrorLog';

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
});
