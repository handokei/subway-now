import { describe, expect, it, vi } from 'vitest';
import { computePushFailureMetrics, EMPTY_PUSH_FAILURE_METRICS, logPushFailure } from '../pushFailureLog';
import { captureXEvent } from '../sentry';

vi.mock('../sentry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sentry')>();
  return { ...actual, captureXEvent: vi.fn() };
});

const NOW = 1_700_000_000_000;

/**
 * logPushFailure 내부에서 prepare()가 SQL 종류(SELECT rate-limit 확인 / INSERT)별로 다르게
 * 호출되므로, SQL 문자열로 분기해 각기 다른 stub을 반환하는 mock DB를 만든다.
 *
 * @param recentExists - rate-limit SELECT가 "최근 기록 있음"을 반환할지 여부.
 */
function makeDb(options: {
  recentExists?: boolean;
  selectThrows?: boolean;
  insertThrows?: boolean;
} = {}): {
  db: D1Database;
  insertBind: ReturnType<typeof vi.fn>;
  selectBind: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
} {
  const { recentExists = false, selectThrows = false, insertThrows = false } = options;

  const run = insertThrows
    ? vi.fn().mockRejectedValue(new Error('D1 write error'))
    : vi.fn().mockResolvedValue({ success: true });
  const insertBind = vi.fn().mockReturnValue({ run });

  const first = selectThrows
    ? vi.fn().mockRejectedValue(new Error('D1 read error'))
    : vi.fn().mockResolvedValue(recentExists ? { 1: 1 } : null);
  const selectBind = vi.fn().mockReturnValue({ first });

  const prepare = vi.fn().mockImplementation((sql: string) => {
    if (sql.startsWith('SELECT')) return { bind: selectBind };
    return { bind: insertBind };
  });

  return { db: { prepare } as unknown as D1Database, insertBind, selectBind, run };
}

describe('logPushFailure (#2177)', () => {
  it('db가 undefined일 때 no-op (graceful)', async () => {
    await expect(
      logPushFailure(undefined, {
        token: 'tok-1',
        pushKind: 'destination',
        apnsStatus: 410,
      }),
    ).resolves.toBeUndefined();
  });

  it('db가 있을 때 push_failures INSERT를 실행한다', async () => {
    const { db, insertBind } = makeDb();
    await logPushFailure(db, {
      token: 'tok-1',
      pushKind: 'destination',
      apnsStatus: 410,
      apnsReason: 'Unregistered',
      apnsEnv: 'production',
    });
    expect(insertBind).toHaveBeenCalled();
  });

  it('tripToken 미제공 시 token hash를 trip_token_hash에도 재사용한다', async () => {
    const { db, insertBind } = makeDb();

    await logPushFailure(db, {
      token: 'same-token',
      pushKind: 'transfer',
      apnsStatus: 400,
      apnsReason: 'BadDeviceToken',
    });

    // bind 순서: ts, tokenHash, tripTokenHash, pushKind, status, reason, env, envMismatchExhausted
    const captured = insertBind.mock.calls[0];
    expect(captured[1]).toBe(captured[2]);
  });

  it('tripToken 제공 시 별도 hash를 사용한다', async () => {
    const { db, insertBind } = makeDb();

    await logPushFailure(db, {
      token: 'device-token',
      tripToken: 'different-trip-token',
      pushKind: 'intermediate',
      apnsStatus: 500,
    });

    const captured = insertBind.mock.calls[0];
    expect(captured[1]).not.toBe(captured[2]);
  });

  it('envMismatchExhausted=true → 1로 저장된다', async () => {
    const { db, insertBind } = makeDb();

    await logPushFailure(db, {
      token: 'tok',
      pushKind: 'destination',
      apnsStatus: 400,
      apnsReason: 'BadDeviceToken',
      envMismatchExhausted: true,
    });

    const captured = insertBind.mock.calls[0];
    expect(captured[captured.length - 1]).toBe(1);
  });

  it('envMismatchExhausted 미제공 시 0으로 저장된다', async () => {
    const { db, insertBind } = makeDb();

    await logPushFailure(db, {
      token: 'tok',
      pushKind: 'destination',
      apnsStatus: 429,
    });

    const captured = insertBind.mock.calls[0];
    expect(captured[captured.length - 1]).toBe(0);
  });

  it('D1 write 실패 시 throw 없이 swallow한다', async () => {
    const { db: dbFail } = makeDb({ insertThrows: true });

    await expect(
      logPushFailure(dbFail, { token: 'tok', pushKind: 'destination', apnsStatus: 500 }),
    ).resolves.toBeUndefined();
  });

  it('D1 write 실패 시 무음이 아니라 captureXEvent로 관측 승격된다 (#2227)', async () => {
    const { db: dbFail } = makeDb({ insertThrows: true });

    await logPushFailure(dbFail, { token: 'tok', pushKind: 'destination', apnsStatus: 500 });

    expect(captureXEvent).toHaveBeenCalledWith(
      'D1-write-failure',
      expect.objectContaining({ table: 'push_failures' }),
    );
  });

  describe('rate-limit 가드 (#2177 리뷰 P1)', () => {
    it('같은 (tokenHash, pushKind) 실패가 윈도우 내 이미 있으면 INSERT를 skip한다', async () => {
      const { db, insertBind } = makeDb({ recentExists: true });

      await logPushFailure(db, { token: 'tok', pushKind: 'boarding-prompt', apnsStatus: 500 });

      expect(insertBind).not.toHaveBeenCalled();
    });

    it('같은 (tokenHash, pushKind) 실패 2연속 호출 → 두 번째는 skip되어 INSERT 1회만 발생한다', async () => {
      const run = vi.fn().mockResolvedValue({ success: true });
      const insertBind = vi.fn().mockReturnValue({ run });

      // 첫 호출: 아직 기록 없음 → insert 발생. 이후 SELECT는 "방금 기록됨"을 반환하도록 갱신.
      let recentExists = false;
      const first = vi.fn().mockImplementation(async () => (recentExists ? { 1: 1 } : null));
      const selectBind = vi.fn().mockReturnValue({ first });

      const prepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.startsWith('SELECT')) return { bind: selectBind };
        return { bind: insertBind };
      });
      const db = { prepare } as unknown as D1Database;

      await logPushFailure(db, { token: 'tok', pushKind: 'reschedule', apnsStatus: 503 });
      recentExists = true;
      await logPushFailure(db, { token: 'tok', pushKind: 'reschedule', apnsStatus: 503 });

      expect(insertBind).toHaveBeenCalledTimes(1);
    });

    it('rate-limit 윈도우 경과 후 재호출하면 다시 INSERT한다', async () => {
      const { db, insertBind } = makeDb({ recentExists: false });

      await logPushFailure(db, { token: 'tok', pushKind: 'destination', apnsStatus: 500 });
      await logPushFailure(db, { token: 'tok', pushKind: 'destination', apnsStatus: 500 });

      expect(insertBind).toHaveBeenCalledTimes(2);
    });

    it('다른 pushKind는 rate-limit 대상에서 제외된다 (SELECT 조건에 push_kind 포함)', async () => {
      const { db, selectBind } = makeDb();

      await logPushFailure(db, { token: 'tok', pushKind: 'transfer', apnsStatus: 500 });

      expect(selectBind).toHaveBeenCalledWith(expect.any(String), 'transfer', expect.any(Number));
    });

    it('rate-limit SELECT 실패 시 throw 없이 swallow한다(insert도 skip)', async () => {
      const { db, insertBind } = makeDb({ selectThrows: true });

      await expect(
        logPushFailure(db, { token: 'tok', pushKind: 'destination', apnsStatus: 500 }),
      ).resolves.toBeUndefined();
      expect(insertBind).not.toHaveBeenCalled();
    });
  });
});

