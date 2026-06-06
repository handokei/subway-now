/**
 * recallAlerts.ts — graceful no-op 가드, SQL API fetch, dedup, webhook 발사 회귀.
 *
 * fetchImpl/now를 deps로 주입해 외부 호출 없이 평가 흐름 전체를 결정적으로 검증한다.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ALERT_DEDUP_KEY,
  ALERT_DEDUP_WINDOW_MS,
  SQL_API_URL_TEMPLATE,
  evaluateAndMaybeAlert,
} from '../recallAlerts';
import { MIN_RECALL_RATIO_THRESHOLD } from '../metrics';
import { lowRecallTripRatioQuery } from '../recallQueries';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

const NOW = 1_700_000_000_000;

/** Minimal AnalyticsEngineWriter stub — 본 테스트는 write 호출 안 함, 단지 binding 존재 신호. */
const TELEMETRY = { writeDataPoint: () => undefined };

interface BuildEnvOptions {
  withTelemetry?: boolean;
  webhookUrl?: string;
  accountId?: string;
  apiToken?: string;
}

function buildEnv(kv: InMemoryKV, overrides: BuildEnvOptions = {}): Env {
  const {
    withTelemetry = true,
    webhookUrl = 'https://hooks.slack.test/xyz',
    accountId = 'acct-123',
    apiToken = 'token-abc',
  } = overrides;
  return {
    TRIPS: kv as unknown as KVNamespace,
    TELEMETRY: withTelemetry ? TELEMETRY : undefined,
    APNS_HOST: 'p',
    APNS_HOST_SANDBOX: 's',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
    RECALL_ALERT_WEBHOOK_URL: webhookUrl,
    CF_ACCOUNT_ID: accountId,
    CF_API_TOKEN: apiToken,
  };
}

