import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import { _resetSentryForTest, sentryInit } from '../sentry';
import type { Env } from '../types';

const captureMessageMock = vi.fn();
vi.mock('@sentry/cloudflare', () => ({
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

/**
 * red — #2795 회귀 자동 감시. 이슈 본문 + 2026-09-24 결정 코멘트의 공통 SSoT 쿼리를
 * unit 레벨에서 스펙만 보고 작성한다(구현 코드 미확인).
 *
 * 공통 회귀 신호: ended_at IS NOT NULL AND (lock_attached=1 OR boarding_prompt_responded=1)
 * AND fired_count=0 AND started_at > now - 1day.
 */
import {
  findTripMetricsRegressions,
  maybeRunTripMetricsRegressionScan,
  REGRESSION_SCAN_HOUR_UTC,
  REGRESSION_SCAN_MINUTE_UTC,
} from '../tripMetricsRegressionScan';

/** SELECT만 흉내내는 최소 mock D1. rows를 그대로 반환한다. */
function makeMockDb(rows: Record<string, unknown>[], options: { throws?: boolean } = {}): D1Database {
  const prepare = vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnValue({
      all: options.throws
        ? vi.fn().mockRejectedValue(new Error('D1 select error'))
        : vi.fn().mockResolvedValue({ results: rows }),
    }),
  });
  return { prepare } as unknown as D1Database;
}

const NOW = Date.UTC(2026, 8, 24, 0, 10); // 2026-09-24T00:10Z

describe('findTripMetricsRegressions (#2795)', () => {
  it('회귀 후보(lock=1, fired=0, ended)를 반환한다 — 9/23 회귀 형태 backfill 검증', async () => {
    const db = makeMockDb([
      {
        trip_token_hash: 'abc12345',
        started_at: NOW - 3_600_000,
        origin_station: '용마산',
        destination_station: '중곡',
        lock_attached: 1,
        boarding_prompt_responded: 0,
        fired_count: 0,
        end_reason: 'destination-arrived',
      },
    ]);
    const result = await findTripMetricsRegressions(db, NOW);
    expect(result).toEqual([
      {
        tripTokenHash: 'abc12345',
        startedAt: NOW - 3_600_000,
        originStation: '용마산',
        destinationStation: '중곡',
        lockAttached: true,
        boardingPromptResponded: false,
      },
    ]);
  });

  it('boardingPromptResponded=1만 있어도(lock=0) 명시 의향으로 포함한다', async () => {
    const db = makeMockDb([
      {
        trip_token_hash: 'def67890',
        started_at: NOW - 1_000,
        origin_station: null,
        destination_station: null,
        lock_attached: 0,
        boarding_prompt_responded: 1,
        fired_count: 0,
        end_reason: 'user-delete',
      },
    ]);
    const result = await findTripMetricsRegressions(db, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].boardingPromptResponded).toBe(true);
  });

  it('window 하한(now - 1day)을 bind 인자로 전달한다', async () => {
    const bindSpy = vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) });
    const db = { prepare: vi.fn().mockReturnValue({ bind: bindSpy }) } as unknown as D1Database;
    await findTripMetricsRegressions(db, NOW);
    expect(bindSpy).toHaveBeenCalledWith(NOW - 24 * 60 * 60 * 1000);
  });

  it('SQL 쿼리 실패 시 throw한다(caller가 swallow 책임)', async () => {
    const db = makeMockDb([], { throws: true });
    await expect(findTripMetricsRegressions(db, NOW)).rejects.toThrow('D1 select error');
  });
});

