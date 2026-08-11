import { describe, expect, it, vi } from 'vitest';
import { cleanupTripEvents, recordTripEvent, TRIP_EVENT_RETENTION_MS } from '../tripEventLog';

function makeMockDb(runResult: unknown = { success: true }): D1Database {
  const run = vi.fn().mockResolvedValue(runResult);
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare, run, bind } as unknown as D1Database & {
    run: typeof run;
    bind: typeof bind;
  };
}

describe('recordTripEvent (#2283)', () => {
  it('db가 undefined일 때 no-op (graceful)', async () => {
    await expect(
      recordTripEvent(undefined, { tokenHash: 'abc', kind: 'sync-received' }),
    ).resolves.toBeUndefined();
  });

  it('db가 있을 때 trip_events INSERT를 실행한다', async () => {
    const db = makeMockDb();
    await recordTripEvent(
      db,
      { tokenHash: 'hash1', kind: 'sync-received', station: '강남', line: '2호선' },
      1000,
    );

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO trip_events'));
  });

  it('station/line/meta가 없을 때 null로 bind한다', async () => {
    const bind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    await recordTripEvent(db, { tokenHash: 'hash2', kind: 'trip-end' }, 2000);

    expect(bind).toHaveBeenCalledWith('hash2', 2000, 'trip-end', null, null, null);
  });

  it('meta가 있으면 JSON 직렬화해 bind한다', async () => {
    const bind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    await recordTripEvent(
      db,
      { tokenHash: 'hash3', kind: 'advance', meta: { shiftedCount: 2 } },
      3000,
    );

    expect(bind).toHaveBeenCalledWith(
      'hash3',
      3000,
      'advance',
      null,
      null,
      JSON.stringify({ shiftedCount: 2 }),
    );
  });

  it('now 미지정 시 Date.now()를 사용한다', async () => {
    const bind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;
    vi.useFakeTimers();
    vi.setSystemTime(5000);

    await recordTripEvent(db, { tokenHash: 'hash4', kind: 'hydrate-issued' });

    expect(bind).toHaveBeenCalledWith('hash4', 5000, 'hydrate-issued', null, null, null);
    vi.useRealTimers();
  });

  it('D1 write 실패 시 throw 없이 swallow한다', async () => {
    const run = vi.fn().mockRejectedValue(new Error('D1 write error'));
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    await expect(
      recordTripEvent(db, { tokenHash: 'hash5', kind: 'sync-received' }),
    ).resolves.toBeUndefined();
  });
});

describe('cleanupTripEvents (#2283)', () => {
  it('db가 undefined일 때 0을 반환한다 (graceful)', async () => {
    await expect(cleanupTripEvents(undefined)).resolves.toBe(0);
  });

  it('보존 기간 초과 cutoff로 DELETE를 실행하고 삭제된 행 수를 반환한다', async () => {
    const bind = vi.fn().mockReturnValue({
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 3 } }),
    });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    const now = 10_000_000;
    const deleted = await cleanupTripEvents(db, now);

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM trip_events'));
    expect(bind).toHaveBeenCalledWith(now - TRIP_EVENT_RETENTION_MS);
    expect(deleted).toBe(3);
  });

  it('meta.changes가 없으면 0을 반환한다', async () => {
    const bind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    const deleted = await cleanupTripEvents(db, 1000);
    expect(deleted).toBe(0);
  });

  it('D1 delete 실패 시 throw 없이 0을 반환한다', async () => {
    const run = vi.fn().mockRejectedValue(new Error('D1 delete error'));
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    await expect(cleanupTripEvents(db, 1000)).resolves.toBe(0);
  });
});