describe('computePushFailureMetrics (#2177)', () => {
  it('db가 undefined일 때 zero 기본값을 반환한다', async () => {
    const result = await computePushFailureMetrics(undefined, NOW);
    expect(result).toEqual(EMPTY_PUSH_FAILURE_METRICS);
  });

  it('total24h + topReasons를 집계한다', async () => {
    const first = vi.fn().mockResolvedValue({ count: 7 });
    const all = vi.fn().mockResolvedValue({
      results: [
        { status: 410, reason: 'Unregistered', count: 5 },
        { status: 400, reason: 'BadDeviceToken', count: 2 },
      ],
    });
    const bind = vi.fn().mockReturnValue({ first, all });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    const result = await computePushFailureMetrics(db, NOW);

    expect(result.total24h).toBe(7);
    expect(result.topReasons).toEqual([
      { reason: '410:Unregistered', count: 5 },
      { reason: '400:BadDeviceToken', count: 2 },
    ]);
  });

  it('apns_reason이 null이면 unknown으로 표기한다', async () => {
    const first = vi.fn().mockResolvedValue({ count: 1 });
    const all = vi.fn().mockResolvedValue({
      results: [{ status: 429, reason: null, count: 1 }],
    });
    const bind = vi.fn().mockReturnValue({ first, all });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    const result = await computePushFailureMetrics(db, NOW);
    expect(result.topReasons).toEqual([{ reason: '429:unknown', count: 1 }]);
  });

  it('first가 null을 반환하면 total24h=0', async () => {
    const first = vi.fn().mockResolvedValue(null);
    const all = vi.fn().mockResolvedValue({ results: [] });
    const bind = vi.fn().mockReturnValue({ first, all });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    const result = await computePushFailureMetrics(db, NOW);
    expect(result.total24h).toBe(0);
    expect(result.topReasons).toEqual([]);
  });

  it('D1 read 실패 시 throw 없이 zero 기본값을 반환한다', async () => {
    const bind = vi.fn().mockReturnValue({
      first: vi.fn().mockRejectedValue(new Error('D1 read error')),
      all: vi.fn().mockResolvedValue({ results: [] }),
    });
    const prepare = vi.fn().mockReturnValue({ bind });
    const dbFail = { prepare } as unknown as D1Database;

    const result = await computePushFailureMetrics(dbFail, NOW);
    expect(result).toEqual(EMPTY_PUSH_FAILURE_METRICS);
  });
});
