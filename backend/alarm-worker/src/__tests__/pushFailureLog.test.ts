import { describe, expect, it, vi } from 'vitest';
import { computePushFailureMetrics, EMPTY_PUSH_FAILURE_METRICS, logPushFailure } from '../pushFailureLog';

const NOW = 1_700_000_000_000;

function makeWriteDb(): { db: D1Database; prepare: ReturnType<typeof vi.fn> } {
  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { db: { prepare } as unknown as D1Database, prepare };
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
    const { db, prepare } = makeWriteDb();
    await logPushFailure(db, {
      token: 'tok-1',
      pushKind: 'destination',
      apnsStatus: 410,
      apnsReason: 'Unregistered',
      apnsEnv: 'production',
    });
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO push_failures'));
  });

  it('tripToken 미제공 시 token hash를 trip_token_hash에도 재사용한다', async () => {
    let captured: unknown[] = [];
    const run = vi.fn().mockResolvedValue({ success: true });
    const bind = vi.fn().mockImplementation((...args: unknown[]) => {
      captured = args;
      return { run };
    });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    await logPushFailure(db, {
      token: 'same-token',
      pushKind: 'transfer',
      apnsStatus: 400,
      apnsReason: 'BadDeviceToken',
    });

    // bind 순서: ts, tokenHash, tripTokenHash, pushKind, status, reason, env, envMismatchExhausted
    expect(captured[1]).toBe(captured[2]);
  });

  it('tripToken 제공 시 별도 hash를 사용한다', async () => {
    let captured: unknown[] = [];
    const run = vi.fn().mockResolvedValue({ success: true });
    const bind = vi.fn().mockImplementation((...args: unknown[]) => {
      captured = args;
      return { run };
    });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    await logPushFailure(db, {
      token: 'device-token',
      tripToken: 'different-trip-token',
      pushKind: 'intermediate',
      apnsStatus: 500,
    });

    expect(captured[1]).not.toBe(captured[2]);
  });

  it('envMismatchExhausted=true → 1로 저장된다', async () => {
    let captured: unknown[] = [];
    const run = vi.fn().mockResolvedValue({ success: true });
    const bind = vi.fn().mockImplementation((...args: unknown[]) => {
      captured = args;
      return { run };
    });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    await logPushFailure(db, {
      token: 'tok',
      pushKind: 'destination',
      apnsStatus: 400,
      apnsReason: 'BadDeviceToken',
      envMismatchExhausted: true,
    });

    expect(captured[captured.length - 1]).toBe(1);
  });

  it('envMismatchExhausted 미제공 시 0으로 저장된다', async () => {
    let captured: unknown[] = [];
    const run = vi.fn().mockResolvedValue({ success: true });
    const bind = vi.fn().mockImplementation((...args: unknown[]) => {
      captured = args;
      return { run };
    });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    await logPushFailure(db, {
      token: 'tok',
      pushKind: 'destination',
      apnsStatus: 429,
    });

    expect(captured[captured.length - 1]).toBe(0);
  });

  it('D1 write 실패 시 throw 없이 swallow한다', async () => {
    const run = vi.fn().mockRejectedValue(new Error('D1 write error'));
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const dbFail = { prepare } as unknown as D1Database;

    await expect(
      logPushFailure(dbFail, { token: 'tok', pushKind: 'destination', apnsStatus: 500 }),
    ).resolves.toBeUndefined();
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