/** AE SQL API 응답 stub — `data[0]`에 row 1개 또는 빈 배열. */
function sqlApiResponse(row: {
  totalTokens?: number;
  lowRecallTokens?: number;
  lowRecallRatio?: number;
} | null): Response {
  const data =
    row === null
      ? []
      : [
          {
            total_tokens: row.totalTokens,
            low_recall_tokens: row.lowRecallTokens,
            low_recall_ratio: row.lowRecallRatio,
          },
        ];
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okResponse(): Response {
  return new Response('ok', { status: 200 });
}

describe('evaluateAndMaybeAlert — graceful no-op', () => {
  it('TELEMETRY binding 부재 시 fetch 호출 없이 no-op', async () => {
    const kv = new InMemoryKV();
    const env = buildEnv(kv, { withTelemetry: false });
    const fetchImpl = vi.fn();
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(result).toEqual({ kind: 'noop', reason: 'binding-missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('RECALL_ALERT_WEBHOOK_URL 미설정 시 no-op', async () => {
    const env = buildEnv(new InMemoryKV(), { webhookUrl: '' });
    const fetchImpl = vi.fn();
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(result).toEqual({ kind: 'noop', reason: 'webhook-missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('CF_ACCOUNT_ID 미설정 시 no-op', async () => {
    const env = buildEnv(new InMemoryKV(), { accountId: '' });
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(result).toEqual({ kind: 'noop', reason: 'account-missing' });
  });

  it('CF_API_TOKEN 미설정 시 no-op', async () => {
    const env = buildEnv(new InMemoryKV(), { apiToken: '' });
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(result).toEqual({ kind: 'noop', reason: 'token-missing' });
  });
});

describe('evaluateAndMaybeAlert — breach 발사', () => {
  it('ratio > 0 → webhook POST + dedup stamp 갱신', async () => {
    const kv = new InMemoryKV();
    const env = buildEnv(kv);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        sqlApiResponse({ totalTokens: 100, lowRecallTokens: 10, lowRecallRatio: 0.1 }),
      )
      .mockResolvedValueOnce(okResponse());
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(result.kind).toBe('fired');
    if (result.kind !== 'fired') throw new Error('unreachable');
    expect(result.payload).toMatchObject({
      kind: 'low-recall',
      ratio: 0.1,
      threshold: MIN_RECALL_RATIO_THRESHOLD,
      sampleSize: 100,
      observedAt: NOW,
    });
    expect(result.payload.text).toContain('10.0%');
    expect(result.payload.text).toContain('sample=100');

    // SQL API call shape 검증.
    const [sqlUrl, sqlInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(sqlUrl).toBe(SQL_API_URL_TEMPLATE('acct-123'));
    expect(sqlInit.method).toBe('POST');
    expect(sqlInit.body).toBe(lowRecallTripRatioQuery);
    expect((sqlInit.headers as Record<string, string>).Authorization).toBe('Bearer token-abc');

    // Webhook call shape 검증.
    const [webhookUrl, webhookInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(webhookUrl).toBe('https://hooks.slack.test/xyz');
    expect(webhookInit.method).toBe('POST');
    const sentPayload = JSON.parse(webhookInit.body as string);
    expect(sentPayload.kind).toBe('low-recall');
    expect(sentPayload.ratio).toBe(0.1);

    // Dedup stamp 기록되어야 함.
    expect(await kv.get(ALERT_DEDUP_KEY)).toBe(String(NOW));
  });

  it('ratio === 0 → no-breach no-op (webhook 미호출)', async () => {
    const env = buildEnv(new InMemoryKV());
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        sqlApiResponse({ totalTokens: 100, lowRecallTokens: 0, lowRecallRatio: 0 }),
      );
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(result).toEqual({ kind: 'noop', reason: 'no-breach' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sample=0 → no-breach no-op (분모 0 spurious 차단)', async () => {
    const env = buildEnv(new InMemoryKV());
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        sqlApiResponse({ totalTokens: 0, lowRecallTokens: 0, lowRecallRatio: 0.5 }),
      );
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(result).toEqual({ kind: 'noop', reason: 'no-breach' });
  });

  it('SQL API row 비어있음 → no-op (fetch-failed로 정규화)', async () => {
    // AE SQL API가 빈 data array 반환 — 7d 윈도우에 trip 데이터 없을 때 발생 가능.
    // 우리 SQL은 outer SELECT가 항상 1 row 보장 — 빈 결과는 비정상 신호로 다음 tick 재시도.
    const env = buildEnv(new InMemoryKV());
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(sqlApiResponse(null));
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(result).toEqual({ kind: 'noop', reason: 'fetch-failed' });
  });
});

describe('evaluateAndMaybeAlert — dedup', () => {
  it('dedup 윈도우 내면 SQL/webhook 호출 없이 noop', async () => {
    const kv = new InMemoryKV();
    await kv.put(ALERT_DEDUP_KEY, String(NOW - 60_000)); // 1분 전 발사됨
    const env = buildEnv(kv);
    const fetchImpl = vi.fn();
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(result).toEqual({ kind: 'noop', reason: 'dedup' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('dedup 윈도우 경과 후엔 평가 재개', async () => {
    const kv = new InMemoryKV();
    await kv.put(ALERT_DEDUP_KEY, String(NOW - ALERT_DEDUP_WINDOW_MS - 1));
    const env = buildEnv(kv);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        sqlApiResponse({ totalTokens: 50, lowRecallTokens: 5, lowRecallRatio: 0.1 }),
      )
      .mockResolvedValueOnce(okResponse());
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(result.kind).toBe('fired');
  });

  it('corrupt dedup stamp(non-numeric)는 null로 정규화 — 평가 진행', async () => {
    const kv = new InMemoryKV();
    await kv.put(ALERT_DEDUP_KEY, 'garbage');
    const env = buildEnv(kv);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        sqlApiResponse({ totalTokens: 10, lowRecallTokens: 1, lowRecallRatio: 0.1 }),
      )
      .mockResolvedValueOnce(okResponse());
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(result.kind).toBe('fired');
  });
});

describe('evaluateAndMaybeAlert — fail-soft', () => {
  it('SQL API non-ok → noop (cron 흐름 차단 안 함)', async () => {
    const env = buildEnv(new InMemoryKV());
    const log = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('err', { status: 500 }));
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      log,
    });
    expect(result).toEqual({ kind: 'noop', reason: 'fetch-failed' });
    expect(log).toHaveBeenCalledWith('recall-alert: SQL API non-ok', { status: 500 });
  });

  it('SQL API throw → noop + log', async () => {
    const env = buildEnv(new InMemoryKV());
    const log = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'));
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      log,
    });
    expect(result).toEqual({ kind: 'noop', reason: 'fetch-failed' });
    expect(log).toHaveBeenCalledWith('recall-alert: SQL API fetch threw', {
      error: 'Error: network down',
    });
  });

  it('webhook non-ok → noop + dedup stamp 미갱신 (다음 tick 재시도 가능)', async () => {
    const kv = new InMemoryKV();
    const env = buildEnv(kv);
    const log = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        sqlApiResponse({ totalTokens: 100, lowRecallTokens: 10, lowRecallRatio: 0.1 }),
      )
      .mockResolvedValueOnce(new Response('err', { status: 503 }));
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      log,
    });
    expect(result).toEqual({ kind: 'noop', reason: 'webhook-failed' });
    expect(await kv.get(ALERT_DEDUP_KEY)).toBeNull();
    expect(log).toHaveBeenCalledWith('recall-alert: webhook non-ok', { status: 503 });
  });

  it('webhook throw → noop + log + dedup 미갱신', async () => {
    const kv = new InMemoryKV();
    const env = buildEnv(kv);
    const log = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        sqlApiResponse({ totalTokens: 100, lowRecallTokens: 10, lowRecallRatio: 0.1 }),
      )
      .mockRejectedValueOnce(new Error('connection refused'));
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      log,
    });
    expect(result).toEqual({ kind: 'noop', reason: 'webhook-failed' });
    expect(await kv.get(ALERT_DEDUP_KEY)).toBeNull();
    expect(log).toHaveBeenCalledWith('recall-alert: webhook fetch threw', {
      error: 'Error: connection refused',
    });
  });

  it('log 미주입 시 silent fail (default noop logger)', async () => {
    const env = buildEnv(new InMemoryKV());
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('x'));
    const result = await evaluateAndMaybeAlert(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(result).toEqual({ kind: 'noop', reason: 'fetch-failed' });
  });
});
