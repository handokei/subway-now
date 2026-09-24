import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import { _resetSentryForTest, sentryInit } from '../sentry';
import type { Env } from '../types';

const captureMessageMock = vi.fn();
const captureExceptionMock = vi.fn();
vi.mock('@sentry/cloudflare', () => ({
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  addBreadcrumb: vi.fn(),
}));

/**
 * #2795 코드리뷰(PR #2797) 반영 — TDD rework.
 *
 * F1: window 비교를 started_at → ended_at으로(어제 시작해 오늘 끝난 장기 trip 포착).
 * F2: 트립별 Sentry event → 집계 1건(count/windowStartMs/sample).
 * F4: 내부 catch를 console.warn → captureBackendException으로 승격, index.ts 바깥
 *     try/catch는 제거(이 파일 테스트 대상은 아니지만 D1 실패 시 captureException 호출로
 *     간접 검증).
 * F6: KV 마커 claim을 read-check 직후(스캔 전)로 이동 — race 방지.
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

  it('F1 — window 비교가 started_at이 아니라 ended_at 기준이다(어제 시작해 오늘 끝난 장기 trip도 포착)', async () => {
    const captured: string[] = [];
    const prepare = vi.fn().mockImplementation((sql: string) => {
      captured.push(sql);
      return { bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) }) };
    });
    const db = { prepare } as unknown as D1Database;
    await findTripMetricsRegressions(db, NOW);
    expect(captured[0]).toMatch(/ended_at\s*>\s*\?/);
    expect(captured[0]).not.toMatch(/started_at\s*>\s*\?/);
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
    captureExceptionMock.mockClear();
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

  it('회귀 트립이 0건이면 무경보 — ran=true, regressions=[], captureXEvent 미호출', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv([], kv);
    const result = await maybeRunTripMetricsRegressionScan(env, NOW);
    expect(result.ran).toBe(true);
    expect(result.regressions).toEqual([]);
    expect(captureMessageMock).not.toHaveBeenCalled();
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
    const kv = new InMemoryKV();
    const env = makeEnv([], kv);
    const result = await maybeRunTripMetricsRegressionScan(env, NOW);
    expect(result.regressions).toEqual([]);
  });

  it('F2 — 회귀 트립 N건 발견 시 captureXEvent가 정확히 1회 호출되고 payload.count===N이다(폭주 방지)', async () => {
    sentryInit({ SENTRY_DSN: 'https://x@x.ingest.sentry.io/1' } as unknown as Env);

    const rows = [1, 2, 3].map((i) => ({
      trip_token_hash: `hash000${i}`,
      started_at: NOW - i * 60_000,
      origin_station: '중곡',
      destination_station: '성수',
      lock_attached: 1,
      boarding_prompt_responded: 0,
      fired_count: 0,
      end_reason: 'destination-arrived',
    }));
    const kv = new InMemoryKV();
    const env = makeEnv(rows, kv);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await maybeRunTripMetricsRegressionScan(env, NOW);
    expect(result.ran).toBe(true);
    expect(result.regressions).toHaveLength(3);

    // 경보 채널 1: Sentry captureXEvent — 트립별 아니라 집계 1건.
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [name, options] = captureMessageMock.mock.calls[0];
    expect(name).toBe('X12-trip-metrics-fired-zero');
    expect(options.extra.count).toBe(3);
    expect(options.extra.windowStartMs).toBe(NOW - 24 * 60 * 60 * 1000);
    expect(typeof options.extra.sampleJson).toBe('string');
    expect(JSON.parse(options.extra.sampleJson)).toHaveLength(3);

    // 경보 채널 2: console.error — 요약 1줄(트립별 아님).
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('"count":3'));
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

  it('F6 — KV 마커 claim이 D1 스캔보다 먼저 일어난다(race 방지, 같은 분 중복 cron invocation 대비)', async () => {
    const callOrder: string[] = [];
    const kv = new InMemoryKV();
    const originalPut = kv.put.bind(kv);
    vi.spyOn(kv, 'put').mockImplementation(async (...args: Parameters<typeof kv.put>) => {
      callOrder.push('kv.put');
      return originalPut(...args);
    });

    const rows = [
      {
        trip_token_hash: 'race0001',
        started_at: NOW - 60_000,
        origin_station: null,
        destination_station: null,
        lock_attached: 1,
        boarding_prompt_responded: 0,
        fired_count: 0,
        end_reason: 'destination-arrived',
      },
    ];
    const db = makeMockDb(rows);
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((...args: Parameters<typeof db.prepare>) => {
      callOrder.push('db.prepare');
      return originalPrepare(...args);
    });

    const env = { TRIPS: kv as unknown as Env['TRIPS'], DB: db } as unknown as Env;
    await maybeRunTripMetricsRegressionScan(env, NOW);

    expect(callOrder[0]).toBe('kv.put');
    expect(callOrder).toContain('db.prepare');
    expect(callOrder.indexOf('kv.put')).toBeLessThan(callOrder.indexOf('db.prepare'));
  });

  it('F4 — D1 조회 실패는 swallow하고 ran=false를 반환하며 captureBackendException 경유로 Sentry captureException을 호출한다(console.warn만이 아님)', async () => {
    sentryInit({ SENTRY_DSN: 'https://x@x.ingest.sentry.io/1' } as unknown as Env);
    const kv = new InMemoryKV();
    const env = {
      TRIPS: kv as unknown as Env['TRIPS'],
      DB: makeMockDb([], { throws: true }),
    } as unknown as Env;
    const result = await maybeRunTripMetricsRegressionScan(env, NOW);
    expect(result).toEqual({ ran: false });
    // 회귀 alert(captureMessage)는 호출되지 않지만, 실패 자체는 captureException으로 승격된다.
    expect(captureMessageMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('스캔 시각 상수가 boardingPromptCounterAccumulate(00:05)와 겹치지 않는다', () => {
    expect(REGRESSION_SCAN_HOUR_UTC).toBe(0);
    expect(REGRESSION_SCAN_MINUTE_UTC).toBe(10);
  });
});
