/**
 * #3357 항목 3 — leg-2 누락 감시 배선: 일일 스캔(옵션 A)이 X14를 집계 1건 emit하고, 런북(옵션 B)이 같은 술어를 쓴다.
 * 입력은 tripLeg2PromptWatch.test.ts 와 같은 D1 실측 fixture.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildLeg2WatchCheckQuery,
  formatLeg2WatchReport,
  parseLeg2WatchCheckResponse,
} from '../checkTripMetricsRegression';
import { _resetSentryForTest, sentryInit } from '../sentry';
import { maybeRunTripMetricsRegressionScan } from '../tripMetricsRegressionScan';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

const captureMessageMock = vi.fn();
vi.mock('@sentry/cloudflare', () => ({
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

const rows = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'watch_20261112_leg2_prompt_missing', 'events.json'), 'utf-8'),
) as unknown[];
const SCAN_NOW = Date.UTC(2026, 10, 13, 0, 10); // 11/13 00:10Z

/** SQL 종류별로 다른 결과를 돌려주는 mock D1 — leg-2 조회(kind IN 'hop-end-prompt')에만 fixture 행을 준다. */
function makeEnv(): Env {
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockReturnValue({
      all: vi.fn().mockResolvedValue({ results: sql.includes("'hop-end-prompt'") ? rows : [] }),
    }),
  }));
  return { TRIPS: new InMemoryKV() as unknown as Env['TRIPS'], DB: { prepare } as unknown as D1Database } as unknown as Env;
}

describe('maybeRunTripMetricsRegressionScan — leg-2 누락 (#3357)', () => {
  beforeEach(() => {
    captureMessageMock.mockClear();
    _resetSentryForTest();
    sentryInit({ SENTRY_DSN: 'https://x@x.ingest.sentry.io/1' } as unknown as Env);
  });

  it('★11/12 b00dd879 실측 D1 행 -> leg2Misses 1건 + X14 captureXEvent 정확히 1회(count 1)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await maybeRunTripMetricsRegressionScan(makeEnv(), SCAN_NOW);
    expect(result.ran).toBe(true);
    expect(result.leg2Misses?.map((m) => m.station)).toEqual(['건대입구']);
    const x14 = captureMessageMock.mock.calls.filter(([msg]) => String(msg).includes('X14-leg2-prompt-missing'));
    expect(x14).toHaveLength(1);
    expect(JSON.stringify(x14[0])).toContain('"count":1');
    consoleErrorSpy.mockRestore();
  });

  it('누락 0건이면 X14를 emit하지 않는다', async () => {
    const env = makeEnv();
    (env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare.mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) }),
    }));
    const result = await maybeRunTripMetricsRegressionScan(env, SCAN_NOW);
    expect(result.leg2Misses).toEqual([]);
    expect(captureMessageMock.mock.calls.filter(([msg]) => String(msg).includes('X14'))).toEqual([]);
  });
});

describe('런북(옵션 B) leg-2 누락 (#3357)', () => {
  const stdout = JSON.stringify([{ results: rows, success: true }]);

  it('쿼리는 리터럴 window 하한을 쓰고 응답 파싱은 같은 술어로 1건을 낸다', () => {
    expect(buildLeg2WatchCheckQuery(1234)).toContain('ts > 1234 - ');
    const found = parseLeg2WatchCheckResponse(stdout, SCAN_NOW, SCAN_NOW - 7 * 24 * 3600_000);
    expect(found.map((m) => m.station)).toEqual(['건대입구']);
  });

  it('리포트: 0건은 정상, 있으면 토큰해시·역·노선·이벤트 id를 싣는다', () => {
    expect(formatLeg2WatchReport([], SCAN_NOW)).toContain('누락 없음 — 정상.');
    const found = parseLeg2WatchCheckResponse(stdout, SCAN_NOW, 0);
    const report = formatLeg2WatchReport(found, SCAN_NOW);
    expect(report).toContain('tokenHash=b00dd879 건대입구(2호선)');
    expect(report).toContain('events=2420');
  });

  it('리포트: 환승 전 노선이 없으면 ?로 표기한다', () => {
    const report = formatLeg2WatchReport([{ tokenHash: 'abcd1234', station: '군자(능동)', transferLine: null, transferAt: 0, eventIds: [1] }], SCAN_NOW);
    expect(report).toContain('군자(능동)(?호선)');
  });
});