describe('maybeRunTripMetricsRegressionScan (#2795)', () => {
  beforeEach(() => {
    _resetSentryForTest();
    captureMessageMock.mockClear();
  });

  function makeEnv(rows: Record<string, unknown>[], kv: InMemoryKV): Env {
    return {
      TRIPS: kv as unknown as Env['TRIPS'],
      DB: makeMockDb(rows),
    } as unknown as Env;
  }

  it('UTC 시각이 스캔 윈도우(00:10)가 아니면 스캔하지 않는다', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv([], kv);
    const result = await maybeRunTripMetricsRegressionScan(env, Date.UTC(2026, 8, 24, 1, 10));
    expect(result.ran).toBe(false);
  });

  it('UTC 분이 10이 아니면 스캔하지 않는다', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv([], kv);
    const result = await maybeRunTripMetricsRegressionScan(env, Date.UTC(2026, 8, 24, 0, 11));
    expect(result.ran).toBe(false);
  });

  it('env.DB 미바인딩 시 no-op(false)를 반환한다', async () => {
    const kv = new InMemoryKV();
    const env = { TRIPS: kv as unknown as Env['TRIPS'] } as unknown as Env;
    const result = await maybeRunTripMetricsRegressionScan(env, NOW);
    expect(result.ran).toBe(false);
  });

  it('회귀 트립이 0건이면 무경보 — ran=true, regressions=[]', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv([], kv);
    const result = await maybeRunTripMetricsRegressionScan(env, NOW);
    expect(result.ran).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  it('진행중(ended_at=null) 트립은 SQL WHERE 절에서 이미 제외된다 — 쿼리 텍스트 assert', async () => {
    const captured: string[] = [];
    const prepare = vi.fn().mockImplementation((sql: string) => {
      captured.push(sql);
      return { bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) }) };
    });
    const kv = new InMemoryKV();
    const env = { TRIPS: kv as unknown as Env['TRIPS'], DB: { prepare } as unknown as D1Database } as unknown as Env;
    await maybeRunTripMetricsRegressionScan(env, NOW);
    expect(captured[0]).toMatch(/ended_at IS NOT NULL/);
    expect(captured[0]).toMatch(/fired_count\s*=\s*0/);
    expect(captured[0]).toMatch(/lock_attached\s*=\s*1/);
    expect(captured[0]).toMatch(/boarding_prompt_responded\s*=\s*1/);
  });

  it('무의향(lock=0 && prompt_responded=0) 트립은 애초에 쿼리 결과에 없으므로 무경보', async () => {
    // findTripMetricsRegressions가 SQL WHERE로 이미 걸러내므로, mock db가 빈 결과를 반환하는
    // 케이스로 무의향 trip이 알람으로 이어지지 않음을 검증한다.
    const kv = new InMemoryKV();
    const env = makeEnv([], kv);
    const result = await maybeRunTripMetricsRegressionScan(env, NOW);
    expect(result.regressions).toEqual([]);
  });

  it('회귀 트립 발견 시 Sentry captureXEvent + console.error 경보를 emit한다', async () => {
    sentryInit({ SENTRY_DSN: 'https://x@x.ingest.sentry.io/1' } as unknown as Env);

    const kv = new InMemoryKV();
    const env = makeEnv(
      [
        {
          trip_token_hash: 'ffeeddcc',
          started_at: NOW - 60_000,
          origin_station: '중곡',
          destination_station: '성수',
          lock_attached: 1,
          boarding_prompt_responded: 0,
          fired_count: 0,
          end_reason: 'destination-arrived',
        },
      ],
      kv,
    );
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await maybeRunTripMetricsRegressionScan(env, NOW);
    expect(result.ran).toBe(true);
    expect(result.regressions).toHaveLength(1);
    // 경보 채널 1: Sentry captureXEvent (captureMessage 경유).
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [name, options] = captureMessageMock.mock.calls[0];
    expect(name).toBe('X12-trip-metrics-fired-zero');
    expect(options).toMatchObject({ extra: expect.objectContaining({ tripTokenHash: 'ffeeddcc' }) });
    // 경보 채널 2: console.error(구조화 로그).
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('trip_metrics regression'),
    );
    consoleErrorSpy.mockRestore();
  });

  it('같은 UTC 날짜에 두 번째 스캔은 재경보하지 않는다(idempotent, KV 게이트)', async () => {
    const kv = new InMemoryKV();
    const rows = [
      {
        trip_token_hash: 'aabbccdd',
        started_at: NOW - 60_000,
        origin_station: '용마산',
        destination_station: '중곡',
        lock_attached: 1,
        boarding_prompt_responded: 0,
        fired_count: 0,
        end_reason: 'destination-arrived',
      },
    ];
    const env = makeEnv(rows, kv);
    const first = await maybeRunTripMetricsRegressionScan(env, NOW);
    expect(first.ran).toBe(true);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = await maybeRunTripMetricsRegressionScan(env, NOW);
    expect(second.ran).toBe(false);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('D1 조회 실패는 swallow하고 ran=false를 반환한다(발사 경로와 독립 — throw하지 않음)', async () => {
    const kv = new InMemoryKV();
    const env = {
      TRIPS: kv as unknown as Env['TRIPS'],
      DB: makeMockDb([], { throws: true }),
    } as unknown as Env;
    await expect(maybeRunTripMetricsRegressionScan(env, NOW)).resolves.toEqual({ ran: false });
  });

  it('스캔 시각 상수가 boardingPromptCounterAccumulate(00:05)와 겹치지 않는다', () => {
    expect(REGRESSION_SCAN_HOUR_UTC).toBe(0);
    expect(REGRESSION_SCAN_MINUTE_UTC).toBe(10);
  });
});
